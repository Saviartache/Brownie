// Silent aim: the player's own shots, pointed somewhere else.
//
// **It does not shoot, and it does not touch the mouse.** The client decides
// when to fire and builds the shot exactly as it always does; the one thing
// changed is the *angle* it computes, and it is changed inside the client's own
// call to compute it. So the projectile the player sees, the packet the server
// receives and the hits the client reports are all the same shot — which is
// what "silent" means here and what rewriting an outgoing `PLAYERSHOOT` cannot
// give: that would leave the server's copy of the bullet somewhere the client's
// is not, and the client reports its hits about its own copy.
//
// Two detours, because the client has two ways in:
//
//   * `ComputeShootAngle(slot, out angle, out canShoot, bool)` — where the
//     angle is derived from the cursor. Overwritten *after* the original runs,
//     so whether the player may shoot at all stays the client's decision.
//   * `ShootWithAngle(angle)` — the shot itself, for any path that did not come
//     through the first. The argument is replaced on the way in.
//
// **The detours do no work.** They are called from the game's own shot path, so
// everything they could compute is computed beforehand: the frame publishes an
// angle and the object it belongs to, and a detour is an atomic load, two
// comparisons and a store. No memory read, no system call, no allocation, no
// lock — a detour that took a lock inside the game's frame would be a stall in
// somebody else's game.

#pragma once

#include <atomic>
#include <cstdint>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::game {

class AimHook {
  public:
    AimHook() noexcept = default;

    AimHook(const AimHook&) = delete;
    AimHook& operator=(const AimHook&) = delete;
    AimHook(AimHook&&) = delete;
    AimHook& operator=(AimHook&&) = delete;

    /// Removes both detours. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~AimHook();

    /// Installs whichever detour is not in place yet. **IPC thread.**
    ///
    /// Only one hook may exist per process: a detour is a C callback with
    /// nowhere to carry a `this`, so which object it belongs to is file-level
    /// state and a second one would make that a question. A second *object* is
    /// refused; calling this again on the same one is how the second detour
    /// arrives, because IL2CPP resolves the two methods whenever it gets round
    /// to building their classes and that is rarely the same turn.
    ///
    /// **Either alone is useful.** With only the first, the angle the client
    /// computes is already the aimed one and the shot follows it; with only the
    /// second, the shot is redirected without the client's own idea of where it
    /// aimed being changed. Both is better than either, and either is better
    /// than nothing, so this never refuses one for want of the other.
    ///
    /// @returns ok if anything is now installed.
    Status Install(void* compute_shoot_angle, void* shoot_with_angle);

    /// Removes them. Safe to call more than once, and from any thread.
    void Remove() noexcept;

    /// Whether at least one detour is live.
    [[nodiscard]] bool installed() const noexcept {
        return compute_.installed() || shoot_.installed();
    }

    /// Whether both are, which is when there is nothing left to install.
    [[nodiscard]] bool complete() const noexcept {
        return compute_.installed() && shoot_.installed();
    }

    /// Points the next shots at an angle, until `expires_at_ms`. Any thread.
    ///
    /// `player` is the object the angle was measured from: a shot by anything
    /// else is left alone, which is what keeps this the *player's* aim rather
    /// than everyone's.
    void Aim(void* player, float radians, std::uint64_t expires_at_ms) noexcept;

    /// Stops redirecting. The player's own aim is theirs again immediately.
    void Clear() noexcept;

    /// How many shots have been redirected, for the overlay to show. Written by
    /// the game's thread, read by any.
    [[nodiscard]] std::uint32_t redirected() const noexcept {
        return redirected_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detours in AimHook.cpp. Public because a free
    // --- function cannot be a friend of a class it does not know about.

    /// The angle to use for a shot by `self` right now, or nothing.
    [[nodiscard]] bool AngleFor(const void* self, float& out) noexcept;

    /// The code each detour replaced, to call through to.
    ///
    /// Held here rather than in a file-level variable beside `g_hook`: there is
    /// already exactly one hook, the detour already has to find it, and two
    /// more globals to keep in step with it is two more things that can be out
    /// of step. Null until that detour is in place, which a detour that is not
    /// in place cannot observe.
    [[nodiscard]] void* compute_original() const noexcept { return compute_original_; }
    [[nodiscard]] void* shoot_original() const noexcept { return shoot_original_; }

  private:
    /// Installs one detour, if it is not already there and there is somewhere
    /// to put it, and publishes the code it replaced into `original`. Failing
    /// to install one says nothing about the other.
    Status InstallOne(hooks::Hook& hook, void* target, void* detour, void*& original);

    hooks::Hook compute_;
    hooks::Hook shoot_;
    void* compute_original_ = nullptr;
    void* shoot_original_ = nullptr;

    /// The object the angle belongs to, or null while nothing is aimed.
    std::atomic<void*> player_{nullptr};
    /// Radians. Read only when `player_` matches, so the two cannot be
    /// meaningfully torn apart: a mismatched pair is a stale angle for the same
    /// player one frame ago, which is the same thing a fresh one would be by
    /// the time the shot leaves.
    std::atomic<float> angle_{0.0F};
    std::atomic<std::uint64_t> expires_at_ms_{0};
    std::atomic<std::uint32_t> redirected_{0};
};

}  // namespace brownie::game
