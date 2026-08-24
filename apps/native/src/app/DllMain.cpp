// The module's entry point, and as little else as possible.
//
// `DllMain` runs under the loader lock: almost nothing is safe to do here.
// Creating a thread is, which is why the only thing that happens on attach is
// forwarding the real library and starting one — everything else the module
// does happens on that thread, or on the game's render thread later — and none
// of it before the operator has answered the prompt that thread opens first.
//
// The reference implementation instead did its whole startup here, including a
// six-second sleep, under that same lock.

#include <array>
#include <cwctype>
#include <memory>
#include <string>
#include <string_view>

#include <Windows.h>

#include "app/Engine.h"

namespace brownie::app {
bool LoadRealProxyTarget();
}  // namespace brownie::app

namespace {

/// Whether this process is the game, rather than something else that happens to
/// load a DLL from the game's folder.
///
/// `UnityCrashHandler64.exe` lives beside the executable, so Windows hands it
/// our module too — and it starts precisely when the game has died. The runtime
/// then saw a second peer claiming to be the game and refused it, repeatedly,
/// filling the log with warnings about a situation nobody could act on. Only
/// the game starts an engine.
bool HostIsTheGame() {
    std::array<wchar_t, MAX_PATH> path{};
    const DWORD length = ::GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (length == 0 || length >= path.size()) {
        return false;
    }

    std::wstring_view file{path.data(), length};
    if (const std::size_t slash = file.find_last_of(L"\\/"); slash != std::wstring_view::npos) {
        file.remove_prefix(slash + 1);
    }

    // Compared case-insensitively, because the loader does and the log has
    // already shown the name spelled both ways.
    static constexpr std::wstring_view kGame = L"rotmg exalt.exe";
    if (file.size() != kGame.size()) {
        return false;
    }
    for (std::size_t i = 0; i < file.size(); ++i) {
        if (static_cast<wchar_t>(::towlower(file[i])) != kGame[i]) {
            return false;
        }
    }
    return true;
}

/// The pipe name, from the environment or the default.
///
/// The game is launched by whoever launches it, so the module has to be told
/// where the runtime is listening, and an environment variable is the one
/// channel a launcher can set without a file or a registry key. The name is
/// validated where it is used — it also names the session key file — so
/// something unusable here makes the module go quiet rather than read the wrong
/// file.
std::wstring PipeNameFromEnvironment() {
    constexpr const wchar_t* kVariable = L"BROWNIE_NATIVE_PIPE";
    const DWORD needed = ::GetEnvironmentVariableW(kVariable, nullptr, 0);
    if (needed == 0) {
        return L"brownie-bridge";
    }
    std::wstring value(needed, L'\0');
    const DWORD written = ::GetEnvironmentVariableW(kVariable, value.data(), needed);
    if (written == 0 || written >= needed) {
        return L"brownie-bridge";
    }
    value.resize(written);
    return value;
}

/// A boolean from the environment. Absent, empty and "0" all mean false.
bool FlagFromEnvironment(const wchar_t* name) {
    wchar_t value[8]{};
    const DWORD written = ::GetEnvironmentVariableW(name, value, 8);
    if (written == 0 || written >= 8) {
        return false;
    }
    return value[0] == L'1' || value[0] == L'y' || value[0] == L'Y' || value[0] == L't' ||
           value[0] == L'T';
}

/// Owned by the module, torn down on detach.
///
/// A pointer rather than a static object: a static's destructor would run
/// during process teardown at a moment the module does not choose, and this one
/// joins a thread.
std::unique_ptr<brownie::app::Engine> g_engine;

DWORD WINAPI StartEngine(LPVOID /*unused*/) {
    // Nothing to configure but the pipe name, and its default is the one the
    // runtime uses. The shared secret is deliberately absent: it is read from
    // the file the runtime publishes, on every connection attempt, because a
    // secret compiled into a shipped DLL is a secret everybody with the DLL
    // has. See `ipc/SessionKey.h`.
    brownie::app::EngineOptions options;
    options.pipe_name = PipeNameFromEnvironment();

    // There is one mode: bind, draw, redirect. The layers used to be switchable
    // from the environment to bisect a module that stopped the game from
    // starting, and the switches cost more than they found — a variable left
    // set in an environment the game inherits is a build that runs and does
    // nothing, with no way to tell it apart from one that is broken.
    g_engine = std::make_unique<brownie::app::Engine>(std::move(options));
    if (auto started = g_engine->Start(); !started.ok()) {
        g_engine.reset();
    }
    return 0;
}

}  // namespace

/// Stops everything the module started. Call before `FreeLibrary`, never from
/// `DllMain`.
///
/// Exported because there is nowhere else this can happen: teardown joins a
/// thread and removes hooks, and both deadlock against the loader lock that
/// `DllMain` holds. An ordinary thread has no such problem.
///
/// Idempotent, and safe to call from any thread but the one being torn down.
extern "C" __declspec(dllexport) void BrownieShutdown() { g_engine.reset(); }

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID reserved) {
    switch (reason) {
        case DLL_PROCESS_ATTACH: {
            // We are never notified about threads, and asking not to be removes
            // a callback from every thread the game creates.
            ::DisableThreadLibraryCalls(module);

            // Before anything else: the process may call a forwarded function
            // at any moment, including from another thread while we are still
            // starting.
            if (!brownie::app::LoadRealProxyTarget()) {
                // Refusing to load is the honest outcome. A proxy that cannot
                // forward would let the game run until it happened to call the
                // one function that is missing.
                return FALSE;
            }

            // Only the game runs an engine. Everything else Windows hands this
            // DLL to still gets a working proxy — which is the whole reason it
            // must keep loading for them.
            //
            // `BROWNIE_NATIVE_ANY_HOST` is for the test host, which is
            // deliberately not called "RotMG Exalt.exe": a check that could be
            // passed by renaming a file would not be a check.
            if (!HostIsTheGame() && !FlagFromEnvironment(L"BROWNIE_NATIVE_ANY_HOST")) {
                return TRUE;
            }

            // The rest happens off the loader lock.
            const HANDLE thread = ::CreateThread(nullptr, 0, StartEngine, nullptr, 0, nullptr);
            if (thread != nullptr) {
                ::CloseHandle(thread);
            }
            return TRUE;
        }

        case DLL_PROCESS_DETACH:
            // **Nothing is torn down here, under either reason, and that is the
            // fix rather than an omission.** `DllMain` runs holding the loader
            // lock, and everything teardown needs deadlocks against it:
            //
            //   * Joining the engine thread waits for a thread whose loop calls
            //     `GetModuleHandleW` — which takes the loader lock we hold.
            //   * MinHook's teardown suspends every other thread and enumerates
            //     them, which needs the loader lock too.
            //
            // That is not a theory: it hung the test host for five minutes
            // instead of the four seconds it should take.
            //
            // So the two cases are handled outside this function:
            //
            //   * The process is exiting (`reserved != nullptr`). Every other
            //     thread has already been terminated wherever it happened to
            //     be, and the operating system reclaims the address space — so
            //     there is nothing to do and nobody left to do it for.
            //   * A real `FreeLibrary`. The caller must have called
            //     `BrownieShutdown` first, from an ordinary thread, where none
            //     of the above is a problem.
            //
            // Unloading without that call leaves hooks pointing into memory
            // about to be unmapped. There is no safe way to fix that from here,
            // so it is a documented requirement rather than a silent best
            // effort that deadlocks.
            (void)reserved;
            return TRUE;

        default:
            return TRUE;
    }
}
