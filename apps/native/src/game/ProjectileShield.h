// Shots that cannot land on the player, because of what they were built as.
//
// The mirror image of `PlayerCollision.h`. That one takes the collision circle
// off the *player*, once, on a descriptor every player shares; this one takes
// the hitbox off each *shot*, as the shot is built, and only ever off the shots
// that are allowed to hurt players at all.
//
// **Why the shot and not the player.** The client decides its own hits. Every
// tick, a projectile builds a `[BurstCompile]` job out of six of its own
// fields — where it is, who it may hurt, how big it is — schedules it against
// the map's entity list and reads back one object id, or `-1` for "hit
// nothing". Only then does it look the target up and report it. So there are
// exactly three numbers in that job worth changing, and all three live on the
// projectile:
//
//   * **how big it is.** The test is Chebyshev, `|dx| < r && |dy| < r`, and `r`
//     is `CollisionMult × 0.5` written at birth. A strict `<` means `r = 0` is a
//     shot nothing can ever overlap — not a trick, but a shape sixty-odd of the
//     game's own projectiles already declare and fly with.
//   * **whether it may hurt players.** Clearing it leaves the job scanning for
//     nobody, so it answers `-1` every tick until the shot expires.
//   * **whether it may hurt monsters.** Setting it while clearing the first
//     turns a monster's shot on its own side. See {@link ShieldMode::Redirect},
//     and read what it costs before switching it on.
//
// `-1` is not a path invented for this. It is the answer the game gets for
// every shot in the air that has not hit anything yet, on every tick, and the
// code above it treats this one no differently.
//
// **Written at birth, and never put back — which is correct here and is not
// how the rest of the module works.** Projectiles are pooled: the same object
// is initialised again for the next shot, through the very method this detours,
// and the game's own number goes back in with no help from us. So there is no
// swap to hold, no restore to pair, and nothing left behind by an unload at a
// moment nobody chose — which is what `TileSwap` in `ProjectileNoclip.h` needs a
// whole type to guarantee.
//
// What that costs is one shot's flight: switching the shield off leaves the
// shots already in the air harmless for up to two seconds, and switching it on
// leaves the shots already in the air dangerous for the same. Both are the
// honest answer — the shield is a claim about shots that have yet to be fired —
// and both are shorter than the lease that ends the claim anyway.
//
// **It is the player's own shots that are never touched.** Every write here is
// behind one read of `damagesPlayers`, which the game sets from the owner's
// descriptor and which no shot the player fired carries. A shield that shrank
// the player's own bullets would be a player who cannot hit anything.
//
// **The work is bounded and it is not on the per-tick path.** This runs once
// per shot fired rather than once per shot per tick, which is the reason the
// initialiser is the detour and the hit scan is not: the reads and writes go
// through the no-fault path in `PlayerRoute.h`, and those are system calls. A
// few hundred a second is nothing; a few hundred per *frame* would not be.

#pragma once

#include <atomic>
#include <cstdint>
#include <optional>

#include "core/Result.h"
#include "game/ShieldMode.h"
#include "hooks/Hook.h"

namespace brownie::game {

/// The three offsets the detour writes through, all of them or none.
///
/// Zero stands for "not resolved", which it can because offset zero of a
/// managed object is its header and never an instance field — the same flag
/// `ProjectileTileRoute` uses, for the same reason.
struct ShotFieldRoute {
    /// Set on shots fired by something the game calls an enemy. The guard on
    /// every write below.
    std::uint32_t damages_players_at = 0;
    /// Its opposite, set on the player's own shots. Written only by
    /// {@link ShieldMode::Redirect}.
    std::uint32_t damages_enemies_at = 0;
    /// The half-side of the shot's collision square, in tiles.
    std::uint32_t collision_half_at = 0;

    [[nodiscard]] bool complete() const noexcept {
        return damages_players_at != 0 && damages_enemies_at != 0 && collision_half_at != 0;
    }
};

/// What to write into a shot the game has just built.
///
/// A plan rather than the writes themselves, so that the rule deciding it can
/// be tested at a desk with no game to run in — which is the same split
/// `PlayerCollision.h` makes and for the same reason: what gets written is the
/// part worth being sure about.
struct ShotEdit {
    /// Multiply the shot's collision half-extent by {@link collision_scale}.
    ///
    /// A scale rather than an absolute, because the game's own number is
    /// per-projectile: a shot's size is its `CollisionMult`, and replacing that
    /// with one value for all of them would make the big shots small and the
    /// small shots big.
    bool scale_collision_half = false;
    float collision_scale = 1.0F;

