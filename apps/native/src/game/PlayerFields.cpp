#include "game/PlayerFields.h"

#include <array>

namespace brownie::game {
namespace {

/// The class holding the local player's stats, as this build names it.
///
/// Obfuscated, and with no known real name — the reference implementation's
/// Beebyte map does not contain it, so nothing here can offer a deobfuscated
/// alias and pretending otherwise would be an alias that never matches.
constexpr std::string_view kPlayerClass = "LKHPPBEGNOM";

/// The base class it derives from, which is where anything an ordinary map
/// object has — an id, a position — actually lives.
///
/// A separate query rather than a hierarchy walk, because `Fields()` returns a
/// class's *own* fields and nothing else. Naming the class that really declares
/// a field is the honest version: a walk would find it too, but the report
/// would then say the field is on the player's class, which is not true and is
/// exactly the sort of thing to be wrong about after a patch.
constexpr std::string_view kMapObjectClass = "KJMONHENJEN";

/// The namespace is empty because these classes are in the global one. Spelled
/// out rather than defaulted, so that a class which later moves into a
/// namespace is a visible edit here rather than a silent failure to resolve.
constexpr std::string_view kGlobalNamespace{};

/// The two classes on the way to the player. `ApplicationManager` is one of the
/// names the obfuscator left alone, namespace included; the world manager is
/// not, and sits in the global namespace like everything else it renamed.
constexpr std::string_view kApplicationManagerNamespace = "DecaGames.RotMG.Managers";
constexpr std::string_view kApplicationManagerClass = "ApplicationManager";
constexpr std::string_view kWorldManagerClass = "HJMBOMEHGDJ";

constexpr ClassQuery kPlayer{kGlobalNamespace, kPlayerClass, {}};
constexpr std::string_view kLocalPlayerClassName = "FKALGHJIADI";
constexpr ClassQuery kLocalPlayerClass{kGlobalNamespace, kLocalPlayerClassName, {}};
constexpr ClassQuery kMapObject{kGlobalNamespace, kMapObjectClass, {}};
// Named for the role they play in a query rather than for the class, so that
// neither collides with the *keys* of the same name in the header.
constexpr ClassQuery kAppManagerOwner{kApplicationManagerNamespace, kApplicationManagerClass, {}};
constexpr ClassQuery kWorldManagerOwner{kGlobalNamespace, kWorldManagerClass, {}};

/// The queries.
///
/// Every fingerprint here was read off a live session — `System.Int32 #4 of 26`
/// and so on — which is the only way one may be written. None of them was
/// derived, inferred or copied from a dump.
constexpr std::array kQueries{
    KeyedFieldQuery{kPlayerHp, FieldQuery{kPlayer, "KJNHLADHEMH", {}, "System.Int32", 4, 26}},
    KeyedFieldQuery{kPlayerMaxHp, FieldQuery{kPlayer, "NCBIICBDGAG", {}, "System.Int32", 3, 26}},
    KeyedFieldQuery{kPlayerDefense,
                    FieldQuery{kPlayer, "HODJPKFINKF", {}, "System.Int32", 5, 26}},
    KeyedFieldQuery{kPlayerObjectId,
                    FieldQuery{kMapObject, "HHPOJBFICAH", {}, "System.Int32", 1, 7}},
    // Two floats, not the `float3` the class also carries: that one is written
    // only on a teleport or a move, so it lags behind where the player is.
    KeyedFieldQuery{kPlayerX, FieldQuery{kMapObject, "CLFEOFKBNEJ", {}, "System.Single", 0, 6}},
    KeyedFieldQuery{kPlayerY, FieldQuery{kMapObject, "PKEECFNFEIO", {}, "System.Single", 1, 6}},
    KeyedFieldQuery{kPlayerShaderProperties,
                    FieldQuery{kPlayer, "PGAFHFAGDLK", {},
                               "DecaGames.RotMG.Objects.Map.Data.ShaderProperties", 0, 1}},
    KeyedFieldQuery{kPlayerSkin,
                    FieldQuery{kLocalPlayerClass, "BKMIHOGBMMC", {}, "System.Int32", 0, 0}},
    KeyedFieldQuery{kPlayerGlow,
                    FieldQuery{kLocalPlayerClass, "EGMPAONNMFA", {}, "System.Int32", 0, 0}},

    // **By name alone, and the empty fingerprint is not an oversight.** A
    // fingerprint may only be written from a live class that said it — see the
    // header — and no run has reported this one yet. `System.Single` is also
    // among the commonest types the class declares, so a shape would be the
    // layer that guesses rather than the one that refuses.
    KeyedFieldQuery{kPlayerMoveMultiplier, FieldQuery{kLocalPlayerClass, "EOMJKKBOKOE", {}}},

    // The two hops to the player object itself. The first is a C# auto-property
    // whose compiler-generated wrapper survived obfuscation even though the
    // property name inside it did not — which is why it looks half-readable.
    KeyedFieldQuery{kWorldManager,
                    FieldQuery{kAppManagerOwner, "<CHDFAEBMILI>k__BackingField", {}}},
    KeyedFieldQuery{kLocalPlayer, FieldQuery{kWorldManagerOwner, "OCLNLBHDEFK", {}}},

    // The two tables of map objects. Fingerprinted like everything else — the
    // class declares exactly two fields of this type — and told apart at the
    // point of use rather than here, because the declared type cannot say which
    // holds what and a name that says nothing must not be read as though it
    // did. See `kWorldObjects`.
    KeyedFieldQuery{kWorldObjects,
                    FieldQuery{kWorldManagerOwner, "KHIHFNACEKJ", {},
                               "System.Collections.Generic.Dictionary<System.Int32,KJMONHENJEN>",
                               0, 2}},
    KeyedFieldQuery{kWorldObjectsAlt,
                    FieldQuery{kWorldManagerOwner, "CIOIHEOEAEB", {},
                               "System.Collections.Generic.Dictionary<System.Int32,KJMONHENJEN>",
                               1, 2}},
};

/// `bool MoveTo(float x, float y)` on the player.
///
/// The signature is given to disambiguate overloads, not to stand in for the
/// name: `bool(float, float)` is not a shape that identifies anything, and a
/// method matched by a shape several share is a call through a prototype that
/// does not describe it. See `MethodQuery::fingerprint`.
constexpr std::string_view kMoveToParameters[] = {"System.Single", "System.Single"};
constexpr MethodQuery kMoveTo{kPlayer, "DGLCONCOIBO", {}, "System.Boolean", kMoveToParameters};

/// The class that holds the shooting, which is not the one that holds the
/// stats.
///
/// **No alias to the player's class.** The two are different classes and the
/// method is what identifies itself; naming a second class to look in would
/// only widen where a name may be matched, and every method this file resolves
/// is one the module is about to detour or call.
constexpr std::string_view kShootClassName = kLocalPlayerClassName;
constexpr ClassQuery kShootClass{kGlobalNamespace, kShootClassName, {}};

/// `void ComputeShootAngle(byte slot, out float angle, out bool canShoot, bool)`.
///
/// The two `&`s are how IL2CPP names a by-reference parameter, which the last
/// two of these are — the method answers through them rather than returning.
constexpr std::string_view kComputeShootAngleParameters[] = {
    "System.Byte",
    "System.Single&",
    "System.Boolean&",
    "System.Boolean",
};
constexpr MethodQuery kComputeShootAngleQuery{kPlayer, "ELCBJAFBLJG", {}, "System.Void",
                                              kComputeShootAngleParameters};

/// `void ShootWithAngle(float angle)`.
constexpr std::string_view kShootWithAngleParameters[] = {"System.Single"};
constexpr MethodQuery kShootWithAngleQuery{kShootClass, "EHGHCACPAGH", {}, "System.Void",
                                           kShootWithAngleParameters};
constexpr std::string_view kIntParameter[] = {"System.Int32"};
constexpr std::string_view kShaderPropertiesParameter[] = {
    "DecaGames.RotMG.Objects.Map.Data.ShaderProperties"};
constexpr MethodQuery kSetPlayerSkinQuery{kLocalPlayerClass, "MBKGLHCJBCD", {}, "System.Void",
                                           kIntParameter};
constexpr MethodQuery kSetPlayerShaderQuery{kLocalPlayerClass, "CNAOFINEJPK", {}, "System.Void",
                                            kShaderPropertiesParameter};
/// `void SetGlow(int)`, which shares its shape with the skin setter above —
/// hence the name, and hence no fingerprint: `void(int)` on this class
/// identifies neither of them.
constexpr MethodQuery kSetPlayerGlowQuery{kLocalPlayerClass, "JEDNHGGONPP", {}, "System.Void",
                                          kIntParameter};

/// `float TileSpeedHere()` and `void ApplyTileSpeed()`, the two halves of what
/// the ground does to the player's speed.
///
/// **Detoured, not called.** The first is asked by the game's own movement code
/// and the second is the tick that stores its answer on the player; player
/// noclip answers one and corrects the other. A return type with no parameters
/// is what tells either from an overload — the shape identifies nothing on its
/// own, and neither carries a fingerprint for that reason.
constexpr MethodQuery kTileSpeedHereQuery{kLocalPlayerClass, "GCFKGLKAPND", {}, "System.Single"};
constexpr MethodQuery kApplyTileSpeedQuery{kLocalPlayerClass, "CNPNFDNDIJC", {}, "System.Void"};

struct KeyedMethodQuery {
    std::string_view key;
    MethodQuery query;
};

constexpr std::array kMethods{
    KeyedMethodQuery{kPlayerMoveTo, kMoveTo},
    KeyedMethodQuery{kComputeShootAngle, kComputeShootAngleQuery},
    KeyedMethodQuery{kShootWithAngle, kShootWithAngleQuery},
    KeyedMethodQuery{kSetPlayerSkin, kSetPlayerSkinQuery},
    KeyedMethodQuery{kSetPlayerShader, kSetPlayerShaderQuery},
    KeyedMethodQuery{kSetPlayerGlow, kSetPlayerGlowQuery},
    KeyedMethodQuery{kTileSpeedHere, kTileSpeedHereQuery},
    KeyedMethodQuery{kApplyTileSpeed, kApplyTileSpeedQuery},
};

}  // namespace

std::span<const KeyedFieldQuery> PlayerFieldQueries() noexcept {
    return kQueries;
}

std::string_view PlayerClassName() noexcept {
    return kPlayerClass;
}

std::size_t ResolvePlayerMethods(OffsetTable& table) {
    std::size_t resolved = 0;
    for (const auto& entry : kMethods) {
        // Same fast path as the fields, for the same reason: this runs on the
        // loop and an answer cannot change once it is found.
        if (table.MethodAddress(entry.key).has_value()) {
            continue;
        }
        if (table.ResolveMethod(entry.key, entry.query).ok()) {
            ++resolved;
        }
    }
    return resolved;
}

std::size_t ResolvePlayerFields(OffsetTable& table) {
    std::size_t resolved = 0;
    for (const auto& entry : kQueries) {
        // Already answered. Skipped rather than re-resolved, because resolving
        // enumerates every field of the class.
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
