// Where the *client* is drawing a monster, which is not where the packets put it.
//
// **The only position that decides anything.** Bullet collision in this game is
// the client's own call: it moves its bullets, tests them against its own copy
// of the monsters, and reports the hit it has already made. So a shot lands or
// misses against these coordinates, and everything the runtime knows about
// where a monster is — parsed from `NEWTICK`, carried forward between ticks — is
// a reconstruction of them.
//
// The reconstruction is close and it is not exact: the client smooths an
// entity's motion between two server ticks, and no amount of arithmetic on this
// side can say precisely how far along that it is right now. Half of the aim was
// already the client's own — the angle is measured every frame from the live
// player object, see `PlayerControl` — and this is the other half.
//
// **Every field it reads is one the module already resolves.** An object id and
// a position live on the map-object base class, which is where the *player's*
// come from too; nothing new was needed for them. What was missing is the table
// the objects are kept in, and that is the whole of what this file adds.
//
// **Nothing here is believed on the strength of a layout.** A dictionary's
// internals are not in the game's metadata and cannot be resolved from it, so
// they are assumed — and then checked: the object a lookup ends at has to agree
// about its own id, which is the same id it was filed under. That is two
// independent readings of the same number, and a wrong stride, a wrong entry
// layout or the wrong one of the two tables fails it. A failed lookup is not an
// error; it is the caller keeping the position it already had.

#pragma once

#include <cstdint>

#include "game/Il2CppRuntime.h"
#include "game/PlayerRoute.h"

namespace brownie::game {

/// How many entries of a table are ever walked.
///
/// A realm holds a few hundred objects at most. This is well past that and is a
/// bound rather than an expectation: the length is read out of the game's own
/// memory, and a length believed without one is a loop this process does not
/// come back from.
inline constexpr std::uint32_t kMaxMapObjects = 8192;

/// Where the map objects are reached from, and where each keeps what we read.
///
/// The player's own route is the first two hops — the singleton and the world
/// manager — and is shared rather than repeated, because "which object is the
/// world" must have one answer. See `PlayerRoute.h`.
struct MapObjectRoute {
    PlayerRoute world;
    /// The two `Dictionary<int, MapObject>` fields the world manager declares.
    /// Neither name says which is which; see `kWorldObjects`.
    std::uint32_t objects_at = 0;
    std::uint32_t objects_alt_at = 0;
    /// On the map-object base class, and the same offsets the player uses.
    std::uint32_t object_id_at = 0;
    std::uint32_t x_at = 0;
    std::uint32_t y_at = 0;

    /// Whether there is enough here to try a lookup at all.
    ///
    /// The two tables are not both required: one of them is the live one and
    /// the other is checked only because nothing says which. An offset of zero
    /// is how the table reports a field it has not resolved, and a zero offset
    /// on a managed object is its class pointer — so reading one would be
    /// reading a class where a dictionary should be.
    [[nodiscard]] bool usable() const noexcept {
        return world.singleton != nullptr && world.world_manager_at != 0 &&
               (objects_at != 0 || objects_alt_at != 0) && object_id_at != 0 && x_at != 0 &&
               y_at != 0;
    }
};

/// Where the client has one object, or nothing at all.
///
/// `false` for every ordinary reason as well as every unusual one: between
/// realms there is no world, an object that has left view is not in the table,
/// and a build whose dictionaries are not laid out as assumed answers nothing
/// rather than answering wrongly. A caller that gets `false` has lost no
/// information — it still has whatever the packets told it.
///
/// **Game thread only.** Nothing here calls into managed code, so the runtime
/// cannot be corrupted by it, but the pointers walked are the game's own and
/// are only coherent while the game is not rearranging them.
[[nodiscard]] bool FindMapObject(const Il2CppRuntime& game, const MapObjectRoute& route,
                                 std::int32_t object_id, float& x, float& y) noexcept;

}  // namespace brownie::game
