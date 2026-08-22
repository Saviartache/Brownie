// What projectile noclip needs to find, and where it lives.
//
// The counterpart of `PlayerFields.h` for the things a *shot* is made of: the
// two methods the client asks "is there a wall here", the flag that says a
// projectile is in flight, and the two hops from a projectile to the collision
// layer of the square it is standing on. Same rules as the player's queries —
// obfuscated names carried with their signatures, every answer resolved from
// the game that is running, and no constant anywhere.
//
// **The reference implementation kept fallback offsets for two of these three
// fields**, and used them whenever the lookup failed. That is the failure mode
// this project exists to remove: after a game patch the feature would not stop,
// it would write `37` at a stale offset inside a live tile — so nothing here
// falls back, and a field that does not resolve leaves the whole feature off.
//
// **Nothing here resolves until a shot has been fired.** IL2CPP registers a
// class the first time the game needs one, and the game does not need a
// projectile until something shoots — so an unresolved key during the menu is
// the ordinary case, indistinguishable from a rename, and only a key still
// missing after real play means anything. See `OffsetTable.h`.

#pragma once

#include <cstddef>
#include <string_view>

#include "game/OffsetTable.h"

namespace brownie::game {

/// `bool HitsWall(int tileX, int tileY)` on the projectile — the per-tick check
/// that ends a shot against a wall. **Detoured, never called**: it is where the
/// verdict is reached, and the detour is what puts back what the inner one
/// changed. See `ProjectileNoclip.h`.
inline constexpr std::string_view kShotHitsWall = "shot.hitsWall";

/// `bool TileBlocks(int tileX, int tileY)`, which the method above calls to ask
/// the square itself. Also detoured, and it is the one that acts.
inline constexpr std::string_view kShotTileBlocks = "shot.tileBlocks";

/// The projectile's own "I am in flight" flag.
///
/// The guard on everything the detours do: a shot that is not in flight is not
/// a shot whose square anything should be changed for. The meaning is the
/// reference implementation's — the name says nothing and the metadata's name
/// table is encrypted — so it is used as a guard and never as a fact.
inline constexpr std::string_view kShotActive = "shot.active";

/// The square a map object is standing on, and that square's collision layer.
///
/// The first is declared on the class every map object derives from, which is
/// the same class the player's own position comes off; the second is on the
/// square. Together they are the two hops from a shot to the one number that
/// decides whether it stops.
inline constexpr std::string_view kMapObjectTile = "map.MapObject.tile";
inline constexpr std::string_view kTileCollisionLayer = "map.Tile.collisionLayer";

/// Resolves whatever is still missing, and is cheap once nothing is.
///
/// Called on every turn of the loop, like the player's and the scene's: the
/// classes here appear later than any of those, and a turn that finds nothing
/// is the ordinary state until somebody shoots.
///
/// @returns how many keys resolved on this call.
std::size_t ResolveProjectileMethods(OffsetTable& table);
std::size_t ResolveProjectileFields(OffsetTable& table);

}  // namespace brownie::game
