// The game's main thread, once a frame.
//
// **`Present` is not it, and this is what that cost.** The game renders with
// Unity's multithreaded renderer — `Rendering threading mode: MultiThreaded` in
// its own `Player.log` — so the swap chain is presented from Unity's render
// thread, which IL2CPP has never been told about. Something that only reads
// memory, or calls a method that touches nothing but its own fields, gets away
// with running there. The ability method does not: it formats text, plays
// sounds and allocates, and the first `[ThreadStatic]` on that path — the
// current culture, the cached string builder — reads the per-thread block
// IL2CPP keeps for the threads it manages, finds none, and dereferences null.
// Both crash dumps say exactly that: an access violation reading address 0 at
// `GameAssembly+0x21D194`, `mov rax,[rdi+rbx*8]` with `rdi` the empty
// thread-static table, called from the `Present` detour.
//
// So this detours `InputManager.Update` instead. It is a MonoBehaviour's
// `Update`, which Unity calls by name on the main thread every frame — so the
// name survives the obfuscator — and it is where the game reads its own keys,
// the ability key included. What runs here runs where a key press would.
//
// **Before the game's own input handling, not after.** Something pressed here
// has already happened by the time the game looks at the keys, so a press the
// player makes in the same frame meets the client's own checks — cooldown,
// mana — exactly as a second press of theirs would. After it, the two would
// meet nothing: the client would already have made the player's.
//
// **The callback does the work; the detour does no more than call it.** It is
// a C callback with nowhere to carry a `this`, so it finds its owner through a
// file-level pointer — the one global in this file, for the reason every
// detour here has one.

#pragma once

#include <functional>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::game {

class MainThreadTick {
  public:
    /// Called once a frame on the game's main thread, before the game's own
    /// input handling. May call into managed code: that is what it is for.
    using TickFn = std::function<void()>;

    MainThreadTick() noexcept = default;

    MainThreadTick(const MainThreadTick&) = delete;
    MainThreadTick& operator=(const MainThreadTick&) = delete;
    MainThreadTick(MainThreadTick&&) = delete;
    MainThreadTick& operator=(MainThreadTick&&) = delete;

    /// Removes the detour. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~MainThreadTick();

    /// Detours `InputManager.Update`. **IPC thread.** A no-op once installed.
    ///
    /// Only one may exist per process, for the reason every detour here is a
    /// singleton: a C callback has nowhere to carry a `this`.
    Status Install(void* input_update, TickFn tick);

    /// Removes it. Safe to call more than once.
    void Remove() noexcept;

    [[nodiscard]] bool installed() const noexcept { return hook_.installed(); }

    // --- Called only by the detour in MainThreadTick.cpp.

    void Tick() const { tick_(); }

    [[nodiscard]] void* original() const noexcept { return original_; }

  private:
    hooks::Hook hook_;
    void* original_ = nullptr;
    /// Written once, before the detour is enabled, and only read after.
    TickFn tick_;
};

}  // namespace brownie::game
