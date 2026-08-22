// The local player, found and read.
//
// Offsets are useless without an object to apply them to, and the object is
// three hops away:
//
//     ApplicationManager  (a singleton, in a static field of a base class)
//       -> WorldManager   (`<CHDFAEBMILI>k__BackingField`)
//         -> local player (`OCLNLBHDEFK`)
//
// **Everything expensive happens once.** Finding the class, finding the static
// field that holds the singleton, turning eight keys into eight offsets and
// working out where the anti-tamper moved the stat block are all one-time work,
// and all of it is cached the moment it succeeds. What is left runs on a loop:
// eight reads and nothing else — no metadata lookup, no field enumeration, no
// string built, nothing allocated.
//
// That distinction is the whole design of this file. The first version did the
// lot every turn: a class lookup, a full walk of every field the class declares
// to find one of them by name, a fully-qualified class name assembled into a
// fresh `std::string`, and three separate attachments to the garbage collector.
// Four times a second, to read six numbers that were already in hand.
//
// **Reads go through `ReadProcessMemory`, on our own process.** A stale pointer
// is not hypothetical here — the chain goes null between realms, on death and
// while a map is being rebuilt, and a direct dereference of one would take the
// game down with us. `ReadProcessMemory` returns false where a dereference
// would fault. The reference implementation used structured exception handling;
// that is unavailable under this toolchain, and a syscall costing a microsecond
// eight times a second is not worth arguing about.
//
// **The singleton is discovered, not named.** Which static field holds it is
// not knowable from the reference implementation — it went round the problem
// with a Unity scan of every object in the scene, rate-limited to once every
// five seconds because of what that costs. Instead this looks for a static
// field of the class's own type, which is what a singleton is. The search
// includes base classes, because Unity's singletons are written
// `class Foo : Singleton<Foo>` and the instance then lives on the generic base.

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

#include "game/Il2CppRuntime.h"
#include "game/OffsetTable.h"
#include "game/PlayerRoute.h"

namespace brownie::game {

/// What the module can see of the player without asking the server.
struct PlayerReading {
    bool known = false;
    std::int32_t hp = 0;
    std::int32_t max_hp = 0;
    /// Separate from the value, because the field the metadata calls defence
    /// turned out not to hold it — see `FindDefense`. Until one is located that
    /// does, there is no defence to report, and reporting zero would be a claim
    /// nobody made.
    bool defense_known = false;
    std::int32_t defense = 0;
    float x = 0.0F;
    float y = 0.0F;
};

/// What the server has said, for the reader to check itself against.
///
/// Zero when there is no session, which is also when calibration cannot happen.
struct KnownFromServer {
    std::int32_t hp = 0;
    std::int32_t max_hp = 0;
    /// Zero is a legitimate defence, so it cannot double as "not said".
    bool defense_known = false;
    std::int32_t defense = 0;
};

class PlayerHandle {
  public:
    /// Walks the chain and reads the player.
    ///
    /// Eight reads once everything below is settled. Safe to call on a loop —
    /// and the pointers are re-walked every time rather than cached, because a
    /// pointer held across a realm change points at memory that has been given
    /// back. Only the *answers about the game's shape* are cached; nothing
    /// about the game's current state is.
    PlayerReading Read(const Il2CppRuntime& game, const OffsetTable& offsets,
                       const KnownFromServer& known);

    /// Copies the player object out, for looking at.
    ///
    /// **A diagnostic, and it runs only when a button is pressed.** It exists
    /// because a field can resolve, sit exactly where the class layout says,
    /// and still not hold what its name claims — at which point the only way
    /// forward is to look at the object beside a value the server has already
    /// given. Empty when there is no player, or when nothing is prepared yet.
    [[nodiscard]] std::vector<std::byte> Snapshot(const Il2CppRuntime& game,
                                                  const OffsetTable& offsets);

    /// The route to the player, for something that must walk it on another
    /// thread — see `PlayerMover` and `AimHook`. Empty until the one-time
    /// preparation has succeeded, which is also when the route stops changing.
    [[nodiscard]] std::optional<PlayerRoute> Route() const;

