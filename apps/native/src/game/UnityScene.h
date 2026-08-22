// Unity's object model, as the seven calls the module makes into it.
//
// **Every call here is a call into managed code, so every call here is the
// game's own thread's.** The rule is the one `PlayerMover` states: a read of
// stale memory returns nonsense, but a call from a thread the runtime does not
// expect corrupts the runtime. So `Bind` is the IPC thread's and everything
// below it runs from inside the `Present` detour, on the thread the game itself
// calls these methods on.
//
// **Nothing is cached between passes.** A `GameObject` found this second is
// destroyed on the next realm change, and a `Transform` kept across one points
// at memory the collector has given back. What is cached is the *shape* — which
// method is where — and that settles once for the run.
//
// **These calls are not cheap and are not meant to be made often.**
// `GameObject.Find` walks the scene; the reference module ran its whole pass
// twice a second and no faster. Everything here is behind a cadence for that
// reason, and none of it belongs on a per-frame path.

#pragma once

#include <atomic>
#include <span>

#include "game/Il2CppRuntime.h"
#include "game/OffsetTable.h"

namespace brownie::game {

class UnityScene {
  public:
    UnityScene() noexcept = default;

    UnityScene(const UnityScene&) = delete;
    UnityScene& operator=(const UnityScene&) = delete;
    UnityScene(UnityScene&&) = delete;
    UnityScene& operator=(UnityScene&&) = delete;

    /// Takes the entry points out of the table, once they are all there.
    /// **IPC thread.**
    ///
    /// All or nothing: a scene walk that can find an object but not descend
    /// into it is a walk that stops on its first step, and publishing a partial
    /// set would mean every caller checking each method it is about to use.
    /// Asked again on every turn until it succeeds, because IL2CPP registers
    /// the engine's classes when it gets round to them.
    void Bind(const Il2CppRuntime& game, const OffsetTable& table) noexcept;

    /// Whether the whole set is in place. Callable from either thread.
    [[nodiscard]] bool bound() const noexcept { return ready_.load(std::memory_order_acquire); }

    // --- Everything below: game thread only, and null on any failure. A null
    // --- is the ordinary answer — between realms there is no scene to walk —
    // --- so every caller treats it as "nothing to do this pass".

    /// `GameObject.Find(name)`. Walks the scene; the expensive one.
    [[nodiscard]] void* FindObject(const char* name) const;

    /// `GameObject.transform`.
    [[nodiscard]] void* TransformOf(void* game_object) const;

    /// `Transform.childCount`. Negative is impossible and is reported as zero,
    /// because the count comes out of the game and bounds a loop.
    [[nodiscard]] int ChildCount(void* transform) const;

    /// `Transform.GetChild(index)`.
    [[nodiscard]] void* ChildAt(void* transform, int index) const;

    /// `Transform.Find(name)` — one named child, or a path of them separated by
    /// slashes, exactly as Unity spells it.
    [[nodiscard]] void* ChildNamed(void* transform, const char* name) const;

    /// The chain of named children, one hop at a time.
    ///
    /// Not one slash-separated path: the names in this game's UI contain
    /// trailing spaces and are read from a list, and building a path string
    /// from them on every pass would allocate to say what a loop says already.
    [[nodiscard]] void* Descend(void* transform, std::span<const char* const> names) const;

    /// `Component.gameObject`, for going back up from a transform.
    [[nodiscard]] void* GameObjectOf(void* component) const;

    /// `GameObject.GetComponent(type)`, where the type is built from `klass`.
    [[nodiscard]] void* ComponentOf(void* game_object, ClassRef klass) const;

  private:
    /// The runtime, for the managed strings and types these calls take. Null
    /// until bound, and published with the addresses.
    const Il2CppRuntime* game_ = nullptr;

    void* find_ = nullptr;
    void* transform_of_ = nullptr;
    void* child_count_ = nullptr;
    void* child_at_ = nullptr;
    void* child_named_ = nullptr;
    void* game_object_of_ = nullptr;
    void* component_of_ = nullptr;

    /// Written last with a release, read first with an acquire: a caller that
    /// sees this sees every pointer above it.
    std::atomic<bool> ready_{false};
};

}  // namespace brownie::game
