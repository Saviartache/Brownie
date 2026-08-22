#include "hooks/Hook.h"

#include <utility>

#include <MinHook.h>

namespace brownie::hooks {
namespace {

/// Translates MinHook's status into this project's one error type.
///
/// The message is MinHook's own name for the failure. Restating it in our words
/// would mean maintaining a translation that drifts, and the names are already
/// the thing worth searching for.
[[nodiscard]] Error FromMinHook(MH_STATUS status, ErrorCode code) noexcept {
    return Error{code, MH_StatusToString(status)};
}

}  // namespace

Result<HookEngine> HookEngine::Create() {
    const MH_STATUS status = MH_Initialize();
    if (status != MH_OK) {
        // `MH_ERROR_ALREADY_INITIALIZED` lands here on purpose. Treating it as
        // success would produce a second owner of one global teardown, and
        // whichever destructor ran first would remove hooks the other still
        // believed were installed.
        return FromMinHook(status, ErrorCode::kInternal);
    }
    HookEngine engine;
    engine.owns_ = true;
    return engine;
}

HookEngine::HookEngine(HookEngine&& other) noexcept : owns_{std::exchange(other.owns_, false)} {}

HookEngine& HookEngine::operator=(HookEngine&& other) noexcept {
    if (this != &other) {
        Release();
        owns_ = std::exchange(other.owns_, false);
    }
    return *this;
}

HookEngine::~HookEngine() { Release(); }

void HookEngine::Release() noexcept {
    if (owns_) {
        // Removes and disables everything still installed. Hooks are supposed
        // to have gone first — see the header — and this is the backstop, not
        // the mechanism.
        MH_Uninitialize();
        owns_ = false;
    }
}

Result<Hook> Hook::Create(void* target, void* detour) {
    if (target == nullptr || detour == nullptr) {
        return Error{ErrorCode::kInvalidArgument, "a hook needs both a target and a detour"};
    }

    void* original = nullptr;
    const MH_STATUS status = MH_CreateHook(target, detour, &original);
    if (status != MH_OK) {
        return FromMinHook(status, ErrorCode::kInternal);
    }
    return Hook{target, original};
}

Hook::Hook(Hook&& other) noexcept
    : target_{std::exchange(other.target_, nullptr)},
      original_{std::exchange(other.original_, nullptr)},
      enabled_{std::exchange(other.enabled_, false)} {}

Hook& Hook::operator=(Hook&& other) noexcept {
    if (this != &other) {
        Remove();
        target_ = std::exchange(other.target_, nullptr);
        original_ = std::exchange(other.original_, nullptr);
        enabled_ = std::exchange(other.enabled_, false);
    }
    return *this;
}

Hook::~Hook() { Remove(); }

Status Hook::Enable() {
    if (target_ == nullptr) {
        return Error{ErrorCode::kNotReady, "the hook was never installed"};
    }
    if (enabled_) {
        return {};
    }
    const MH_STATUS status = MH_EnableHook(target_);
    if (status != MH_OK) {
        return FromMinHook(status, ErrorCode::kInternal);
    }
    enabled_ = true;
    return {};
}

Status Hook::Disable() {
    if (target_ == nullptr || !enabled_) {
        return {};
    }
    const MH_STATUS status = MH_DisableHook(target_);
    if (status != MH_OK) {
        return FromMinHook(status, ErrorCode::kInternal);
    }
    enabled_ = false;
    return {};
}

void Hook::Remove() noexcept {
    if (target_ == nullptr) {
        return;
    }
    // Disable before remove, and ignore what either says. There is nobody to
    // report to from a destructor, and the only alternative to trying is
    // leaving the game jumping into memory that is about to be unmapped.
    if (enabled_) {
        MH_DisableHook(target_);
        enabled_ = false;
    }
    MH_RemoveHook(target_);
    target_ = nullptr;
    original_ = nullptr;
}

}  // namespace brownie::hooks
