#include "game/PlayerHandle.h"

#include <Windows.h>

#include "game/PlayerFields.h"

namespace brownie::game {
namespace {

/// One of the few names the obfuscator left alone, namespace and all.
///
/// The only name this file needs. Everything else it reads through is a *key*
/// into the offset table, and the names behind those keys live in one place —
/// `PlayerFields.cpp` — so a rename is edited there and nowhere else.
constexpr std::string_view kApplicationManagerNamespace = "DecaGames.RotMG.Managers";
constexpr std::string_view kApplicationManager = "ApplicationManager";

/// How far the stat block may have been moved before the search gives up.
///
/// Generous next to the distance actually seen, and small next to an object:
/// the point of the bound is that a wider search is likelier to find a number
/// by coincidence, not that the distance could not be larger.
constexpr std::uint32_t kMaxShift = 0x200;

/// How much of the player object is copied each turn.
///
/// One number for every purpose: the stats sit well inside it, the calibration
/// search needs the far end of it, and the defence hunt scans all of it. Making
/// it the same block for all three is what lets one copy serve them.
constexpr std::size_t kObjectBytes = 0x300;

// Defence is searched for across the whole copied object, and that is not
// laziness. The stat block is not merely moved, it is *rearranged*: health and
// maximum health sit at their declared offsets plus `0x50`, while the value the
// game shows as defence turned up at the offset the metadata assigns to maximum
// health. Neighbouring the declared offset is not a property the real field
// has, so searching near it finds nothing.
//
// What keeps that a measurement rather than a coincidence is the requirement
// that the value occur exactly once. In the object that prompted this, a
// defence of 35 appeared once in 768 bytes.

/// Copies one resolved offset out of the table, or reports that it is not there
/// yet. Done during preparation only — never on the read path, where a lookup
/// by key is a linear scan and a string comparison per entry.
[[nodiscard]] bool Take(const OffsetTable& offsets, std::string_view key, std::uint32_t& out) {
    const auto offset = offsets.FieldOffset(key);
    if (!offset.has_value()) {
        return false;
    }
    out = *offset;
    return true;
}

}  // namespace

bool PlayerHandle::Prepare(const Il2CppRuntime& game, const OffsetTable& offsets) {
    const auto manager_class = game.FindClass(kApplicationManagerNamespace, kApplicationManager);
    if (!manager_class.has_value()) {
        // Lazily registered like everything else: absent before the game has
        // made one, which is not the same as absent.
        trouble_ = "no ApplicationManager class yet";
        return false;
    }

    // The type to look for, taken from the class just resolved rather than
    // spelled out. A field's declared type comes back fully qualified, so a
    // bare literal would never match — which is exactly why an earlier version
    // of this search found nothing on a base class that did hold the instance.
    const std::string wanted = game.ClassName(*manager_class);

    // A singleton is a class holding an instance of itself in a static field.
    // That shape is enough to find it without knowing the name, and nothing
    // knows the name. Base classes are searched too, and that is the usual
    // case: `class Foo : Singleton<Foo>` puts the instance on the generic base,
    // and `Fields` returns a class's own fields only.
    std::string chain;
    for (auto klass = manager_class; klass.has_value(); klass = game.BaseClass(*klass)) {
        for (const auto& field : game.Fields(*klass)) {
            if (!field.is_static || field.type_name != wanted) {
                continue;
            }
            if (const auto found = game.FindStaticField(*klass, field.name)) {
                singleton_ = *found;
            }
            break;
        }
        if (singleton_ != nullptr) {
            break;
        }
        // Recorded as it goes, so a failure says where it looked. "Not found"
        // that does not say where ends the conversation rather than starting
        // the next one.
        if (!chain.empty()) {
            chain.append(" -> ");
        }
        chain.append(game.ClassName(*klass));
    }
    if (singleton_ == nullptr) {
        trouble_ = "no static instance along " + chain;
        return false;
    }

    // Every key turned into a number here, so that the read path never does a
    // lookup: `FieldOffset` is a linear scan with a string comparison per
    // entry, and there are eight of them.
    if (!Take(offsets, kWorldManager, world_manager_at_) ||
        !Take(offsets, kLocalPlayer, local_player_at_) || !Take(offsets, kPlayerHp, hp_at_) ||
        !Take(offsets, kPlayerMaxHp, max_hp_at_) ||
        !Take(offsets, kPlayerDefense, declared_defense_at_) || !Take(offsets, kPlayerX, x_at_) ||
        !Take(offsets, kPlayerY, y_at_)) {
        trouble_ = "waiting on an offset that has not resolved yet";
        return false;
    }

    prepared_ = true;
    return true;
}

PlayerReading PlayerHandle::Read(const Il2CppRuntime& game, const OffsetTable& offsets,
                                 const KnownFromServer& known) {
    // The one branch that matters for cost. Everything above this line happens
    // once; everything below is eight reads.
    if (!prepared_ && !Prepare(game, offsets)) {
        return {};
    }

    void* manager = game.ReadStaticReference(singleton_);
    if (manager == nullptr) {
        trouble_ = "the ApplicationManager singleton is not built yet";
        return {};
    }

    void* world = nullptr;
    if (!ReadField(manager, world_manager_at_, world) || world == nullptr) {
        // Null between realms and while a map is being rebuilt, which is a
        // state rather than a fault.
        trouble_ = "no world right now";
        return {};
    }

    void* player = nullptr;
    if (!ReadField(world, local_player_at_, player) || player == nullptr) {
        trouble_ = "no local player right now";
        return {};
    }

    // One copy, then everything below reads out of it. The stats, the
    // calibration search and the hunt for defence all work on these bytes, so
    // none of them costs a system call of its own.
    if (!Snap(player)) {
        trouble_ = "the player went away mid-read";
        return {};
    }

    PlayerReading reading;

    // The position lives on the base class, which the anti-tamper leaves alone,
    // so it is read where the metadata said it was.
    if (!At(x_at_, reading.x) || !At(y_at_, reading.y)) {
        trouble_ = "the position is outside the object";
        return {};
    }

    if (!shift_.has_value() && !Calibrate(known)) {
        trouble_ = known.max_hp == 0
                       ? "waiting for the server to say what health to look for"
                       : "cannot tell where the stat block was moved to";
        // The position is still worth having: it is right, and the calibration
        // proves nothing about it either way.
        reading.known = true;
        return reading;
    }

    // The stats are on the class the anti-tamper does move, so they are read at
    // the measured distance from what the metadata reported.
    if (!At(hp_at_ + *shift_, reading.hp) || !At(max_hp_at_ + *shift_, reading.max_hp)) {
        trouble_ = "the stats are outside the object";
        return {};
    }

    if (!defense_at_.has_value()) {
        FindDefense(known);
    }
    if (defense_at_.has_value()) {
        reading.defense_known = At(*defense_at_, reading.defense);

        // Held only while it keeps agreeing. This offset was found by matching
        // a value rather than by name, so it is the one most likely to be a
        // coincidence that held for a while — and the check that found it is
        // the same one that can take it away.
        if (reading.defense_known && known.defense_known && reading.defense != known.defense) {
            defense_at_.reset();
            reading.defense_known = false;
        }
    }

    reading.known = true;
    trouble_.clear();
    return reading;
}

std::optional<PlayerRoute> PlayerHandle::Route() const {
    if (!prepared_) {
        return std::nullopt;
    }
    return PlayerRoute{singleton_, world_manager_at_, local_player_at_, x_at_, y_at_};
}

bool PlayerHandle::Snap(const void* player) {
    object_.resize(kObjectBytes);
    SIZE_T read = 0;
    // One call for the whole object. `ReadProcessMemory` fills what it can and
    // reports how much, so an object shorter than asked for is a short copy
    // rather than a fault — and `At` then refuses anything past the end.
    const BOOL ok = ::ReadProcessMemory(::GetCurrentProcess(), player, object_.data(),
                                        object_.size(), &read);
    object_.resize(ok != 0 ? read : 0);
    return !object_.empty();
}

std::vector<std::byte> PlayerHandle::Snapshot(const Il2CppRuntime& game,
                                              const OffsetTable& offsets) {
    std::vector<std::byte> out;
    if (!prepared_ && !Prepare(game, offsets)) {
        return out;
    }

    const auto route = Route();
    if (!route.has_value()) {
        return out;
    }
    void* player = FindPlayer(game, *route);
    if (player == nullptr) {
        return out;
    }
    if (!Snap(player)) {
        return out;
    }
    return object_;
}

void PlayerHandle::FindDefense(const KnownFromServer& known) {
    // Zero would match every untouched word in the object, so it cannot be the
    // value searched for. A character wearing nothing simply waits.
    if (!known.defense_known || known.defense <= 0) {
        return;
    }
    // A search that failed for a value fails for it again. Not repeated until
    // the value changes — putting on armour, or a different character — which
    // is the only thing that could make it come out differently.
    if (defense_searched_for_ == known.defense) {
        return;
    }
    defense_searched_for_ = known.defense;

    std::optional<std::uint32_t> found;
    for (std::size_t at = 0; at + sizeof(std::int32_t) <= object_.size();
         at += sizeof(std::int32_t)) {
        std::int32_t value = 0;
        if (!At(at, value) || value != known.defense) {
            continue;
        }
        if (found.has_value()) {
            // Two words hold it, so neither is identified. Nothing is taken.
            return;
        }
        found = static_cast<std::uint32_t>(at);
    }
    defense_at_ = found;
}

bool PlayerHandle::Calibrate(const KnownFromServer& known) {
    // Nothing to calibrate against until a session has said what to expect.
    if (known.max_hp <= 0 || known.hp < 0) {
        return false;
    }

    std::optional<std::uint32_t> found;
    for (std::uint32_t distance = 0; distance <= kMaxShift; distance += sizeof(std::int32_t)) {
        std::int32_t hp = 0;
        std::int32_t max_hp = 0;
        if (!At(hp_at_ + distance, hp) || !At(max_hp_at_ + distance, max_hp)) {
            continue;
        }
        if (hp != known.hp || max_hp != known.max_hp) {
            continue;
        }
        if (found.has_value()) {
            // Two distances fit. Neither is proven, so neither is taken.
            return false;
        }
        found = distance;
    }

    shift_ = found;
    return found.has_value();
}

}  // namespace brownie::game
