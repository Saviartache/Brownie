#include "game/UnityScene.h"

#include "game/SceneFields.h"

namespace brownie::game {
namespace {

/// The engine's methods, as the compiler generated them.
///
/// **These prototypes and the queries in `SceneFields.cpp` are halves of one
/// claim.** The query says which method; this says how to call it. A managed
/// method called through the wrong prototype does not fail, it corrupts — so
/// the two are written together and changed together.
///
/// The trailing `MethodInfo*` is IL2CPP's, present on every managed method. It
/// is passed as null for the same reason `PlayerMover` does: a non-generic
/// method reached through its own entry point does not read it.
using FindFn = void* (*)(void* name, void* method_info);
using TransformOfFn = void* (*)(void* self, void* method_info);
using ChildCountFn = int (*)(void* self, void* method_info);
using ChildAtFn = void* (*)(void* self, int index, void* method_info);
using ChildNamedFn = void* (*)(void* self, void* name, void* method_info);
using GameObjectOfFn = void* (*)(void* self, void* method_info);
using ComponentOfFn = void* (*)(void* self, void* type, void* method_info);

/// The most children one transform may be walked through.
///
/// The count comes out of the game's own memory and bounds a loop that calls
/// into managed code on every turn. A UI node with more children than this is
/// not a node this module was looking at.
constexpr int kMaxChildren = 4096;

}  // namespace

void UnityScene::Bind(const Il2CppRuntime& game, const OffsetTable& table) noexcept {
    if (ready_.load(std::memory_order_relaxed)) {
        return;
    }

    // Taken into locals first, so a half-filled object is never published: the
    // release below is what makes the whole set visible at once.
    void* const find = table.MethodAddress(kFindGameObject).value_or(nullptr);
    void* const transform_of = table.MethodAddress(kGameObjectTransform).value_or(nullptr);
    void* const child_count = table.MethodAddress(kTransformChildCount).value_or(nullptr);
    void* const child_at = table.MethodAddress(kTransformChild).value_or(nullptr);
    void* const child_named = table.MethodAddress(kTransformFind).value_or(nullptr);
    void* const game_object_of = table.MethodAddress(kComponentGameObject).value_or(nullptr);
    void* const component_of = table.MethodAddress(kGameObjectComponent).value_or(nullptr);

    if (find == nullptr || transform_of == nullptr || child_count == nullptr ||
        child_at == nullptr || child_named == nullptr || game_object_of == nullptr ||
        component_of == nullptr) {
        return;
    }

    game_ = &game;
    find_ = find;
    transform_of_ = transform_of;
    child_count_ = child_count;
    child_at_ = child_at;
    child_named_ = child_named;
    game_object_of_ = game_object_of;
    component_of_ = component_of;
    ready_.store(true, std::memory_order_release);
}

void* UnityScene::FindObject(const char* name) const {
    if (!bound() || name == nullptr) {
        return nullptr;
    }
    void* const managed = game_->NewString(name);
    if (managed == nullptr) {
        return nullptr;
    }
    return reinterpret_cast<FindFn>(find_)(managed, nullptr);
}

void* UnityScene::TransformOf(void* game_object) const {
    if (!bound() || game_object == nullptr) {
        return nullptr;
    }
    return reinterpret_cast<TransformOfFn>(transform_of_)(game_object, nullptr);
}

int UnityScene::ChildCount(void* transform) const {
    if (!bound() || transform == nullptr) {
        return 0;
    }
    const int count = reinterpret_cast<ChildCountFn>(child_count_)(transform, nullptr);
    if (count <= 0) {
        return 0;
    }
    return count < kMaxChildren ? count : kMaxChildren;
}

void* UnityScene::ChildAt(void* transform, int index) const {
    if (!bound() || transform == nullptr || index < 0) {
        return nullptr;
    }
    return reinterpret_cast<ChildAtFn>(child_at_)(transform, index, nullptr);
}

void* UnityScene::ChildNamed(void* transform, const char* name) const {
    if (!bound() || transform == nullptr || name == nullptr) {
        return nullptr;
    }
    void* const managed = game_->NewString(name);
    if (managed == nullptr) {
        return nullptr;
    }
    return reinterpret_cast<ChildNamedFn>(child_named_)(transform, managed, nullptr);
}

void* UnityScene::Descend(void* transform, std::span<const char* const> names) const {
    void* current = transform;
    for (const char* const name : names) {
        current = ChildNamed(current, name);
        if (current == nullptr) {
            // The panel is not built yet, or this build spells one of its nodes
            // differently. Either way there is nothing below it.
            return nullptr;
        }
    }
    return current;
}

void* UnityScene::GameObjectOf(void* component) const {
    if (!bound() || component == nullptr) {
        return nullptr;
    }
    return reinterpret_cast<GameObjectOfFn>(game_object_of_)(component, nullptr);
}

void* UnityScene::ComponentOf(void* game_object, ClassRef klass) const {
    if (!bound() || game_object == nullptr || klass == nullptr) {
        return nullptr;
    }
    // Built here rather than kept: the runtime caches the `System.Type` it
    // makes for a class, so asking again is a lookup — and a managed reference
    // held in native memory is one the collector cannot see.
    void* const type = game_->TypeObject(klass);
    if (type == nullptr) {
        return nullptr;
    }
    return reinterpret_cast<ComponentOfFn>(component_of_)(game_object, type, nullptr);
}

}  // namespace brownie::game
