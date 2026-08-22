// Knowing when IL2CPP has started, without touching it.
//
// **A non-null domain is not a started runtime.** `il2cpp_domain_get` returns
// one early inside `il2cpp_init`, long before anything may be asked of the
// runtime: attaching a thread to a garbage collector still being built, or
// opening an assembly that is not loadable yet, is a call into a half-built
// machine. So the domain pointer is not the signal.
//
// The exact signal would be a detour on `il2cpp_init` that raises a flag when it
// returns. This does not do that, because installing a detour means writing over
// a function's first bytes at the moment the game is entering it, and the
// readiness check is not worth patching the game's own startup path for.
//
// So this touches **nothing**: no IL2CPP call, no patch, no read of the game's
// memory. It watches two things the operating system answers for — that
// `GameAssembly.dll` is loaded, and that the process has a visible window, which
// Unity shows only once its engine is up — and then waits out a settle period so
// that "the window appeared" is not mistaken for "everything behind it is
// finished".
//
// A conservative lower bound rather than an exact moment, deliberately. Being
// late costs a few seconds of a feature not working; being early would mean
// acting on a runtime that cannot answer.

#pragma once

#include <cstdint>

namespace brownie::game {

class Il2CppReady {
  public:
    Il2CppReady() = default;

    Il2CppReady(const Il2CppReady&) = delete;
    Il2CppReady& operator=(const Il2CppReady&) = delete;
    Il2CppReady(Il2CppReady&&) = delete;
    Il2CppReady& operator=(Il2CppReady&&) = delete;

    /// Advances the observation. Cheap, and safe to call from one thread as
    /// often as its loop turns.
    void Observe();

    /// Whether the runtime can be used.
    ///
    /// False whenever it cannot prove otherwise. A feature that acts on a maybe
    /// is a feature that crashes the game.
    [[nodiscard]] bool ready() const noexcept { return ready_; }

    /// What it is waiting for, for the overlay to show. Never null.
    [[nodiscard]] const char* state() const noexcept;

  private:
    /// How long after the game's window appears before the runtime is called.
    ///
    /// A number chosen to be far longer than initialisation takes rather than
    /// tuned to it: the cost of waiting is a feature starting late, and the cost
    /// of not waiting is the crash this file exists to avoid.
    static constexpr std::uint32_t kSettleMs = 5000;

    bool assembly_seen_ = false;
    bool window_seen_ = false;
    std::uint32_t window_seen_at_ = 0;
    bool ready_ = false;
};

}  // namespace brownie::game
