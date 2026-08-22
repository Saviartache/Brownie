// Noticing that the game is on its way out.
//
// **A module that is still holding the game while the game is being taken apart
// is the one shutdown case nothing else covers.** `DllMain` cannot tear
// anything down — it runs under the loader lock, where joining a thread and
// removing a hook both deadlock — and `BrownieShutdown` only happens when
// somebody calls it. Between those two is the ordinary way this process ends:
// the player closes the game, Unity destroys its runtime, and every detour the
// module left in place is still in the way of code that is unmaking itself.
//
// `Application.Quit` is where that starts, so it is where this listens. The
// detour does nothing but raise a flag and call through — no teardown inside
// somebody's quit path, no exit, no wait — and the module's own loop does the
// letting go on its own thread, where that is safe.
//
// **This is deliberately not what the reference module did.** Its detour called
// `FreeConsole` and `ExitProcess(0)`: it had allocated a console whose control
// handler refused every close, so the process it had made unkillable had to be
// killed from here. There is no console here, so there is nothing to work
// around — and ending the process from inside a hook would take the link, the
// overlay and the module's own teardown down with it.

#pragma once

#include <atomic>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::game {

class QuitWatch {
  public:
    QuitWatch() noexcept = default;

    QuitWatch(const QuitWatch&) = delete;
    QuitWatch& operator=(const QuitWatch&) = delete;
    QuitWatch(QuitWatch&&) = delete;
    QuitWatch& operator=(QuitWatch&&) = delete;

    ~QuitWatch();

    /// Detours `UnityEngine.Application::Quit()`. **IPC thread.**
    ///
    /// Only one may exist per process, for the reason every detour in this
    /// project is a singleton: a C callback has nowhere to carry a `this`.
    Status Install(void* quit);

    /// Removes it. Safe to call more than once, and from any thread.
    void Remove() noexcept;

    [[nodiscard]] bool installed() const noexcept { return hook_.installed(); }

    /// Whether the game has asked to quit. Set once and never cleared: a quit
    /// that has been asked for stays asked for.
    [[nodiscard]] bool quitting() const noexcept {
        return quitting_.load(std::memory_order_acquire);
    }

    // --- Called only by the detour in QuitWatch.cpp.

    void Notice() noexcept { quitting_.store(true, std::memory_order_release); }

    [[nodiscard]] void* original() const noexcept { return original_; }

  private:
    hooks::Hook hook_;
    void* original_ = nullptr;
    std::atomic<bool> quitting_{false};
};

}  // namespace brownie::game