    /// Replace both "who may I hurt" flags with the two below.
    bool set_flags = false;
    std::uint8_t damages_players = 0;
    std::uint8_t damages_enemies = 0;
};

/// What `mode` and `multiplier` mean for a shot that may hurt players, or
/// nothing at all when they mean leaving it alone.
///
/// Free of the game: it is handed the two numbers the operator chose and
/// answers with what to write. `multiplier` is refused rather than guessed at
/// when it is not a fraction — a scale above one is a *larger* shot than the
/// game built, which is the one outcome nobody could ask for on purpose, and a
/// scale that is not a number would erase every hitbox in the realm by
/// arithmetic rather than by choice.
[[nodiscard]] std::optional<ShotEdit> PlanShotEdit(ShieldMode mode, float multiplier) noexcept;

class ProjectileShield {
  public:
    ProjectileShield() noexcept = default;

    ProjectileShield(const ProjectileShield&) = delete;
    ProjectileShield& operator=(const ProjectileShield&) = delete;
    ProjectileShield(ProjectileShield&&) = delete;
    ProjectileShield& operator=(ProjectileShield&&) = delete;

    /// Removes the detour. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~ProjectileShield();

    /// Puts the detour in place. **IPC thread.**
    ///
    /// Only one of these may exist per process, for the reason `AimHook` gives:
    /// a detour is a C callback with nowhere to carry a `this`. A second object
    /// is refused; calling this again on the same one once it is installed does
    /// nothing.
    ///
    /// Fails with `kNotReady` until all three offsets and the initialiser have
    /// resolved, which is until the game has built a projectile — so a caller
    /// asks again rather than giving up.
    Status Install(const ShotFieldRoute& route, void* init);

    /// Removes it. Safe to call more than once, and from any thread.
    ///
    /// **Nothing is left behind in the game.** Every write this makes is undone
    /// by the game's own initialiser the next time that shot object is reused,
    /// so unlike projectile noclip there is no window in which a teardown can
    /// strand a change — the worst an unload mid-flight costs is the shots
    /// currently in the air keeping the size they were fired with.
    void Remove() noexcept;

    /// Whether the detour is live.
    [[nodiscard]] bool installed() const noexcept {
        return live_.load(std::memory_order_acquire);
    }

    /// What to do with the next shot. Any thread, and cheap enough to call
    /// every frame — which is how the overlay's switch reaches it.
    ///
    /// Installed and acting are separate on purpose: a detour is a write into
    /// the game's code and stays once it is in, while what the operator wants
    /// changes with a click. At {@link ShieldMode::Off} the detour forwards its
    /// call and nothing is written into the game.
    void SetMode(ShieldMode mode) noexcept { mode_.store(mode, std::memory_order_relaxed); }

    [[nodiscard]] ShieldMode mode() const noexcept {
        return mode_.load(std::memory_order_relaxed);
    }

    /// What {@link ShieldMode::Shrink} scales by. Stored whether or not a mode
    /// is using it, so a value that arrives ahead of the mode is not lost.
    void SetMultiplier(float multiplier) noexcept {
        multiplier_.store(multiplier, std::memory_order_relaxed);
    }

    [[nodiscard]] float multiplier() const noexcept {
        return multiplier_.load(std::memory_order_relaxed);
    }

    /// How many shots have been taken apart, for the overlay to show. A switch
    /// that is on and a feature that is working look identical without it —
    /// more so here than anywhere else in the module, because what this feature
    /// produces is *nothing happening*. Written by the game's thread, read by
    /// any.
    [[nodiscard]] std::uint32_t guarded() const noexcept {
        return guarded_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detour in ProjectileShield.cpp. Public because a
    // --- free function cannot be a friend of a class it does not know about.

    /// Applies the current mode to a shot the game has just finished building.
    void Guard(void* projectile) noexcept;

    /// The code the detour replaced, to call through to. Held here rather than
    /// in a file-level variable beside the hook, for the reason `AimHook` gives:
    /// there is already exactly one of these and the detour already has to find
    /// it.
    [[nodiscard]] void* init_original() const noexcept { return init_original_; }

  private:
    /// Drops the hook and everything published with it, without touching what
    /// the operator asked for. Shared by `Remove` and by the failure path of
    /// `Install`, so that a failed install can be retried on the next turn
    /// instead of also switching the feature off.
    void Detach() noexcept;

    hooks::Hook init_;
    void* init_original_ = nullptr;

    /// Written once before the detour is enabled and read by it after —
    /// enabling a hook suspends every other thread, which is what publishes it.
    ShotFieldRoute route_{};

    /// Set last, cleared first, and the only thing another thread reads to know
    /// whether any of the above is worth looking at.
    std::atomic<bool> live_{false};
    std::atomic<ShieldMode> mode_{ShieldMode::Off};
    std::atomic<float> multiplier_{0.0F};
    std::atomic<std::uint32_t> guarded_{0};
};

}  // namespace brownie::game
