// What the scene features need to find, and where it lives.
//
// The counterpart of `PlayerFields.h` for the things that are not the player:
// Unity's own object model, and the map-data classes the game hangs an entity's
// properties off. Same rules — every address and every offset is resolved from
// the game that is running, reported with the layer that answered it, and
// absent rather than guessed.
//
// **Two differences from the player's queries, both from where these classes
// live.**
//
// The engine's classes are not in `Assembly-CSharp`, so each query names the
// assemblies to look in — and names more than one, because Unity moves its own
// types between them: the UI classes ship in `UnityEngine.UI` in one build and
// `Unity.ugui` in the next.
//
// And nothing here is obfuscated. `GameObject.Find` is called `Find` in every
// build there has ever been, and `ObjectProperties.collisionRadiusMultiplier`
// is one of the names the game's obfuscator left alone. So these are exact
// names with signatures to disambiguate overloads, and no fingerprint: a shape
// like `void(Color)` identifies nothing, and a method matched by shape and got
// wrong is called through a prototype that does not describe it.

#pragma once

#include <cstddef>
#include <string_view>

#include "game/OffsetTable.h"

namespace brownie::game {

/// Unity's object model, as the seven calls the module makes into it.
///
/// Keys, because a key that does not resolve is shown in the overlay under
/// exactly this text.
inline constexpr std::string_view kFindGameObject = "unity.GameObject.Find";
inline constexpr std::string_view kGameObjectTransform = "unity.GameObject.transform";
inline constexpr std::string_view kGameObjectComponent = "unity.GameObject.GetComponent";
inline constexpr std::string_view kComponentGameObject = "unity.Component.gameObject";
inline constexpr std::string_view kTransformChildCount = "unity.Transform.childCount";
inline constexpr std::string_view kTransformChild = "unity.Transform.GetChild";
inline constexpr std::string_view kTransformFind = "unity.Transform.Find";

/// `UnityEngine.UI.Graphic::set_color`, which every coloured UI element goes
/// through — detoured rather than called, so the game recolouring an element is
/// what puts our colour back. See `HealthBarTint.h`.
inline constexpr std::string_view kGraphicSetColor = "unity.Graphic.set_color";

/// `UnityEngine.Application::Quit`, detoured to notice that the game is going
/// away while there is still a runtime to let go of. See `QuitWatch.h`.
inline constexpr std::string_view kApplicationQuit = "unity.Application.Quit";

/// The camera, and the one thing worth asking it: where a point in the world
/// lands on the screen. Inverted, that is where the mouse is pointing — which
/// nothing else in either process knows. See `ScreenProjection.h`.
inline constexpr std::string_view kCameraMain = "unity.Camera.main";
inline constexpr std::string_view kWorldToScreenPoint = "unity.Camera.WorldToScreenPoint";

// **How big the frame is does not come from here**, and two attempts at making
// it say so are worth a line each. `UnityEngine.Screen` cannot be resolved at
// all — the resolver only sees classes the runtime has built, and this game
// never touches that one. `Camera.pixelWidth` resolves and is the wrong number:
// it is the camera's own viewport, which in this game is narrower than the
// window because the HUD sits beside the map, while `WorldToScreenPoint`
// answers in whole-frame pixels. The frame's real size is the back buffer, and
// the overlay is already holding it — see `Overlay::render_width`.

/// Where an entity keeps the properties the module reads and writes.
///
/// `ViewHandler` is the component the game puts on each map object's scene
/// node; `destroyEntity` is its handle on the entity itself, and the entity is
/// what holds an `ObjectProperties`.
inline constexpr std::string_view kViewHandlerEntity = "map.ViewHandler.destroyEntity";
inline constexpr std::string_view kPropertiesIsPlayer = "map.ObjectProperties.isPlayer";
inline constexpr std::string_view kPropertiesCollisionRadius =
    "map.ObjectProperties.collisionRadiusMultiplier";

/// The two hops from the local player to the UI manager that draws over it: the
/// `ViewHandler` every map object carries, and the manager that handler holds.
///
/// **From the player object, not from the scene.** Walking the scene for a node
/// named "Player" was tried and finds *a* player — in a map with three hundred
/// of them, usually somebody else, and a line shown on their manager appears
/// over their head. The reference implementation reads these two fields off the
/// local player pointer, which is the player by construction. See
/// `FloatingText.h`.
inline constexpr std::string_view kMapObjectViewHandler = "map.MapObject.viewHandler";
inline constexpr std::string_view kViewHandlerUiManager = "map.ViewHandler.GUIManager";

/// The managed route used to find a loaded Arcane Style. Applying it goes
/// through the local player's setter; see `PlayerFields.h`.
inline constexpr std::string_view kApplicationShaderEffects =
    "map.ApplicationManager.ShaderEffects";
inline constexpr std::string_view kShaderEffectLibrary = "map.ShaderEffectManager.Library";
inline constexpr std::string_view kShaderLibraryItems = "map.ShaderLibrary.items";
inline constexpr std::string_view kShaderPropertiesId = "map.ShaderProperties.id";

/// The two calls that put something over the map. **The same managed name, told
/// apart by how many arguments they take** — a live run listed them:
///
///   `ShowFloatingText(kind, System.String, Nullable<Color32>, float, float, float)`
///   `ShowFloatingText(kind, System.Int32,  Nullable<Color32>, float)`
///
/// The first is what a line of ours goes out through. The second is what the
/// game itself calls all day — damage and experience are *numbers* — and it is
/// detoured to be read, because its first argument is the same enumeration and
/// that is the only way to learn a value of it. See `FloatingText.h`.
///
/// **Queried by name and argument count**, which nothing else here is. That
/// signature runs through an enumeration whose type name is obfuscator output
/// and a `Nullable<Color32>`, so writing the shape out would be a guess at
/// spellings rather than the disambiguation a signature is for — and a wrong
/// spelling refuses a method that is sitting right there. The name alone was
/// tried first and a live run refused it as ambiguous, which is these two.
inline constexpr std::string_view kShowFloatingText = "ui.MapObjectUIManager.ShowFloatingText";
inline constexpr std::string_view kShowFloatingNumber =
    "ui.MapObjectUIManager.ShowFloatingText.number";

/// The classes a feature needs as a *class* rather than as an offset — Unity's
/// `GetComponent` takes a type, and a field is matched to `ObjectProperties` by
/// the name the runtime gives its declared type.
[[nodiscard]] const ClassQuery& ViewHandlerClass() noexcept;
[[nodiscard]] const ClassQuery& ObjectPropertiesClass() noexcept;
[[nodiscard]] const ClassQuery& ImageClass() noexcept;

/// Resolves whatever is still missing, and is cheap once nothing is.
///
/// Called on every turn of the loop for the same reason the player's are: the
/// engine's classes are registered when the runtime gets round to them, and a
/// class the game has not used yet is missing in exactly the way a renamed one
/// is.
///
/// @returns how many keys resolved on this call.
std::size_t ResolveSceneMethods(OffsetTable& table);
std::size_t ResolveSceneFields(OffsetTable& table);

}  // namespace brownie::game
