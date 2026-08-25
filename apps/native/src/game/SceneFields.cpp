#include "game/SceneFields.h"

#include <array>

namespace brownie::game {
namespace {

/// Where Unity keeps its own object model.
///
/// Two names for one assembly, tried in order. The engine's core types moved
/// out of `UnityEngine` and into `UnityEngine.CoreModule` when Unity split its
/// assemblies, and a build of either shape resolves through the same query.
constexpr std::string_view kCoreAssemblies[] = {"UnityEngine.CoreModule", "UnityEngine"};

/// And where it keeps the UI ones. `Unity.ugui` is the newer packaging of what
/// used to ship as `UnityEngine.UI`.
constexpr std::string_view kUiAssemblies[] = {"UnityEngine.UI", "Unity.ugui"};

constexpr std::string_view kUnityNamespace = "UnityEngine";
constexpr std::string_view kUnityUiNamespace = "UnityEngine.UI";

constexpr ClassQuery kGameObject{kUnityNamespace, "GameObject", {}, kCoreAssemblies};
constexpr ClassQuery kTransform{kUnityNamespace, "Transform", {}, kCoreAssemblies};
constexpr ClassQuery kComponent{kUnityNamespace, "Component", {}, kCoreAssemblies};
constexpr ClassQuery kApplication{kUnityNamespace, "Application", {}, kCoreAssemblies};
constexpr ClassQuery kCamera{kUnityNamespace, "Camera", {}, kCoreAssemblies};
constexpr ClassQuery kGraphic{kUnityUiNamespace, "Graphic", {}, kUiAssemblies};
constexpr ClassQuery kImage{kUnityUiNamespace, "Image", {}, kUiAssemblies};

/// The game's map data. In its own assembly and not renamed — `ObjectProperties`
/// and `collisionRadiusMultiplier` are among the names the obfuscator left
/// alone, which is why these are spelled out rather than found by shape.
constexpr std::string_view kMapDataNamespace = "DecaGames.RotMG.Objects.Map.Data";
constexpr ClassQuery kViewHandler{kMapDataNamespace, "ViewHandler", {}};
constexpr ClassQuery kObjectProperties{kMapDataNamespace, "ObjectProperties", {}};
constexpr ClassQuery kShaderProperties{kMapDataNamespace, "ShaderProperties", {}};
constexpr ClassQuery kApplicationManager{"DecaGames.RotMG.Managers", "ApplicationManager", {}};
constexpr ClassQuery kShaderEffectManager{{}, "ShaderEffectManager", {}};
constexpr ClassQuery kShaderLibrary{{}, "JCHBHNEGDFP", {}};

/// The class every map object derives from, the local player included. Named
/// again here rather than shared with `ProjectileFields.cpp`, which queries it
/// for the square a shot stands on: the two files ask different things of it and
/// each says which class it is asking, so a build that renames it leaves both
/// sets of keys unresolved and visible in the overlay's report.
constexpr ClassQuery kMapObject{{}, "KJMONHENJEN", {}};

/// The UI manager that draws over the map.
///
/// The namespace is the one a live run reported for the declared type of
/// `ViewHandler.GUIManager`, which is how it was learned: this class was first
/// queried by bare name because nothing knew where it lived, and the field that
/// holds one answered that. Named in full now, so the lookup proves what it
/// found rather than falling back to a search that cannot say which namespace
/// it came from.
constexpr std::string_view kUiNamespace = "DecaGames.RotMG.Managers.Game.MapObjects";
constexpr ClassQuery kMapObjectUiManager{kUiNamespace, "MapObjectUIManager", {}};

/// `ShowFloatingText` is two methods — a live run listed them — so each query
/// says how many arguments its one takes.
///
/// **Counts, and no types with them.** The signatures run through an
/// enumeration whose type name is obfuscator output and a `Nullable<Color32>`,
/// so spelling them out would be a guess at spellings rather than the
/// disambiguation a signature is for. Six is the one that takes a string, which
/// is what a line of ours is; four is the one that takes an `int`, which is
/// what every damage number in the game is. A third overload of either arity
/// would be an ambiguity and refused, which is the outcome to have.
constexpr std::size_t kShowFloatingTextArity = 6;
constexpr std::size_t kShowFloatingNumberArity = 4;

/// Named once and used twice: by the query, and by the list of overloads that
/// checks what the query picked.
constexpr std::string_view kShowFloatingTextName = "ShowFloatingText";

// The signatures. Given to disambiguate overloads, not to stand in for a name:
// `GetComponent` alone is three methods, and `Quit` is two.
constexpr std::string_view kStringParameter[] = {"System.String"};
constexpr std::string_view kTypeParameter[] = {"System.Type"};
constexpr std::string_view kIntParameter[] = {"System.Int32"};
constexpr std::string_view kColorParameter[] = {"UnityEngine.Color"};

constexpr std::string_view kVector3Parameter[] = {"UnityEngine.Vector3"};

constexpr std::string_view kGameObjectType = "UnityEngine.GameObject";
constexpr std::string_view kTransformType = "UnityEngine.Transform";
constexpr std::string_view kComponentType = "UnityEngine.Component";
constexpr std::string_view kCameraType = "UnityEngine.Camera";
constexpr std::string_view kVector3Type = "UnityEngine.Vector3";
constexpr std::string_view kIntType = "System.Int32";
constexpr std::string_view kVoidType = "System.Void";
constexpr std::string_view kShaderEffectManagerType = "ShaderEffectManager";
constexpr std::string_view kShaderLibraryType = "JCHBHNEGDFP";
constexpr std::string_view kShaderPropertiesType =
    "DecaGames.RotMG.Objects.Map.Data.ShaderProperties";
constexpr std::string_view kShaderListType =
    "System.Collections.Generic.List<DecaGames.RotMG.Objects.Map.Data.ShaderProperties>";

struct KeyedMethodQuery {
    std::string_view key;
    MethodQuery query;
};

constexpr std::array kMethods{
    KeyedMethodQuery{kFindGameObject,
                     MethodQuery{kGameObject, "Find", {}, kGameObjectType, kStringParameter}},
    KeyedMethodQuery{kGameObjectTransform,
                     MethodQuery{kGameObject, "get_transform", {}, kTransformType}},
    KeyedMethodQuery{
        kGameObjectComponent,
        MethodQuery{kGameObject, "GetComponent", {}, kComponentType, kTypeParameter}},
    KeyedMethodQuery{kComponentGameObject,
                     MethodQuery{kComponent, "get_gameObject", {}, kGameObjectType}},
    KeyedMethodQuery{kTransformChildCount,
                     MethodQuery{kTransform, "get_childCount", {}, kIntType}},
    KeyedMethodQuery{kTransformChild,
                     MethodQuery{kTransform, "GetChild", {}, kTransformType, kIntParameter}},
    KeyedMethodQuery{kTransformFind,
                     MethodQuery{kTransform, "Find", {}, kTransformType, kStringParameter}},
    KeyedMethodQuery{kGraphicSetColor,
                     MethodQuery{kGraphic, "set_color", {}, kVoidType, kColorParameter}},
    // The no-argument overload. `Quit(int)` exits with a code and is not the
    // one the game's own quit path calls.
    KeyedMethodQuery{kApplicationQuit, MethodQuery{kApplication, "Quit", {}, kVoidType}},
    KeyedMethodQuery{kCameraMain, MethodQuery{kCamera, "get_main", {}, kCameraType}},
    // **The one-argument overload**, which is the one that exists in every
    // build. The other takes a stereoscopic eye that this game has no use for,
    // and the signature is what tells them apart.
    KeyedMethodQuery{
        kWorldToScreenPoint,
        MethodQuery{kCamera, "WorldToScreenPoint", {}, kVector3Type, kVector3Parameter}},
    // No signature, which is the one place in this file that is true — an
    // argument count instead. See the note above it.
    KeyedMethodQuery{kShowFloatingText, MethodQuery{kMapObjectUiManager,
                                                    kShowFloatingTextName,
                                                    {},
                                                    {},
                                                    {},
                                                    false,
                                                    kShowFloatingTextArity}},
    KeyedMethodQuery{kShowFloatingNumber, MethodQuery{kMapObjectUiManager,
                                                      kShowFloatingTextName,
                                                      {},
                                                      {},
                                                      {},
                                                       false,
                                                       kShowFloatingNumberArity}},
    KeyedMethodQuery{kApplicationShaderEffects,
                     MethodQuery{kApplicationManager, "get_ShaderEffects", {},
                                 kShaderEffectManagerType}},
    KeyedMethodQuery{kShaderEffectLibrary,
                     MethodQuery{kShaderEffectManager, "get_Library", {}, kShaderLibraryType}},
};

struct KeyedFieldQuery {
    std::string_view key;
    FieldQuery query;
};

constexpr std::array kFields{
    KeyedFieldQuery{kViewHandlerEntity, FieldQuery{kViewHandler, "destroyEntity", {}}},
    KeyedFieldQuery{kPropertiesIsPlayer, FieldQuery{kObjectProperties, "isPlayer", {}}},
    KeyedFieldQuery{kPropertiesCollisionRadius,
                    FieldQuery{kObjectProperties, "collisionRadiusMultiplier", {}}},
    KeyedFieldQuery{kMapObjectViewHandler, FieldQuery{kMapObject, "MPGOFIHIDML", {}}},
    KeyedFieldQuery{kViewHandlerUiManager, FieldQuery{kViewHandler, "GUIManager", {}}},
    KeyedFieldQuery{kShaderLibraryItems,
                    FieldQuery{kShaderLibrary, "FHBLGAFGCFF", {}, kShaderListType, 0, 1}},
    KeyedFieldQuery{kShaderPropertiesId, FieldQuery{kShaderProperties, "id", {}}},
};

}  // namespace

const ClassQuery& ViewHandlerClass() noexcept {
    return kViewHandler;
}

const ClassQuery& ObjectPropertiesClass() noexcept {
    return kObjectProperties;
}

const ClassQuery& ImageClass() noexcept {
    return kImage;
}

std::size_t ResolveSceneMethods(OffsetTable& table) {
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

std::size_t ResolveSceneFields(OffsetTable& table) {
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
