#include "game/ProjectileFields.h"

#include <array>

namespace brownie::game {
namespace {

/// The namespace is empty because these classes are in the global one. Spelled
/// out rather than defaulted, so that a class which later moves into a
/// namespace is a visible edit here rather than a silent failure to resolve.
constexpr std::string_view kGlobalNamespace{};

/// The projectile, the class every map object derives from, and the square.
///
/// All three are obfuscator output with no known real name, so none of them
/// carries an alias: an alias is a name we have *seen*, and inventing one would
/// only widen where a match may be made.
///
/// `KJMONHENJEN` is named again here rather than shared with
/// `PlayerFields.cpp`, which queries it for the player's own position. The two
/// files ask different things of the same class, and each says which class it
/// is asking — a build that renames it leaves both keys unresolved and visible
/// in the overlay's report, which is what that report is for.
constexpr std::string_view kProjectileClass = "HBEAKBIHANL";
/// The projectile's one subclass: what the game's shot pool hands out, so the
/// class nearly every live shot is an instance of. The two fields it adds are
/// about drawing and everything read off a shot is inherited, which is why
/// nothing is resolved on it — it is only ever compared against.
constexpr std::string_view kPooledProjectileClass = "BJLDGDKMPFL";
constexpr std::string_view kMapObjectClass = "KJMONHENJEN";
constexpr std::string_view kTileClass = "BGAIOPJMHLO";
constexpr std::string_view kWorldManagerClass = "HJMBOMEHGDJ";

constexpr ClassQuery kProjectile{kGlobalNamespace, kProjectileClass, {}};
constexpr ClassQuery kMapObject{kGlobalNamespace, kMapObjectClass, {}};
constexpr ClassQuery kTile{kGlobalNamespace, kTileClass, {}};
constexpr ClassQuery kWorldManager{kGlobalNamespace, kWorldManagerClass, {}};

/// `bool (int, int)`, which both collision methods are.
///
/// Given to disambiguate overloads, and for nothing else: the two methods share
/// this shape exactly, so a signature identifies neither and
/// `MethodQuery::fingerprint` stays off. A method matched by a shape two
/// methods share is a detour on whichever the runtime listed first — which here
/// would put the outer detour on the inner method and lose the restore.
constexpr std::string_view kTileCheckParameters[] = {"System.Int32", "System.Int32"};

constexpr MethodQuery kHitsWallQuery{kProjectile, "GJFKGLJEGKO", {}, "System.Boolean",
                                     kTileCheckParameters};
constexpr MethodQuery kTileBlocksQuery{kProjectile, "IACODGNOFMH", {}, "System.Boolean",
                                       kTileCheckParameters};

struct KeyedMethodQuery {
    std::string_view key;
    MethodQuery query;
};

constexpr std::array kMethods{
    KeyedMethodQuery{kShotHitsWall, kHitsWallQuery},
    KeyedMethodQuery{kShotTileBlocks, kTileBlocksQuery},
};

struct KeyedFieldQuery {
    std::string_view key;
    FieldQuery query;
};

/// The queries.
///
/// **No fingerprints.** A field's shape may only be written from a class a live
/// run described — see `PlayerFields.cpp`, where every number came off a real
/// session — and no live run has yet reported these. `type_count` left at zero
/// disables the layer, so a rename here is a key that goes unresolved and a
/// feature that stays off, which is the outcome to have until somebody has
/// looked.
constexpr std::array kFields{
    KeyedFieldQuery{kShotDamagesEnemies, FieldQuery{kProjectile, "NPMECLDKGEF", {}}},
    KeyedFieldQuery{kMapObjectTile, FieldQuery{kMapObject, "EOKJOGFPLOA", {}}},
    KeyedFieldQuery{kTileCollisionLayer, FieldQuery{kTile, "EBCLNFDKKEH", {}}},

    // What the dodge reads, each named as the client's spawn routine writes it:
    // the start position through the move it makes right after spawning, the
    // angle normalised, the start time from the world manager's frame clock,
    // the owner and the bullet id as the key it files the shot under, the
    // multiplier the owner's stat handed it, the lifetime already multiplied,
    // and the square's half-side as `CollisionMult × 0.5`. By name alone, for
    // the reason given above.
    KeyedFieldQuery{kShotStartX, FieldQuery{kProjectile, "AADLFLPIDGF", {}}},
    KeyedFieldQuery{kShotStartY, FieldQuery{kProjectile, "EPFDHJLACEC", {}}},
    KeyedFieldQuery{kShotAngle, FieldQuery{kProjectile, "FFFFKPDHEFP", {}}},
    KeyedFieldQuery{kShotStartTime, FieldQuery{kProjectile, "GLEGBLDBOJF", {}}},
    KeyedFieldQuery{kShotOwner, FieldQuery{kProjectile, "BOEOHMKEFIG", {}}},
    KeyedFieldQuery{kShotBulletId, FieldQuery{kProjectile, "<HBAKILABEBJ>k__BackingField", {}}},
    // The byte before `NPMECLDKGEF`, set from the owner's own "is an enemy".
    KeyedFieldQuery{kShotDamagesPlayers, FieldQuery{kProjectile, "IIJFKHOLODP", {}}},
    KeyedFieldQuery{kShotSpeedMultiplier, FieldQuery{kProjectile, "KDAJOMOFMJB", {}}},
    KeyedFieldQuery{kShotLifetime, FieldQuery{kProjectile, "JMAJPIEPBGK", {}}},
    KeyedFieldQuery{kShotRadius, FieldQuery{kProjectile, "HHFDCMIIIHF", {}}},

    KeyedFieldQuery{kWorldFrameTime, FieldQuery{kWorldManager, "IBAFDFNDNBN", {}}},
    KeyedFieldQuery{kWorldObjectsPending, FieldQuery{kWorldManager, "ONABHKFOJNE", {}}},
};

}  // namespace

ShotClasses FindShotClasses(const MetadataSource& metadata) {
    ShotClasses classes;
    classes.shot = metadata.FindClass(kGlobalNamespace, kProjectileClass).value_or(nullptr);
    classes.pooled = metadata.FindClass(kGlobalNamespace, kPooledProjectileClass).value_or(nullptr);
    return classes;
}

std::size_t ResolveProjectileMethods(OffsetTable& table) {
    std::size_t resolved = 0;
    for (const auto& entry : kMethods) {
        // Already answered, and an answer cannot change for the run. Skipped
        // rather than re-resolved, because resolving enumerates every method
        // the class declares.
        if (table.MethodAddress(entry.key).has_value()) {
            continue;
        }
        if (table.ResolveMethod(entry.key, entry.query).ok()) {
            ++resolved;
        }
    }
    return resolved;
}

std::size_t ResolveProjectileFields(OffsetTable& table) {
    std::size_t resolved = 0;
    for (const auto& entry : kFields) {
        if (table.FieldOffset(entry.key).has_value()) {
            continue;
        }
        if (table.ResolveField(entry.key, entry.query).ok()) {
            ++resolved;
        }
    }
    return resolved;
}

}  // namespace brownie::game
