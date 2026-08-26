// What a projectile shield does to a shot, as a value and nothing else.
//
// Its own header because two layers need the choice and only one of them needs
// the machinery: `game::ProjectileShield` acts on it, and the overlay's status
// line says which of the three is happening. A panel that had to include the
// hooking header to name a mode would be the overlay's first dependency on the
// game layer, bought for an enumeration — so the enumeration is a leaf, and
// what includes it takes on nothing else.

#pragma once

#include <cstdint>

namespace brownie::game {

/// What a shield does to a shot that is allowed to hurt players.
///
/// The three are not variations on one thing. Two of them are silent — a shot
/// that finds nobody is a shot the client has nothing to report — and the third
/// makes the client say something it otherwise never would. See
/// `ProjectileShield.h` for what each writes and `shotShieldPlugin.ts` for what
/// each costs.
enum class ShieldMode : std::uint8_t {
    /// Nothing. The detour forwards and reads one atomic.
    Off,
    /// Scale the shot's collision square. At a multiplier of nought the shot
    /// keeps its flight, its look and its lifetime and can overlap nothing.
    Shrink,
    /// Clear `damagesPlayers`, leaving the shot's size alone. The hit scan then
    /// looks for nobody: not the player, and not the players standing next to
    /// them either.
    Disarm,
    /// Clear `damagesPlayers` and set `damagesEnemies`, so a monster's shot
    /// scans for monsters.
    ///
    /// **This one talks to the server and the other two do not.** A shot that
    /// finds a monster is a hit the client reports, naming a bullet the server
    /// knows belongs to that same monster — which is not a sentence the client
    /// would ever otherwise say. Nothing in this project has seen how this
    /// build's server answers it, and the two answers it has for a packet it
    /// dislikes are an empty `FAILURE` and a closed connection. Off by default,
    /// behind its own choice, and documented as the risky one in the plugin
    /// that offers it.
    Redirect,
};

}  // namespace brownie::game
