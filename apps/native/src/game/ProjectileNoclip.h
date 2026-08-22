// Shots that do not stop at walls.
//
// The other half of aiming. Auto-aim points a shot at the enemy most likely to
// be hit; this is what makes "behind that pillar" one of the places a shot can
// be pointed at. Neither needs the other and both are off until switched on.
//
// **It changes what the client asks, not what the client is told.** The obvious
// implementation — return "no wall" from the collision check — does not work,
// because the method that asks re-reads the square's collision layer for
// itself afterwards. So the change is made where the answer comes from: while
// one shot is being asked about, the square it stands on is a passable one, and
// it is the square it was before the question is answered.
//
// Two detours, and they are one scope:
//
//   * `TileBlocks(x, y)` — the inner test. Runs first, and if the game says
//     "wall" it puts the square's collision layer aside and writes a passable
//     one in its place. The answer it returns is the game's own, unchanged.
//   * `HitsWall(x, y)` — the outer check, which calls the inner one and then
//     re-reads the square. It sees the passable layer, so the shot carries on —
//     and on the way out it puts back exactly what was taken.
//
// **The pair must be installed together.** The inner alone would make a square
// passable with nothing to close it again: a hole in somebody's map that lasts
// until the map is rebuilt. `Install` therefore refuses unless both go in, and
// enables the outer first.
//
// **What separates the player's shots from everyone else's is one flag**, and
// what that flag means is the reference implementation's claim rather than
// anything this project has verified — the metadata's name table is encrypted,
// so the name says nothing. It is used as a guard and never as a fact: no
// square is changed for a projectile that does not carry it. If a live run ever
// shows monsters' shots crossing walls too, that flag is the thing that was
// wrong, and the feature is off by default and switched off with one click
// while somebody looks. See `ProjectileFields.h`.
//
// **The work is bounded and it is not on the ordinary path.** Every shot in
// flight reaches the outer detour on every tick, and all that costs is a
// pointer load, a call through and a null check. Nothing is read out of the
// game until the game itself has said "wall", which is the moment a shot
// reaches one — and even then it is three reads and two writes through the
// no-fault path in `PlayerRoute.h`, because the pointers involved come out of
// the game's own memory and one of them may already be freed.

#pragma once

#include <atomic>
#include <cstdint>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::game {

/// The three offsets the detours read, all of them or none.
///
/// Zero stands for "not resolved", which it can because offset zero of a
/// managed object is its header and never an instance field. That is one flag
/// rather than three, and it is checked in one place — {@link complete}.
struct ProjectileTileRoute {
    /// The projectile's "in flight" flag, which guards everything below.
    std::uint32_t active_at = 0;
    /// The square the projectile is standing on, from the map-object base.
    std::uint32_t tile_at = 0;
    /// That square's collision layer — the one number that decides.
    std::uint32_t layer_at = 0;

    [[nodiscard]] bool complete() const noexcept {
        return active_at != 0 && tile_at != 0 && layer_at != 0;
    }
};

/// One square's collision layer, put aside while a shot is asked about it.
///
/// The whole of what this feature writes into the game, in a unit small enough
/// to test against a fake object — which is the point of it being a type rather
/// than three variables beside the detours. Taking and putting back are the two
/// halves of one claim: a swap that is applied and not restored is a square
/// that stays passable.
class TileSwap {
  public:
    /// What a square's collision layer is set to while a shot is over it.
    ///
    /// A magic number, and knowingly: it is the layer the reference
    /// implementation wrote, taken from a game the author had running, and the
    /// enumeration it belongs to is obfuscated like everything around it. It is
    /// never read back and never left behind — {@link Restore} puts the game's
    /// own value back — so being wrong about which layer it names costs a shot
    /// that still stops, not a square that stays broken.
    static constexpr std::int32_t kPassableLayer = 37;

    /// Makes the square under `projectile` passable, if it is not already and
    /// the shot is one to do it for.
    ///
    /// @returns whether anything was written — and so whether there is anything
    ///   to put back. False leaves this holding nothing, so a failed read
    ///   halfway down cannot produce a restore to an address never written.
    [[nodiscard]] bool Apply(void* projectile, const ProjectileTileRoute& route) noexcept;

    /// Puts back what {@link Apply} took. Does nothing when it took nothing, so
    /// it is safe to call on any path out — which is what makes the pairing a
    /// property of the code rather than of remembering.
    void Restore() noexcept;

