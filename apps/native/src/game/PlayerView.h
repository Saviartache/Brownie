// Getting from the scene to the local player's view.
//
// Two features start from the same place: the node the game names "Player", and
// the `ViewHandler` component hanging off one of its children. `PlayerCollision`
// goes on from there to the entity's properties, `FloatingText` to the UI
// manager that draws over the map. The walk itself is the same, was written
// twice, and is here once.
//
// **Which child holds the handler has changed between builds**, so every child
// is asked and the first that answers is used — and "answers" means the visitor
// found what it came for, not merely that the child had a component. A child
// with a handler whose field reads fail must not stop the search, which is why
// this is an iteration with a verdict rather than a lookup returning one.
//
// **Game thread only.** Every call it makes goes into Unity.

#pragma once

#include "game/Metadata.h"
#include "game/UnityScene.h"

namespace brownie::game {

/// The scene node the game gives the local player.
///
/// One of the names it does not obfuscate — the node is found by it in every
/// build the reference module ran against, and there is nothing else to find it
/// by: a scene object has a name and no type.
inline constexpr const char* kPlayerNode = "Player";

/// Calls `visit` with each `ViewHandler` on a child of the player's node until
/// one returns true.
///
/// @returns whether any visit returned true. False is the ordinary answer at
///   the login screen, between realms and while a map is being rebuilt — there
///   is no player node then.
template <typename Fn>
[[nodiscard]] bool ForEachPlayerViewHandler(const UnityScene& scene, ClassRef view_handler,
                                            Fn visit) {
    if (view_handler == nullptr || !scene.bound()) {
        return false;
    }

    void* const root = scene.TransformOf(scene.FindObject(kPlayerNode));
    if (root == nullptr) {
        return false;
    }

    const int children = scene.ChildCount(root);
    for (int index = 0; index < children; ++index) {
        void* const handler =
            scene.ComponentOf(scene.GameObjectOf(scene.ChildAt(root, index)), view_handler);
        if (handler == nullptr) {
            continue;
        }
        if (visit(handler)) {
            return true;
        }
    }
    return false;
}

}  // namespace brownie::game
