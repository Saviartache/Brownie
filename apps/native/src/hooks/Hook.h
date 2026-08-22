// Detours, owned.
//
// A hook is a write into executable memory that another thread may be running
// through at that instant. Two rules follow, and both are structural here rather
// than remembered:
//
//   * **A hook is removed by leaving scope.** The reference implementation
//     installed hooks from wherever the feature that wanted them lived and
//     removed them only on a clean shutdown — so an unload at any other moment
//     left the game jumping into a trampoline in memory the module no longer
//     occupied. That is not a leak; it is a crash on the next frame.
//   * **The engine outlives every hook.** MinHook has one process-wide
//     initialisation, and a hook removed after it is torn down is a hook that
//     never gets removed. Declaration order in the owner is what enforces this:
//     declare the engine first, so it is destroyed last.

#pragma once

#include "core/Result.h"

namespace brownie::hooks {

/// MinHook's process-wide state, owned rather than assumed.
///
/// Exactly one of these may exist. `Create` fails rather than quietly sharing an
/// initialisation somebody else performed: two owners of one global teardown is
/// the bug this type exists to make impossible.
class HookEngine {
  public:
    static Result<HookEngine> Create();

    HookEngine(const HookEngine&) = delete;
    HookEngine& operator=(const HookEngine&) = delete;

    HookEngine(HookEngine&& other) noexcept;
    HookEngine& operator=(HookEngine&& other) noexcept;

    ~HookEngine();

  private:
    HookEngine() noexcept = default;

    void Release() noexcept;

    bool owns_ = false;
};

/// One installed detour.
///
/// Created disabled. Installing and enabling are separate because they fail for
/// different reasons and at different moments: installing writes a trampoline,
/// enabling redirects live code, and a caller that wants several hooks to start
/// working together needs the two apart.
class Hook {
  public:
    Hook() noexcept = default;

    /// Installs a detour from `target` to `detour`, disabled.
    ///
    /// Both must be executable code. Nothing here can check that — the caller
    /// resolved them and is the only one that knows what they should be — which
    /// is why every resolver in this project verifies its answer against the
    /// module image before handing it over.
    static Result<Hook> Create(void* target, void* detour);

    Hook(const Hook&) = delete;
    Hook& operator=(const Hook&) = delete;

    Hook(Hook&& other) noexcept;
    Hook& operator=(Hook&& other) noexcept;

    /// Disables and removes. Deliberately not `noexcept`-adjacent bookkeeping:
    /// a failure here cannot be reported to anyone useful, so it is ignored, and
    /// the alternative — leaving the hook installed — is worse.
    ~Hook();

    Status Enable();
    Status Disable();

    [[nodiscard]] bool installed() const noexcept { return target_ != nullptr; }
    [[nodiscard]] bool enabled() const noexcept { return enabled_; }

    /// The original code, to call through from inside the detour.
    ///
    /// Null until installed. A detour that calls this without checking is a
    /// detour that null-jumps on the one path where installation failed.
    template <typename Fn>
    [[nodiscard]] Fn original() const noexcept {
        return reinterpret_cast<Fn>(original_);
    }

  private:
    Hook(void* target, void* original) noexcept : target_{target}, original_{original} {}

    void Remove() noexcept;

    void* target_ = nullptr;
    void* original_ = nullptr;
    bool enabled_ = false;
};

}  // namespace brownie::hooks
