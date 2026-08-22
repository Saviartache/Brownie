// The local player's collision radius, held at zero.
//
// One number, on one object, and the game does the rest: `collisionRadiusMultiplier`
// is what the client scales the player's collision circle by, so zero leaves
// every test the client makes against that circle with nothing to hit.
//
// **What that stops is whatever the client decides by the circle, and the
// visible one is area damage.** HPBarMod's own operators report shots that
// explode in a radius landing without doing anything — which is the effect
// this is actually for, and is why calling it "no clip" would be wrong twice
// over: it is not about walls, and the client keeps deciding everything else
// about the player exactly as it did. Damage that is not decided by that circle
// is unaffected, and nothing here makes the server think anything at all.
//
// **It is written, not called, and that is the exception rather than the rule
// here.** Movement goes through the game's own `MoveTo` precisely because a
// position the client never agreed to is one the server sees appear from
// nowhere — see `PlayerMover.h`. This is the other kind of change: a client-side
// property the client keeps reading, so writing it once leaves the client
// walking, rendering and reporting itself exactly as it would have anyway.
//
// **The properties are shared, not the player's own copy.** `ObjectProperties`
// is the descriptor a *kind* of object is built from — it carries the class
// name, the sounds, the sizes — so the write reaches every object built from
// the same one, and it is undone by whatever reloads them. That is the reason
// the pass runs again rather than writing once and trusting it.
//
// **Finding it is a walk, not an offset chain.** The properties belong to the
// entity, the entity is held by the `ViewHandler` component on the player's
// scene node, and which field of the entity holds them is not knowable by name:
// it is found by *type*, on the entity's own class and its bases, which is what
// survives a build where every name around it was renamed. That walk is what
// the reference module did and it is the only route to these properties that
// has been seen to work.
//
// The expensive half of it — asking a class what its fields are — happens once
// per entity class and is remembered. What is left is a handful of reads and
// one write.

#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "game/Il2CppRuntime.h"
#include "game/Metadata.h"
#include "game/UnityScene.h"

namespace brownie::game {

/// The offsets of every instance field of `type_name` in `fields`, in
/// declaration order and no more than `limit` of them.
///
/// **Instance fields only.** A static field's offset is into a different block
/// of memory entirely, and one taken for an instance offset would have the
/// module writing at that distance into an object that knows nothing about it.
///
/// Free, and takes descriptions rather than a class, because this is the part
/// worth testing: it decides where a write lands.
[[nodiscard]] std::vector<std::uint32_t> PropertyFieldOffsets(
    const std::vector<FieldDescription>& fields, std::string_view type_name, std::size_t limit);

class PlayerCollision {
  public:
    /// How far up an entity's hierarchy the properties are looked for, and how
    /// many candidates are kept. Both are the reference module's, which found
    /// them sufficient; both exist because the numbers bounding this walk come
    /// out of the game's own memory.
    static constexpr std::size_t kMaxDepth = 10;
    static constexpr std::size_t kMaxCandidates = 16;

    PlayerCollision() noexcept = default;

    PlayerCollision(const PlayerCollision&) = delete;
    PlayerCollision& operator=(const PlayerCollision&) = delete;

    /// Hands over everything resolution found. **IPC thread, once.**
    ///
    /// `properties_type` is the name the runtime gives `ObjectProperties`,
    /// which is how a field of that type is recognised — a field's declared
    /// type comes back fully qualified, so a bare literal would never match.
    void Bind(ClassRef view_handler, std::string properties_type, std::uint32_t entity_at,
              std::uint32_t is_player_at, std::uint32_t collision_at);

    /// Whether {@link Bind} has happened. Callable from either thread.
    [[nodiscard]] bool bound() const noexcept { return bound_.load(std::memory_order_acquire); }

    /// Finds the player's properties and zeroes the radius. **Game thread
    /// only**, and behind a cadence: the scene walk it starts with is Unity's
    /// `GameObject.Find`, which is not a per-frame call.
    ///
    /// @returns whether the write happened. False is the ordinary answer at the
    ///   login screen, between realms and while a map is being rebuilt — there
    ///   is no player node then, and nothing to write to.
    bool Apply(const Il2CppRuntime& game, const UnityScene& scene);

    /// How many times the radius has been zeroed, for the overlay to show. One
    /// per pass while the feature is on, because the game writes the property
    /// back as it rebuilds the entity.
    [[nodiscard]] std::uint32_t applied() const noexcept { return applied_; }

  private:
    /// Where this entity class keeps its properties, found once per class.
    ///
    /// Keyed on the class rather than the object: the objects change every
    /// realm and the class does not. A miss re-scans, which is the case that
    /// costs metadata queries and allocation — once, on the first entity of a
    /// kind the module has not seen.
    [[nodiscard]] const std::vector<std::uint32_t>& OffsetsFor(const Il2CppRuntime& game,
                                                               ClassRef klass);

    /// Zeroes the radius on the first of `offsets` that leads to the player's
    /// own properties.
    [[nodiscard]] bool ZeroThroughEntity(void* entity,
                                         const std::vector<std::uint32_t>& offsets) const;

    ClassRef view_handler_ = nullptr;
    std::string properties_type_;
    std::uint32_t entity_at_ = 0;
    std::uint32_t is_player_at_ = 0;
    std::uint32_t collision_at_ = 0;
    /// Written last with a release, read first with an acquire: a pass that
    /// sees this sees every offset above it.
    std::atomic<bool> bound_{false};

    /// Game thread only, like everything it caches.
    ClassRef scanned_class_ = nullptr;
    std::vector<std::uint32_t> scanned_offsets_;
    std::uint32_t applied_ = 0;
};

}  // namespace brownie::game
