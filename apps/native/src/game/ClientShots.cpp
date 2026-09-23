#include "game/ClientShots.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <utility>

namespace brownie::game {
namespace {

/// How much of a shot one read may cover.
///
/// Every field read here sits between the start position and the radius, a
/// little under two hundred bytes apart in the build this was written against.
/// A span wider than this is offsets that do not describe one object, and is
/// refused rather than read.
constexpr std::size_t kShotBlockBytes = 0x200;

/// How much of an object's start is read to learn what it is: its class
/// pointer, and — a little further in — its own id.
constexpr std::size_t kHeadBytes = 0x80;

/// The furthest from the origin a believable coordinate is, in tiles.
constexpr float kMaxCoordinate = 100000.0F;

/// The widest believable shot, from its middle to its side, in tiles.
constexpr float kMaxHalfTiles = 64.0F;

/// Fibonacci hashing: spreads consecutive ids — which is how the client hands
/// them out — across the table instead of into one run.
constexpr std::uint32_t kHashMultiplier = 2654435761U;
constexpr std::uint32_t kCapacityBits = 14;
static_assert((1U << kCapacityBits) == ObjectSet::kCapacity,
              "the table's size and the bits its hash keeps must agree");

[[nodiscard]] bool Believable(float value, float limit) noexcept {
    return std::isfinite(value) && std::abs(value) <= limit;
}

/// One field out of a block that was read starting at `base`.
template <typename T>
[[nodiscard]] T FieldIn(const std::byte* block, std::uint32_t base, std::uint32_t at) noexcept {
    T value{};
    std::memcpy(&value, block + (at - base), sizeof(T));
    return value;
}

}  // namespace

bool ClientShotRoute::usable() const noexcept {
    return objects.usable() && frame_time_at != 0 && shot_class != nullptr && start_x_at != 0 &&
           start_y_at != 0 && angle_at != 0 && start_time_at != 0 && owner_at != 0 &&
           bullet_id_at != 0 && damages_players_at != 0 && speed_multiplier_at != 0 &&
           lifetime_at != 0 && radius_at != 0;
}

ObjectSet::ObjectSet() : slots_(kCapacity) { ids_.reserve(kMaxMapObjects); }

void ObjectSet::Clear() noexcept {
    ids_.clear();
    ++stamp_;
    // A stamp that has come all the way round would match slots filed four
    // billion clears ago. Once a lifetime at a hundred scans a second, and
    // cheap to answer properly.
    if (stamp_ == 0) {
        for (auto& slot : slots_) {
            slot.stamp = 0;
        }
        stamp_ = 1;
    }
}

std::uint32_t ObjectSet::SlotOf(std::int32_t object_id) const noexcept {
    return (static_cast<std::uint32_t>(object_id) * kHashMultiplier) >> (32U - kCapacityBits);
}

const ObjectSet::Member* ObjectSet::Find(std::int32_t object_id) const noexcept {
    std::uint32_t slot = SlotOf(object_id);
    for (std::uint32_t probe = 0; probe < kCapacity; ++probe) {
        const Member& member = slots_[slot];
        if (member.stamp != stamp_) {
            return nullptr;
        }
        if (member.object_id == object_id) {
            return &member;
        }
        slot = (slot + 1U) & (kCapacity - 1U);
    }
    return nullptr;
}

void ObjectSet::Insert(const Member& member) noexcept {
    std::uint32_t slot = SlotOf(member.object_id);
    for (std::uint32_t probe = 0; probe < kCapacity; ++probe) {
        Member& here = slots_[slot];
        if (here.stamp != stamp_) {
            // Full is a bound a walk of at most `kMaxMapObjects` objects cannot
            // reach; refusing past it keeps the table's probes short whatever
            // arrives.
            if (ids_.size() >= kMaxMapObjects) {
                return;
            }
            here = member;
            here.stamp = stamp_;
            ids_.push_back(member.object_id);
            return;
        }
        if (here.object_id == member.object_id) {
            const std::uint32_t stamp = here.stamp;
            here = member;
            here.stamp = stamp;
            return;
        }
        slot = (slot + 1U) & (kCapacity - 1U);
    }
}

bool ClientShotScanner::Scan(const void* world, std::int32_t frame_time_ms,
                             const ClientShotRoute& route, ShotScan& out) noexcept {
    out.born.clear();
    out.gone.clear();
    if (world == nullptr || !route.usable()) {
        Reset();
        return false;
    }
    out.frame_time_ms = frame_time_ms;

    route_ = &route;
    out_ = &out;
    classified_ = 0;
    current_.Clear();
    const bool walked = ForEachMapObject(world, route.objects, route.pending_at, *this);
    route_ = nullptr;
    out_ = nullptr;
    if (!walked) {
        // A walk that did not finish says nothing about what left: every shot
        // it did not reach would read as gone, and a live bullet the runtime
        // stops dodging is the one mistake here that costs something. Start
        // again next frame and report every shot as new then — which only
        // re-times what the runtime already has.
        Reset();
        out.born.clear();
        return false;
    }

    // **Gone once is not gone.** A shot missing from one scan is carried a scan
    // longer before it is reported, so that a table caught mid-rearrangement
    // cannot tell the runtime to forget a bullet that is still flying. A frame
    // late for a shot that really went; never early for one that did not.
    for (const std::int32_t id : previous_.ids()) {
        const ObjectSet::Member* was = previous_.Find(id);
        if (was == nullptr || was->kind != ObjectSet::Kind::kEnemyShot) {
            continue;
        }
        if (current_.Find(id) != nullptr) {
            continue;
        }
        if (was->missed == 0) {
            ObjectSet::Member kept = *was;
            kept.missed = 1;
            current_.Insert(kept);
            continue;
        }
        out.gone.push_back(GoneShot{was->owner_id, was->bullet_id});
    }
    std::swap(previous_, current_);
    return true;
}

void ClientShotScanner::Reset() noexcept {
    previous_.Clear();
    current_.Clear();
}

bool ClientShotScanner::Visit(std::int32_t object_id, const void* object) noexcept {
    if (current_.Find(object_id) != nullptr) {
        return true;
    }
    // Known from the last scan, under the same id and at the same address:
    // what it is has not changed, and asking again would be a read per object
    // per frame for an answer already in hand.
    if (const ObjectSet::Member* known = previous_.Find(object_id);
        known != nullptr && known->object == object) {
        ObjectSet::Member carried = *known;
        carried.missed = 0;
        current_.Insert(carried);
        return true;
    }
    if (classified_ >= kMaxClassifiedPerScan) {
        return true;
    }
    ++classified_;
    if (const auto member = Classify(object_id, object)) {
        current_.Insert(*member);
    }
    return true;
}

std::optional<ObjectSet::Member> ClientShotScanner::Classify(std::int32_t object_id,
                                                             const void* object) noexcept {
    const ClientShotRoute& route = *route_;
    ObjectSet::Member member;
    member.object_id = object_id;
    member.object = object;

    // **The first word of every managed object is its class**, the one piece
    // of IL2CPP's object layout this relies on — and it relies on it only to
    // compare, never to follow. A pointer that is not a map object reads as a
    // class that matches neither, which is an object that is not a shot.
    //
    // Read in the same call as the object's own id, which has to agree with
    // the id it was filed under: the check `MapObjects` rests on, and what
    // stops a table read with the wrong layout from handing over something
    // that merely looks like a shot.
    const std::uint32_t id_at = route.objects.object_id_at;
    std::array<std::byte, kHeadBytes> head{};
    if (id_at + sizeof(std::int32_t) > head.size() ||
        !ReadRaw(object, head.data(), id_at + sizeof(std::int32_t))) {
        return std::nullopt;
    }
    ClassRef klass = nullptr;
    std::memcpy(&klass, head.data(), sizeof(klass));
    std::int32_t stored_id = 0;
    std::memcpy(&stored_id, head.data() + id_at, sizeof(stored_id));
    if (stored_id != object_id) {
        return std::nullopt;
    }
    if (klass != route.shot_class &&
        (route.shot_subclass == nullptr || klass != route.shot_subclass)) {
        return member;
    }

    const std::array offsets{route.start_x_at,          route.start_y_at, route.angle_at,
                             route.start_time_at,       route.owner_at,   route.bullet_id_at,
                             route.damages_players_at,  route.speed_multiplier_at,
                             route.lifetime_at,         route.radius_at};
    std::uint32_t base = offsets[0];
    std::uint32_t end = offsets[0];
    for (const std::uint32_t at : offsets) {
        base = std::min(base, at);
        end = std::max(end, at + 4U);
    }
    if (end - base > kShotBlockBytes) {
        return member;
    }
    std::array<std::byte, kShotBlockBytes> block{};
    if (!ReadRaw(static_cast<const std::byte*>(object) + base, block.data(), end - base)) {
        return std::nullopt;
    }

    // The flag the client sets from its owner being an enemy: a shot that can
    // hurt the player. Everything else — the player's own, an ally's — is
    // remembered so it is not read again, and never reported.
    if (FieldIn<std::uint8_t>(block.data(), base, route.damages_players_at) == 0) {
        member.kind = ObjectSet::Kind::kFriendlyShot;
        return member;
    }

    ClientShot shot;
    shot.owner_id = FieldIn<std::int32_t>(block.data(), base, route.owner_at);
    const auto bullet = FieldIn<std::uint32_t>(block.data(), base, route.bullet_id_at);
    shot.bullet_id = static_cast<std::uint16_t>(bullet & 0xFFFFU);
    const auto started = FieldIn<std::int32_t>(block.data(), base, route.start_time_at);
    // Differenced as 64-bit, because both are client clock readings and a
    // garbage one must not wrap into a plausible age.
    const std::int64_t age = static_cast<std::int64_t>(out_->frame_time_ms) - started;
    shot.start_x = FieldIn<float>(block.data(), base, route.start_x_at);
    shot.start_y = FieldIn<float>(block.data(), base, route.start_y_at);
    shot.angle = FieldIn<float>(block.data(), base, route.angle_at);
    shot.speed_multiplier = FieldIn<float>(block.data(), base, route.speed_multiplier_at);
    shot.lifetime_ms = FieldIn<float>(block.data(), base, route.lifetime_at);
    shot.half_tiles = FieldIn<float>(block.data(), base, route.radius_at);

    // Filed as what it is whatever it holds, so a nonsense read is not read
    // again next frame — but only a believable one is reported.
    member.kind = ObjectSet::Kind::kEnemyShot;
    member.owner_id = shot.owner_id;
    member.bullet_id = shot.bullet_id;
    const bool believable =
        bullet <= 0xFFFFU && age >= 0 && age <= 600000 &&
        Believable(shot.start_x, kMaxCoordinate) && Believable(shot.start_y, kMaxCoordinate) &&
        Believable(shot.angle, 1000.0F) && Believable(shot.speed_multiplier, 100.0F) &&
        shot.speed_multiplier > 0.0F && Believable(shot.lifetime_ms, 600000.0F) &&
        shot.lifetime_ms > 0.0F && Believable(shot.half_tiles, kMaxHalfTiles) &&
        shot.half_tiles >= 0.0F;
    if (believable) {
        shot.age_ms = static_cast<std::int32_t>(age);
        out_->born.push_back(shot);
    }
    return member;
}

}  // namespace brownie::game