    [[nodiscard]] bool held() const noexcept { return tile_ != nullptr; }

  private:
    void* tile_ = nullptr;
    std::uint32_t layer_at_ = 0;
    std::int32_t saved_ = 0;
};

class ProjectileNoclip {
  public:
    ProjectileNoclip() noexcept = default;

    ProjectileNoclip(const ProjectileNoclip&) = delete;
    ProjectileNoclip& operator=(const ProjectileNoclip&) = delete;
    ProjectileNoclip(ProjectileNoclip&&) = delete;
    ProjectileNoclip& operator=(ProjectileNoclip&&) = delete;

    /// Removes both detours. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~ProjectileNoclip();

    /// Puts both detours in place, or neither. **IPC thread.**
    ///
    /// Only one of these may exist per process, for the reason `AimHook` gives:
    /// a detour is a C callback with nowhere to carry a `this`. A second object
    /// is refused; calling this again on the same one once it is installed does
    /// nothing.
    ///
    /// Fails with `kNotReady` until every offset and both methods have
    /// resolved, which is until the game has built a projectile — so a caller
    /// asks again rather than giving up.
    Status Install(const ProjectileTileRoute& route, void* hits_wall, void* tile_blocks);

    /// Removes them. Safe to call more than once, and from any thread.
    ///
    /// **A square may be left passable**, in one case: a thread standing inside
    /// the outer method with a swap held when the detour is taken out from
    /// under it never reaches its own restore. Removing a hook suspends every
    /// other thread, so this is a window of one call rather than a race, and
    /// what it costs is one square in a map that is about to be torn down —
    /// this runs when the module is unloading or the game is quitting.
    void Remove() noexcept;

    /// Whether both detours are live and doing their work.
    [[nodiscard]] bool installed() const noexcept {
        return live_.load(std::memory_order_acquire);
    }

    /// Switches the feature on and off. Any thread, and cheap enough to call
    /// every frame — which is how the overlay's switch reaches it.
    ///
    /// Installed and enabled are separate on purpose: a detour is a write into
    /// the game's code and stays once it is in, while what the operator wants
    /// changes with a click. With this off both detours forward their calls and
    /// nothing is written into the game.
    void SetEnabled(bool on) noexcept { enabled_.store(on, std::memory_order_relaxed); }

    [[nodiscard]] bool enabled() const noexcept {
        return enabled_.load(std::memory_order_relaxed);
    }

    /// How many shots have been let through a wall, for the overlay to show. A
    /// switch that is on and a feature that is working look identical without
    /// it. Written by the game's thread, read by any.
    [[nodiscard]] std::uint32_t passed() const noexcept {
        return passed_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detours in ProjectileNoclip.cpp. Public because a
    // --- free function cannot be a friend of a class it does not know about.

    /// Makes the square under `projectile` passable for this one question,
    /// recording the swap in `swap` so the outer detour can undo it.
    void LetThrough(void* projectile, TileSwap& swap) noexcept;

    /// The code each detour replaced, to call through to. Held here rather than
    /// in file-level variables beside the hook, for the reason `AimHook` gives:
    /// there is already exactly one of these and the detour already has to find
    /// it.
    [[nodiscard]] void* hits_wall_original() const noexcept { return hits_wall_original_; }
    [[nodiscard]] void* tile_blocks_original() const noexcept { return tile_blocks_original_; }

  private:
    /// Drops both hooks and everything published with them, without touching
    /// what the operator asked for. Shared by `Remove` and by the failure path
    /// of `Install`, so that a failed install can be retried on the next turn
    /// instead of also switching the feature off.
    void Detach() noexcept;

    hooks::Hook hits_wall_;
    hooks::Hook tile_blocks_;
    void* hits_wall_original_ = nullptr;
    void* tile_blocks_original_ = nullptr;

    /// Written once before the detours are enabled and read by them after —
    /// enabling a hook suspends every other thread, which is what publishes it.
    ProjectileTileRoute route_{};

    /// Set last, cleared first, and the only thing another thread reads to know
    /// whether any of the above is worth looking at.
    std::atomic<bool> live_{false};
    std::atomic<bool> enabled_{false};
    std::atomic<std::uint32_t> passed_{0};
};

}  // namespace brownie::game
