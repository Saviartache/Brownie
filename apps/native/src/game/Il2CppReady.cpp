#include "game/Il2CppReady.h"

#include <Windows.h>

namespace brownie::game {
namespace {

struct WindowSearch {
    DWORD process_id = 0;
    bool found = false;
};

/// True for a window this process owns that a person could actually see.
///
/// Unity creates its window as part of bringing the engine up, so its presence
/// is evidence that startup has got that far — and unlike anything inside
/// `GameAssembly.dll`, asking costs the game nothing.
BOOL CALLBACK OnWindow(HWND window, LPARAM parameter) {
    auto* search = reinterpret_cast<WindowSearch*>(parameter);

    DWORD owner = 0;
    ::GetWindowThreadProcessId(window, &owner);
    if (owner != search->process_id || ::IsWindowVisible(window) == FALSE) {
        return TRUE;
    }
    // A zero-area window is a message sink or a splash placeholder, not the
    // game — and treating one as the game would start the clock too early.
    RECT bounds{};
    if (::GetWindowRect(window, &bounds) == FALSE) {
        return TRUE;
    }
    if (bounds.right - bounds.left < 200 || bounds.bottom - bounds.top < 200) {
        return TRUE;
    }

    search->found = true;
    return FALSE;  // Stop: one is enough.
}

[[nodiscard]] bool HasVisibleWindow() noexcept {
    WindowSearch search{::GetCurrentProcessId(), false};
    ::EnumWindows(&OnWindow, reinterpret_cast<LPARAM>(&search));
    return search.found;
}

}  // namespace

void Il2CppReady::Observe() {
    if (ready_) {
        return;
    }

    if (!assembly_seen_) {
        // Loaded by the player well after this module is. Nothing to do yet,
        // and nothing to report — this is the ordinary first second.
        assembly_seen_ = ::GetModuleHandleW(L"GameAssembly.dll") != nullptr;
        return;
    }

    if (!window_seen_) {
        if (!HasVisibleWindow()) {
            return;
        }
        window_seen_ = true;
        window_seen_at_ = ::GetTickCount();
        return;
    }

    // Unsigned subtraction, so the tick counter wrapping past its 49 days does
    // not produce an enormous elapsed time and an answer of "never".
    const std::uint32_t elapsed = ::GetTickCount() - window_seen_at_;
    if (elapsed >= kSettleMs) {
        ready_ = true;
    }
}

const char* Il2CppReady::state() const noexcept {
    if (ready_) {
        return "started";
    }
    if (!assembly_seen_) {
        return "waiting for GameAssembly.dll";
    }
    if (!window_seen_) {
        return "waiting for the game's window";
    }
    return "letting the runtime settle";
}

}  // namespace brownie::game
