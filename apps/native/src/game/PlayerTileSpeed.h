// Keeping the ground from slowing the player down.
//
// The client works out how fast the player walks from the character's speed
// stat and then multiplies it by one number the ground supplies: a floor's
// `<Speed>`, and on a sinking one — water — a further reduction that deepens
// with every tick spent standing in it. While this is on that number is one,
// so water and quicksand cost the player nothing.
//
// **This belongs to noclip rather than being a feature of its own.** Noclip is
// already the state in which the client walks where the server would not have
// let it, and for as long as it lasts the server hears nothing at all — the
// runtime holds the socket. A speed the server is never told about is a speed
// it cannot argue with, so the two are switched on and off together and there
// is one switch for both.
//
// **Both detours or neither**, and what forces that is one line of the game's
// own movement code: `multiplier = min(multiplier, TileSpeedHere())`. Answering
// the question alone leaves whatever low number the previous tick had already
// stored, and storing one alone is taken straight back by the next `min`
// against the tile. The pair agrees on one, and every path that reads the
// multiplier then reads one.
//
// **The store goes after the game's own, not instead of it.** The method that
// writes the multiplier also keeps the client's sinking bookkeeping — how deep
// in the water the player is, which is what the game draws them by — and
// skipping it would make this module the thing that decides what the player
// looks like. It runs, and only the number it derived is put back.
//
// **Installed and enabled are separate**, for the reason `ProjectileNoclip.h`
// gives: a detour is a write into the game's code and stays once it is in,
// while what the operator wants changes with a click. With this off both
// detours forward their call and the ground slows the player exactly as it did
// before.
//
// **The work on the ordinary path is one relaxed load.** These run once a tick
// rather than once a frame, and off they do nothing but jump through the
// trampoline.

#pragma once

#include <atomic>
#include <cstdint>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::game {

/// What the ground is allowed to do to the player's speed while this is on:
/// nothing. The multiplier the game itself writes when it is standing on
/// ordinary floor.
inline constexpr float kFullTileSpeed = 1.0F;

class PlayerTileSpeed {
  public:
    PlayerTileSpeed() noexcept = default;

    PlayerTileSpeed(const PlayerTileSpeed&) = delete;
    PlayerTileSpeed& operator=(const PlayerTileSpeed&) = delete;
    PlayerTileSpeed(PlayerTileSpeed&&) = delete;
    PlayerTileSpeed& operator=(PlayerTileSpeed&&) = delete;

    /// Removes both detours. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~PlayerTileSpeed();

    /// Puts both detours in place. **IPC thread.**
    ///
    /// Only one of these may exist per process, for the reason `AimHook` gives:
    /// a detour is a C callback with nowhere to carry a `this`.
    ///
    /// @param tile_speed The player's "what does the ground under me do to my
    ///   speed", which is answered rather than asked while this is on.
    /// @param apply_tile_speed The tick that stores that answer on the player,
    ///   which is run and then corrected.
    /// @param multiplier_at Where on the player the answer is stored. Zero
    ///   means it has not resolved, and refuses: a detour that cannot write the
    ///   number is half of a mechanism whose halves do not work apart.
    Status Install(void* tile_speed, void* apply_tile_speed, std::uint32_t multiplier_at);

    /// Removes them. Safe to call more than once, and from any thread.
    void Remove() noexcept;

    [[nodiscard]] bool installed() const noexcept { return live_.load(std::memory_order_acquire); }

    /// Switches the feature on and off. Any thread, and cheap enough to call
    /// every frame — which is how the runtime's noclip switch reaches it.
    void SetEnabled(bool on) noexcept { enabled_.store(on, std::memory_order_relaxed); }

    [[nodiscard]] bool enabled() const noexcept {
        return enabled_.load(std::memory_order_relaxed);
    }

    /// How many times the ground has been denied its say, for the overlay to
    /// show. A switch that is on and a feature that is working look identical
    /// without it.
    [[nodiscard]] std::uint32_t denied() const noexcept {
        return denied_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detours in PlayerTileSpeed.cpp. Public because a
    // --- free function cannot be a friend of a class it does not know about.

    /// Whether to answer the ground's question instead of letting it through,
    /// counting it when it is.
    [[nodiscard]] bool DenyTileSpeed() noexcept;

    /// Puts the player's multiplier back to one, if the feature is on. Does
    /// nothing at all when it is off, which is the ordinary case.
    void KeepFullSpeed(void* player) noexcept;

    /// The code each detour replaced, to call through to. Null when that detour
    /// is not in, which is what a stray call is checked against.
    [[nodiscard]] void* tile_speed_original() const noexcept { return tile_speed_original_; }
    [[nodiscard]] void* apply_original() const noexcept { return apply_original_; }

  private:
    /// Takes both detours out and forgets everything they read. Not `Remove`,
    /// which switches the feature off first.
    void Detach() noexcept;

    hooks::Hook tile_speed_;
    hooks::Hook apply_;

    /// Published before either detour is enabled, and cleared after both are
    /// gone — which is what lets a detour read them without a lock, because
    /// enabling or removing a hook suspends every other thread.
    void* tile_speed_original_ = nullptr;
    void* apply_original_ = nullptr;
    std::uint32_t multiplier_at_ = 0;

    std::atomic<bool> live_{false};
    std::atomic<bool> enabled_{false};
    std::atomic<std::uint32_t> denied_{0};
};

}  // namespace brownie::game
