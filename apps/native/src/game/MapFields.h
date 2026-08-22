// What player noclip needs to find, and where it lives.
//
// One class and every predicate of one shape on it: the world manager's
// `bool(float, float)` methods, which is what the client asks before it lets
// the player stand somewhere.
//
// **Every one of them, found by enumerating the class — not a list of names.**
// The reference implementation carried seven obfuscated names, forced two of
// them and left the other five counting calls, so that a live run could say
// which one is the real gate. It never said, and a live run here showed why the
// list was no good: of its two forced names one is never called at all, and of
// the nine predicates this build declares only three are. Taking the shape
// takes whichever three those are, in this build and the next.
//
// So the shape is the query. That is normally the thing this project refuses —
// see `MethodQuery::fingerprint` — and the reason it refuses is that a method
// picked by shape is *called* through a prototype that may not describe it.
// That reason does not apply when the shape is what is wanted: these are taken
// as a set, every member of it has the same prototype by construction, and
// nothing is picked. A rename changes nothing here, and a build that adds an
// eighth gets it hooked.
//
// **Each is counted separately**, which is the half of the reference's design
// worth keeping: a predicate nobody calls is not the gate, and the counters are
// what say so from a live run instead of from an argument.

#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include "game/Metadata.h"
#include "game/OffsetTable.h"

namespace brownie::game {

/// One walkability predicate: the name the build gave it, and where it is.
struct WalkabilityPredicate {
    std::string name;
    void* address = nullptr;
};

/// How many are taken. Well past the seven the reference implementation listed,
/// and a bound rather than an expectation — a class that answers with more than
/// this is one to look at by hand, not one to hook the whole of.
inline constexpr std::size_t kMaxWalkabilityPredicates = 16;

/// Every `bool (float, float)` the world manager declares, with each registered
/// in `table` under `map.walkable.<name>` so the overlay's report names them in
/// the order the hooks go on.
///
/// @returns them, or nothing at all — the ordinary answer until the game has
///   built a realm, so a caller asks again rather than giving up.
[[nodiscard]] std::vector<WalkabilityPredicate> ResolveWalkabilityPredicates(
    const MetadataSource& source, OffsetTable& table);

}  // namespace brownie::game
