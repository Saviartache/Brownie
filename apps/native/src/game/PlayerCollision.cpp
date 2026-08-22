#include "game/PlayerCollision.h"

#include <cmath>
#include <optional>

#include "game/PlayerRoute.h"
#include "game/PlayerView.h"

namespace brownie::game {

std::vector<std::uint32_t> PropertyFieldOffsets(const std::vector<FieldDescription>& fields,
                                                std::string_view type_name, std::size_t limit) {
    std::vector<std::uint32_t> offsets;
    if (type_name.empty()) {
        // Without a type name every field would match, and the module would
        // write at the first offset it found.
        return offsets;
    }
    for (const auto& field : fields) {
        if (offsets.size() >= limit) {
            break;
        }
        if (field.is_static || field.type_name != type_name) {
            continue;
        }
        offsets.push_back(field.offset);
    }
    return offsets;
}

std::optional<float> CollisionMemory::Decide(const void* properties, float current,
                                             std::optional<float> wanted) noexcept {
    if (properties == nullptr) {
        return std::nullopt;
    }

    if (!wanted.has_value()) {
        // Only into the object the value came from. A different one is either a
        // rebuilt player or another handler on the same node, and neither is
        // what this took anything from.
        //
        // **Not forgotten here, though.** A walk asks about every handler under
        // the player's node, so the first one to be asked is not necessarily
        // the one holding what was taken — dropping the address on the first
        // mismatch would lose the restore to whichever child came first.
        // Whether it is gone for good is the pass's to decide, and it says so
        // by forgetting once a whole walk has found nowhere to put it back.
        if (properties != tracked_) {
            return std::nullopt;
        }
        const float original = original_;
        tracked_ = nullptr;
        return original;
    }

    // A field that is not a number is an object this has no business writing to:
    // the walk found something shaped like the player's properties and the value
    // in it says otherwise. Left alone, and not remembered either.
    if (!std::isfinite(current) || !std::isfinite(*wanted)) {
        return std::nullopt;
    }
    if (properties != tracked_) {
        tracked_ = properties;
        original_ = current;
    }
    return *wanted;
}

void PlayerCollision::Bind(ClassRef view_handler, std::string properties_type,
                           std::uint32_t entity_at, std::uint32_t is_player_at,
                           std::uint32_t collision_at) {
    if (bound_.load(std::memory_order_relaxed)) {
        return;
    }
    view_handler_ = view_handler;
    properties_type_ = std::move(properties_type);
    entity_at_ = entity_at;
    is_player_at_ = is_player_at;
    collision_at_ = collision_at;
    bound_.store(true, std::memory_order_release);
}

const std::vector<std::uint32_t>& PlayerCollision::OffsetsFor(const Il2CppRuntime& game,
                                                              ClassRef klass) {
    if (klass == scanned_class_) {
        return scanned_offsets_;
    }

    // Remembered whatever the answer, including an empty one: a class with no
    // properties field is asked about once, not on every pass.
    scanned_class_ = klass;
    scanned_offsets_.clear();

    std::size_t depth = 0;
    for (std::optional<ClassRef> current = klass;
         current.has_value() && depth < kMaxDepth && scanned_offsets_.size() < kMaxCandidates;
         current = game.BaseClass(*current), ++depth) {
        // A class the runtime has not finished building cannot be asked for its
        // members — the crash this project guards every sweep against. An
        // object of it exists, so this is a formality; it is here because the
        // one time it is not, the cost is the game.
        if (!game.IsPrepared(*current)) {
            break;
        }
        for (const auto offset :
             PropertyFieldOffsets(game.Fields(*current), properties_type_,
                                  kMaxCandidates - scanned_offsets_.size())) {
            scanned_offsets_.push_back(offset);
        }
    }
    return scanned_offsets_;
}

bool PlayerCollision::WriteThroughEntity(void* entity, const std::vector<std::uint32_t>& offsets,
                                         std::optional<float> multiplier) {
    for (const auto offset : offsets) {
        void* properties = nullptr;
        if (!ReadField(entity, offset, properties) || properties == nullptr) {
            continue;
        }
        // Whose properties these are. Every entity in the realm has an
        // `ObjectProperties`; exactly one of them says it is the player, and
        // writing to any other would be changing somebody else's collision.
        std::uint8_t is_player = 0;
        if (!ReadField(properties, is_player_at_, is_player) || is_player == 0) {
            continue;
        }
        // Read before written, because what is there is what gets put back
        // later — and a read that fails is an object that cannot be written
        // either.
        float current = 0.0F;
        if (!ReadField(properties, collision_at_, current)) {
            return false;
        }
        const auto value = memory_.Decide(properties, current, multiplier);
        if (!value.has_value()) {
            return false;
        }
        return WriteField(properties, collision_at_, *value);
    }
    return false;
}

bool PlayerCollision::Apply(const Il2CppRuntime& game, const UnityScene& scene,
                            std::optional<float> multiplier) {
    if (!bound() || (!multiplier.has_value() && !memory_.holding())) {
        return false;
    }

    const bool written = ForEachPlayerViewHandler(scene, view_handler_, [&](void* handler) {
        void* entity = nullptr;
        if (!ReadField(handler, entity_at_, entity) || entity == nullptr) {
            return false;
        }
        const auto klass = game.ClassOf(entity);
        if (!klass.has_value()) {
            return false;
        }
        return WriteThroughEntity(entity, OffsetsFor(game, *klass), multiplier);
    });

    // Nothing to put it back into: there is no player node, so the object the
    // value came from is gone with the realm it belonged to. Remembering its
    // address any longer would be an eventual write into whatever now lives
    // there — and it would keep this pass walking the scene for a restore that
    // can never happen.
    if (!written && !multiplier.has_value()) {
        memory_.Forget();
    }
    if (written) {
        ++applied_;
    }
    return written;
}

}  // namespace brownie::game
