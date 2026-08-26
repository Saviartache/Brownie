// What the projectile features need to find, and where it lives.
//
// The counterpart of `PlayerFields.h` for the things a *shot* is made of: the
// tick and the wall check, the two flags that say who a shot is allowed to
// hurt, the square it stands on, and the one number that decides what it can
// overlap. Same rules as the player's queries — obfuscated names carried with
// their signatures, every answer resolved from the game that is running, and no
// constant anywhere.
//
// Two features read this table and they want different halves of it:
// `ProjectileNoclip.h` lets the player's own shots cross walls, and
// `ProjectileShield.h` takes the hitbox off the shots aimed at the player.
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

/// The projectile's per-tick update, `bool Update(int time, int dt)`.
///
/// **The key is named for what the reference implementation thought it was.**
/// It is declared `virtual` on the class every map object derives from and
/// overridden by the game object and the projectile alike, which no wall check
/// would be; the projectile's override is where the shot moves, asks the square
/// below about walls, and runs the hit scan. The string is left alone because
/// it is only an identity in the table and the overlay's health report prints
/// it — what it *is* is written here.
///
/// **Detoured, never called**: it is where the wall verdict is acted on, and
/// the detour is what puts back what the inner one changed. See
/// `ProjectileNoclip.h`.
inline constexpr std::string_view kShotHitsWall = "shot.hitsWall";

/// `bool HitsWall(int tileX, int tileY)` — the projectile's own wall check,
/// which the tick above calls to ask the square itself. Also detoured, and it
/// is the one that acts. Declared only on the projectile, which is the evidence
/// that this is the wall check and the key above is not.
inline constexpr std::string_view kShotTileBlocks = "shot.tileBlocks";

/// Who a shot is allowed to hurt — two adjacent bytes, and they are opposites.
///
/// **Proven, where the previous reading was a guess.** The projectile's
/// initialiser sets them together off the owner's own descriptor:
///
/// ```text
/// damagesPlayers = owner.isEnemy
/// damagesEnemies = !owner.isEnemy
/// ```
///
/// so a monster's shot carries the first and the player's own carries the
/// second, and never both. The reference implementation read the second as "I
/// am in flight" and this project carried that on as `shot.active`; it is the
/// same byte and — for projectile noclip, which wants exactly the player's own
/// shots — it guards the same set. The name was still wrong, and with its
/// neighbour now in the table beside it, wrong in a way that would mislead.
///
/// Both are read into the Burst job that scans for a target, so writing either
/// changes who the very next scan considers. See `ProjectileShield.h`.
inline constexpr std::string_view kShotDamagesPlayers = "shot.damagesPlayers";
inline constexpr std::string_view kShotDamagesEnemies = "shot.damagesEnemies";

/// The half-side of the square a shot is tested by, in tiles.
///
/// The game's collision test is Chebyshev — `|dx| < r && |dy| < r` — and this
/// is `r`. The initialiser writes `CollisionMult × 0.5` into it off the shot's
/// own properties, which is the same number `features/dodge/hitbox.ts` computes
/// out of `objects.xml` without being in the process.
///
/// **Nought is a shot nothing can ever overlap**, because the test is a strict
/// `<` on both axes: at `r = 0` even a dead-centre hit fails. That is not an
/// edge case the game would trip over either — sixty-odd of its own projectiles
/// declare a collision multiplier of nought and fly through everything.
inline constexpr std::string_view kShotCollisionHalf = "shot.collisionHalf";

/// The projectile's initialiser, and the one place every shot passes through.
///
/// Twelve parameters, returning the projectile it just built. Projectiles are
/// pooled, so this runs again on every reuse — which is what makes a write made
/// here need no undoing: the game puts its own number back the next time the
/// shot is fired. See `ProjectileShield.h`, which detours it.
inline constexpr std::string_view kShotInit = "shot.init";

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
