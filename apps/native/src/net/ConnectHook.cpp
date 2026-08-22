#include "net/ConnectHook.h"

#include <atomic>
#include <cstdio>
#include <mutex>
#include <utility>

#include <winsock2.h>
#include <ws2tcpip.h>

#include <Windows.h>

#include "core/ModuleImage.h"

namespace brownie::net {
namespace {

using ConnectFn = int(WSAAPI*)(SOCKET, const sockaddr*, int);

/// Process-wide, because `connect` is a C callback with nowhere to carry a
/// `this` — the same constraint as the overlay's detour, and the same rule:
/// one per process, and `Install` refuses a second.
ConnectFn g_original_connect = nullptr;
ConnectHookOptions g_options;
TargetReporter g_report;
std::mutex g_report_lock;
std::atomic<std::uint32_t> g_redirected{0};
std::atomic<std::uint32_t> g_seen{0};
std::atomic<std::uint16_t> g_last_other_port{0};
std::atomic<bool> g_installed{false};

/// Dotted quad, without `inet_ntoa`'s static buffer.
///
/// That buffer is shared by every thread in the process, so a game connecting
/// on two threads could hand the runtime a spliced address — a host nobody
/// dialled, arriving at the one place that decides where we connect.
[[nodiscard]] std::string Dotted(std::uint32_t address_be) {
    const auto* octet = reinterpret_cast<const std::uint8_t*>(&address_be);
    char text[16]{};
    std::snprintf(text, sizeof(text), "%u.%u.%u.%u", octet[0], octet[1], octet[2], octet[3]);
    return text;
}

/// Decides whether an address is one to redirect, and reports it if so.
[[nodiscard]] bool Redirect(const sockaddr* address, int length, sockaddr_in& out) {
    // Anything that is not an IPv4 address of the expected size is not ours to
    // touch. Passing it through untouched is what keeps the game's HTTPS, the
    // launcher's traffic and everything else working.
    if (address == nullptr || length < static_cast<int>(sizeof(sockaddr_in)) ||
        address->sa_family != AF_INET) {
        return false;
    }

    const auto* target = reinterpret_cast<const sockaddr_in*>(address);
    const std::uint16_t port = ::ntohs(target->sin_port);
    g_seen.fetch_add(1, std::memory_order_relaxed);

    if (port != g_options.game_port) {
        // Remembered so that "nothing was redirected" can be told apart from
        // "nothing was dialled" — see the header.
        g_last_other_port.store(port, std::memory_order_relaxed);
        return false;
    }

    // Already loopback — a reconnect the runtime rewrote, or our own redirect
    // coming back around. Redirecting it again would report the proxy as the
    // server and lose the real address.
    if (target->sin_addr.s_addr == ::htonl(INADDR_LOOPBACK)) {
        return false;
    }

    const std::string host = Dotted(target->sin_addr.s_addr);

    // The reporter is copied under the lock and called outside it: it sends on
    // the IPC pipe, and holding a lock across that would let a stalled pipe
    // stall the game's connect.
    TargetReporter report;
    {
        const std::lock_guard<std::mutex> guard{g_report_lock};
        report = g_report;
    }
    if (report) {
        report(host, port);
    }

    // A copy of the original with only the address changed: the port, and
    // anything else the caller set, stays as the game meant it.
    out = *target;
    out.sin_addr.s_addr = ::htonl(INADDR_LOOPBACK);
    g_redirected.fetch_add(1, std::memory_order_relaxed);
    return true;
}

int WSAAPI ConnectDetour(SOCKET socket, const sockaddr* address, int length) {
    sockaddr_in redirected{};
    if (!Redirect(address, length, redirected)) {
        return g_original_connect(socket, address, length);
    }
    return g_original_connect(socket, reinterpret_cast<const sockaddr*>(&redirected),
                              static_cast<int>(sizeof(redirected)));
}


}  // namespace

ConnectHook::~ConnectHook() { Remove(); }

Status ConnectHook::Install(ConnectHookOptions options, TargetReporter report) {
    if (g_installed.load(std::memory_order_acquire)) {
        return Error{ErrorCode::kInvalidArgument, "a connect hook is already installed"};
    }

    // `ws2_32.dll` is loaded by anything that touches a socket, so by the time
    // the game is running it is there — but the module starts before the game
    // does, so this can legitimately be too early.
    const HMODULE winsock = ::GetModuleHandleW(L"ws2_32.dll");
    if (winsock == nullptr) {
        return Error{ErrorCode::kNotReady, "ws2_32.dll is not loaded yet"};
    }

    // Verified like every other resolved address here: a detour written over
    // something that is not code corrupts whatever it was.
    const auto image = ModuleImage::Of(winsock);
    if (!image.ok()) {
        return image.error();
    }

    auto* proc = ::GetProcAddress(winsock, "connect");
    if (proc == nullptr) {
        return Error{ErrorCode::kNotFound, "ws2_32.dll exports no connect", ::GetLastError()};
    }
    void* const target = reinterpret_cast<void*>(proc);
    if (!image.value().ContainsCode(target)) {
        return Error{ErrorCode::kProtocol, "the resolved connect is not executable code"};
    }

    auto hook = hooks::Hook::Create(target, reinterpret_cast<void*>(&ConnectDetour));
    if (!hook.ok()) {
        return hook.error();
    }

    g_options = options;
    {
        const std::lock_guard<std::mutex> guard{g_report_lock};
        g_report = std::move(report);
    }

    hook_ = std::move(hook).value();
    g_original_connect = hook_.original<ConnectFn>();
    if (g_original_connect == nullptr) {
        Remove();
        return Error{ErrorCode::kInternal, "the connect hook has no trampoline"};
    }

    if (auto enabled = hook_.Enable(); !enabled.ok()) {
        Remove();
        return enabled.error();
    }

    g_installed.store(true, std::memory_order_release);
    return {};
}

void ConnectHook::Remove() noexcept {
    g_installed.store(false, std::memory_order_release);

    // The detour goes first, so no connection can still be inside the reporter
    // while it is being cleared.
    hook_ = hooks::Hook{};
    g_original_connect = nullptr;

    const std::lock_guard<std::mutex> guard{g_report_lock};
    g_report = nullptr;
}

std::uint32_t ConnectHook::redirected() const noexcept {
    return g_redirected.load(std::memory_order_relaxed);
}

std::uint32_t ConnectHook::seen() const noexcept {
    return g_seen.load(std::memory_order_relaxed);
}

std::uint16_t ConnectHook::last_other_port() const noexcept {
    return g_last_other_port.load(std::memory_order_relaxed);
}

}  // namespace brownie::net
