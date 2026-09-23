// What the client made of every enemy shot, read off the shots themselves.
//
// **The runtime reconstructs a shot from its announcement; this is the shot.**
// `ENEMYSHOOT` says where a volley starts and which way, and the runtime runs
// the game's own motion model forward from the moment the packet passed through
// it. Three things about that are guesses the client does not have to make:
// when the client actually started the shot's clock, what its owner's
// multipliers made of its speed and life, and how big its collision square is.
// The client wrote all three into the shot when it spawned it, and never
// touches them again — so they are read here, once, the first frame a shot is
// seen, and handed across.
//
// **And the one thing no packet ever says: that a shot is gone.** A bullet the
// client destroyed against a wall, a pillar, a player or the end of its life is
// removed from the world's tables the frame it happens. Every shot that was
// there last frame and is not there now is reported as gone, which is what lets
// the runtime stop dodging a bullet the moment it stops existing rather than
// when its lifetime says it should have.
//
// **Nothing here is believed on the strength of a layout, again.** The tables
// are walked by `MapObjects`, which checks every object against its own id; a
// shot is recognised by its class pointer matching one of the two projectile
// classes exactly — never by asking the runtime what an arbitrary pointer is,
// which would dereference it — and every field is read through `ReadRaw` in one
// block, from offsets the game itself resolved by name.

#pragma once

#include <cstdint>
#include <optional>
#include <vector>

#include "game/Il2CppRuntime.h"
#include "game/MapObjects.h"

namespace brownie::game {

/// Where the client keeps its shots, and where each one keeps what is read.
struct ClientShotRoute {
    /// The world manager, its two object tables and a map object's own id.
    MapObjectRoute objects;
    /// The world manager's list of objects made and not yet filed.
    std::uint32_t pending_at = 0;
    /// The world manager's frame clock. See `kWorldFrameTime`.
    std::uint32_t frame_time_at = 0;
    /// The projectile class, and the pooled subclass nearly every shot is an
    /// instance of. Compared as pointers and never dereferenced.
    ClassRef shot_class = nullptr;
    ClassRef shot_subclass = nullptr;

    std::uint32_t start_x_at = 0;
    std::uint32_t start_y_at = 0;
    std::uint32_t angle_at = 0;
    std::uint32_t start_time_at = 0;
    std::uint32_t owner_at = 0;
    std::uint32_t bullet_id_at = 0;
    std::uint32_t damages_players_at = 0;
    std::uint32_t speed_multiplier_at = 0;
    std::uint32_t lifetime_at = 0;
    std::uint32_t radius_at = 0;

    /// Whether everything a scan reads has been found. An offset of nought is
    /// how the table reports a field it has not resolved, and on a managed
    /// object it is the class pointer — so none of them may be nought.
    [[nodiscard]] bool usable() const noexcept;
};

/// One enemy shot, as the client spawned it.
struct ClientShot {
    std::int32_t owner_id = 0;
    /// The client's number for it — what every acknowledgement it sends names.
    std::uint16_t bullet_id = 0;
    /// How long ago the client started it, on its own frame clock.
    std::int32_t age_ms = 0;
    float start_x = 0.0F;
    float start_y = 0.0F;
    /// Radians.
    float angle = 0.0F;
    float speed_multiplier = 1.0F;
    /// How long it lives, the owner's multiplier already applied.
    float lifetime_ms = 0.0F;
    /// Half the side of its collision square, in tiles.
    float half_tiles = 0.0F;
};

/// An enemy shot that was there and is not any more.
struct GoneShot {
    std::int32_t owner_id = 0;
    std::uint16_t bullet_id = 0;
};

/// What one scan found. Reused from scan to scan; nothing in it allocates once
/// it has grown to the busiest screen the session has seen.
struct ShotScan {
    /// The client's frame clock when it was taken.
    std::int32_t frame_time_ms = 0;
    std::vector<ClientShot> born;
    std::vector<GoneShot> gone;
};

/// The set of map objects a scan has met, by id, with what each one is.
///
/// **Two of these, swapped every scan**, which is what turns "what is here now"
/// into "what arrived" and "what left" without a pass over anything but the
/// objects themselves. Open addressing over a fixed table, and cleared by
/// moving a stamp rather than by writing it: a frame is not the place to clear
/// half a megabyte.
class ObjectSet {
  public:
    /// What an object turned out to be.
    enum class Kind : std::uint8_t { kOther = 0, kEnemyShot = 1, kFriendlyShot = 2 };

    struct Member {
        std::int32_t object_id = 0;
        std::uint32_t stamp = 0;
        const void* object = nullptr;
        std::int32_t owner_id = 0;
        std::uint16_t bullet_id = 0;
        Kind kind = Kind::kOther;
        /// How many scans in a row it has been missing from. See `Scan`.
        std::uint8_t missed = 0;
    };

    /// Room for twice the most objects a scan will ever file, so a probe is
    /// short however full the world is.
    static constexpr std::uint32_t kCapacity = 2 * kMaxMapObjects;

    ObjectSet();

    /// Empties the set without touching its table.
    void Clear() noexcept;

    /// The member filed under `object_id`, or null.
    [[nodiscard]] const Member* Find(std::int32_t object_id) const noexcept;

    /// Files a member. Ignored when the set is full, which a bounded walk
    /// cannot make it.
    void Insert(const Member& member) noexcept;

    /// Every id filed since the last clear, in the order they were filed.
    [[nodiscard]] const std::vector<std::int32_t>& ids() const noexcept { return ids_; }

  private:
    [[nodiscard]] std::uint32_t SlotOf(std::int32_t object_id) const noexcept;

    std::vector<Member> slots_;
    std::vector<std::int32_t> ids_;
    std::uint32_t stamp_ = 1;
};

class ClientShotScanner final : private MapObjectVisitor {
  public:
    /// The most objects a single scan classifies. A scan that meets more new
    /// ones leaves the rest for the next, which is a shot reported a frame late
    /// rather than a frame that stalls — the first scan in a crowded realm is
    /// the only one that ever gets near it.
    static constexpr std::uint32_t kMaxClassifiedPerScan = 1024;

    ClientShotScanner() = default;

    /// Walks the world once. **Game thread only.**
    ///
    /// Fills `out.born` with every enemy shot met for the first time and
    /// `out.gone` with every one met last scan and not this one. Both are
    /// emptied first.
    ///
    /// @param world The live world manager — see `FindWorldManager`.
    /// @param frame_time_ms Its frame clock this frame, which every shot's age
    ///   is measured against.
    /// @returns false when the world could not be walked whole, in which case
    ///   nothing is reported and what was being tracked is forgotten: the next
    ///   scan reports every shot as new again, which only re-times them.
    [[nodiscard]] bool Scan(const void* world, std::int32_t frame_time_ms,
                            const ClientShotRoute& route, ShotScan& out) noexcept;

    /// Forgets everything tracked.
    void Reset() noexcept;

  private:
    bool Visit(std::int32_t object_id, const void* object) noexcept override;

    /// Works out what a new object is, reading it as a shot when it is one.
    ///
    /// @returns nothing when the object could not be read at all, which leaves
    ///   it to be asked about again on the next scan rather than filed as
    ///   something it may not be.
    [[nodiscard]] std::optional<ObjectSet::Member> Classify(std::int32_t object_id,
                                                            const void* object) noexcept;

    ObjectSet previous_;
    ObjectSet current_;
    /// The scan in progress. Valid only inside `Scan`.
    const ClientShotRoute* route_ = nullptr;
    ShotScan* out_ = nullptr;
    std::uint32_t classified_ = 0;
};

}  // namespace brownie::game