    /// The distance between where the metadata says the stat fields are and
    /// where they turned out to be, or nothing while that is unknown.
    ///
    /// **Measured, never assumed.** The game's anti-tamper moves the stat block
    /// away from the offsets IL2CPP reports, and the reference implementation
    /// carried the distance as a constant — a number that is right until the
    /// day it silently is not.
    [[nodiscard]] std::optional<std::uint32_t> shift() const noexcept { return shift_; }

    /// Why the last read found nothing, for the overlay to show. Empty once it
    /// is working.
    [[nodiscard]] const std::string& trouble() const noexcept { return trouble_; }

  private:
    /// Copies the player object into {@link object_} in a single call.
    ///
    /// **One syscall per turn, whatever is being looked for.** Everything below
    /// — the stats, the calibration search, the hunt for defence — then reads
    /// out of that copy rather than out of the game. The first version read a
    /// word at a time, which made calibration 256 system calls and the defence
    /// search 192, four times a second, for as long as either failed to settle.
    [[nodiscard]] bool Snap(const void* player);

    /// One value out of the copy. No syscall, no bounds surprise: a read past
    /// the end fails rather than returning whatever followed it.
    template <typename T>
    [[nodiscard]] bool At(std::size_t offset, T& out) const noexcept {
        if (offset + sizeof(T) > object_.size()) {
            return false;
        }
        std::memcpy(&out, object_.data() + offset, sizeof(T));
        return true;
    }

    /// Everything about the game's shape, resolved once.
    ///
    /// @returns false while some of it is still unavailable, which early in a
    ///   run is the ordinary case: IL2CPP registers classes lazily and the
    ///   offset table fills in as they appear.
    bool Prepare(const Il2CppRuntime& game, const OffsetTable& offsets);

    /// Finds the distance the stat block has been moved, from two values the
    /// server has already told us.
    ///
    /// Searches a bounded window for the one distance at which *both* health
    /// and maximum health read back what the server said. Two values rather
    /// than one because a single number turns up in memory by coincidence all
    /// the time; two at a fixed distance from each other, both matching, do
    /// not. More than one candidate is a refusal, not a choice — the same rule
    /// the offset table applies to an ambiguous fingerprint.
    bool Calibrate(const KnownFromServer& known);

    /// Locates defence, which is not where the metadata says it is.
    ///
    /// The field the reference implementation names as defence resolves, sits
    /// exactly where the stat block's own layout says it should, and reads zero
    /// while the game's own screen shows 35. The offset is not wrong; the field
    /// is not the one it is taken for.
    ///
    /// So it is found the same way the displacement was: by looking for the
    /// value the server already gave us, and accepting only a single candidate.
    /// A small number turns up in memory readily, which is exactly why one
    /// match is required rather than the first of several.
    void FindDefense(const KnownFromServer& known);

    std::optional<std::uint32_t> defense_at_;
    /// The defence last searched for. A search that failed for a value will
    /// fail for it again, so it is not repeated until the value changes — which
    /// is the only event that could make it succeed.
    std::optional<std::int32_t> defense_searched_for_;

    /// The player object, copied once a turn and read many times. Held as a
    /// member so the copy costs no allocation after the first.
    std::vector<std::byte> object_;

    /// The one-time answers. Once `prepared_` is set, `Read` touches no
    /// metadata at all.
    bool prepared_ = false;
    Il2CppRuntime::StaticFieldRef singleton_ = nullptr;
    std::uint32_t world_manager_at_ = 0;
    std::uint32_t local_player_at_ = 0;
    std::uint32_t hp_at_ = 0;
    std::uint32_t max_hp_at_ = 0;
    /// Where the metadata says defence is. Kept as the centre of the search
    /// for where it actually is, and never read from directly.
    std::uint32_t declared_defense_at_ = 0;
    std::uint32_t x_at_ = 0;
    std::uint32_t y_at_ = 0;

    std::optional<std::uint32_t> shift_;
    std::string trouble_ = "not looked yet";
};

}  // namespace brownie::game
