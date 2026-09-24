// The player's ability key: pressed for them, and pointed for them.
//
// **The client's own ability code, called and intercepted — never imitated with
// a packet.** The key calls one method on the local player with the cursor and
// a press phase, and everything the server hears about an ability comes out of
// that call: the checks the client makes first (silenced, paralysed, on
// cooldown, out of mana, somewhere abilities are not allowed), the `USEITEM`
// stamped with its own clock and its own ability-switch index, the shots an
// item with projectiles fires behind it, and the cooldown and mana it then
// charges itself. A `USEITEM` written by the proxy skipped all of that. The
// server saw uses the client had refused, uses with no shots behind them, and a
// second use a moment after the first because the client never knew the first
// had happened — and ended the session over it.
//
// So there are two things here, and both go through the same method:
//
//   * `Cast` calls it, as the key does on the way down with the cursor at a
//     point the runtime chose. **Game thread only.**
//   * A detour points the presses the *player* makes: while an aim stands, a
//     press on the way down is handed the aimed point in place of the cursor,
//     and the client builds the use, the shots and the cooldown from that point
//     exactly as it would have from the mouse.
//
// **Only the way down.** The key calls again on the way up, which only an
// ability held down acts on — and the runtime never aims one of those, since
// the second call is where it ends and a held ability is never automatic.
//
// **Coordinates are the game's.** The method takes the engine's, which run the
// other way on Y — see `ScreenProjection.cpp` — and this class flips them, so
// nothing outside it has to know.
//
// **The detour does no work**, for the reason `AimHook.h` gives: it runs inside
// the game's own input path, so it is two atomic loads, a comparison and a
// store — no lock, no allocation, no system call.

#pragma once

#include <atomic>
#include <cstdint>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::game {

/// What the ability method is told about the press. This build names the
/// enumeration `ELAINNINAMO`; its values are the game's.
enum class AbilityPress : std::int32_t {
    kDefault = 0,
    /// The key went down. The only one that uses an ordinary ability.
    kStartUse = 1,
    /// The key came up. Ends an ability that is held down; nothing else.
    kEndUse = 2,
};

/// The engine's Y for a place on the game's map, and back: the same flip.
[[nodiscard]] constexpr float EngineY(float map_y) noexcept {
    return -map_y;
}

class PlayerAbility {
  public:
    PlayerAbility() noexcept = default;

    PlayerAbility(const PlayerAbility&) = delete;
    PlayerAbility& operator=(const PlayerAbility&) = delete;
    PlayerAbility(PlayerAbility&&) = delete;
    PlayerAbility& operator=(PlayerAbility&&) = delete;

    /// Removes the detour. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~PlayerAbility();

    /// Publishes the game's ability method. **IPC thread**, and write-once for
    /// the reason `PlayerMover::Bind` gives: a frame reads it without a lock.
    void Bind(void* use_ability) noexcept;

    [[nodiscard]] bool bound() const noexcept { return ready_.load(std::memory_order_acquire); }

    /// Puts the detour that points the player's own presses in place. **IPC
    /// thread.** A no-op once it is, and refused until the method is bound.
    ///
    /// Only one may exist per process, for the reason `AimHook::Install` gives:
    /// a detour is a C callback with nowhere to carry a `this`.
    Status InstallAim();

    /// Removes the detour. Safe to call more than once.
    void Remove() noexcept;

    [[nodiscard]] bool aim_installed() const noexcept { return hook_.installed(); }

    /// Points the player's own presses at a place on the map until
    /// `expires_at_ms`. Any thread.
    void Aim(float x, float y, std::uint64_t expires_at_ms) noexcept;

    /// Stops pointing them. The cursor is the player's again at once.
    void ClearAim() noexcept;

    /// Uses the ability at a place on the map, as the key would with the cursor
    /// there. **Game thread only**: it is a call into managed code.
    ///
    /// Not pointed by an aim that stands — this is a press of the runtime's own,
    /// aimed where the runtime chose, and the two can differ: an attack fired at
    /// a boss while the player's own presses go to the minion in front of it.
    ///
    /// @param player The local player, found this frame.
    /// @returns what the game answered: whether it used the ability. False as
    ///   well when nothing is bound or the point is not a number.
    bool Cast(void* player, float x, float y);

    /// How many of the player's presses have been pointed. Written by the
    /// game's thread, read by any.
    [[nodiscard]] std::uint32_t redirected() const noexcept {
        return redirected_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detour in PlayerAbility.cpp. Public because a free
    // --- function cannot be a friend of a class it does not know about.

    /// Where a press made right now should land, on the game's map, or nothing.
    [[nodiscard]] bool AimFor(float& x, float& y) noexcept;

    /// Whether the call running now is {@link Cast}'s own. **Game thread.**
    [[nodiscard]] bool casting() const noexcept { return casting_; }

    /// The code the detour replaced, to call through to. Null until the detour
    /// is in place, which a detour that is not in place cannot observe.
    [[nodiscard]] void* original() const noexcept { return original_; }

  private:
    void* use_ability_ = nullptr;
    std::atomic<bool> ready_{false};

    hooks::Hook hook_;
    void* original_ = nullptr;

    /// Set for the length of {@link Cast}'s own call, so the detour lets it
    /// through untouched.
    ///
    /// **A plain flag, because only one thread ever reads or writes it**: the
    /// game calls this method from its input handling and `Cast` runs inside
    /// the frame, and those are the same thread — the one thread this module
    /// calls into the game from at all. See `docs/architecture.md`.
    bool casting_ = false;

    /// The aimed point, both halves in one word, so a press can never take one
    /// coordinate from one aim and the other from the next.
    std::atomic<std::uint64_t> point_{0};
    /// Zero while nothing is aimed. Stored last and with a release, so a press
    /// that sees a deadline sees the point that came with it.
    std::atomic<std::uint64_t> expires_at_ms_{0};
    std::atomic<std::uint32_t> redirected_{0};
};

}  // namespace brownie::game
