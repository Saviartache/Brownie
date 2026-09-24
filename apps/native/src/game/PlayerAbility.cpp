#include "game/PlayerAbility.h"

#include <bit>
#include <cmath>

#include "core/Clock.h"

namespace brownie::game {
namespace {

/// The method, as the compiler generated it.
///
/// **This prototype and the query in `PlayerFields.cpp` are halves of one
/// claim**, for the reason `AimHook.cpp` gives. The enumeration travels as its
/// underlying `int`, in the register the fourth argument always takes.
using UseAbilityFn = bool (*)(void* self, float x, float y, std::int32_t press,
                              void* method_info);

/// The one ability detour in this process. File-level for the reason `g_hook`
/// in `AimHook.cpp` is, and the only global here.
PlayerAbility* g_ability = nullptr;

/// Both coordinates in one word, and back.
[[nodiscard]] std::uint64_t Pack(float x, float y) noexcept {
    return (static_cast<std::uint64_t>(std::bit_cast<std::uint32_t>(x)) << 32) |
           std::bit_cast<std::uint32_t>(y);
}

void Unpack(std::uint64_t packed, float& x, float& y) noexcept {
    x = std::bit_cast<float>(static_cast<std::uint32_t>(packed >> 32));
    y = std::bit_cast<float>(static_cast<std::uint32_t>(packed & 0xFFFFFFFFU));
}

bool UseAbilityDetour(void* self, float x, float y, std::int32_t press, void* method_info) {
    PlayerAbility* ability = g_ability;
    if (ability == nullptr) {
        // Unreachable on any path `Remove` controls, and "not used" is the
        // honest answer from a method that cannot be reached.
        return false;
    }

    // **No test of `self`.** The method belongs to the local player's own
    // class, so the only object that ever arrives here is the player — unlike
    // the shot the aim hook sees, which every player in the realm makes.
    float aimed_x = 0.0F;
    float aimed_y = 0.0F;
    if (press == static_cast<std::int32_t>(AbilityPress::kStartUse) && !ability->casting() &&
        ability->AimFor(aimed_x, aimed_y)) {
        x = aimed_x;
        y = EngineY(aimed_y);
    }
    return reinterpret_cast<UseAbilityFn>(ability->original())(self, x, y, press, method_info);
}

}  // namespace

PlayerAbility::~PlayerAbility() {
    Remove();
}

void PlayerAbility::Bind(void* use_ability) noexcept {
    if (ready_.load(std::memory_order_relaxed) || use_ability == nullptr) {
        return;
    }
    use_ability_ = use_ability;
    // Released after the pointer is in place, so a frame that sees the flag
    // sees the method that goes with it.
    ready_.store(true, std::memory_order_release);
}

Status PlayerAbility::InstallAim() {
    if (hook_.installed()) {
        return {};
    }
    if (!ready_.load(std::memory_order_acquire)) {
        return Error{ErrorCode::kNotReady, "the ability method has not been resolved yet"};
    }
    if (g_ability != nullptr && g_ability != this) {
        return Error{ErrorCode::kInvalidArgument, "another ability detour is already installed"};
    }

    auto created = hooks::Hook::Create(use_ability_, reinterpret_cast<void*>(&UseAbilityDetour));
    if (!created.ok()) {
        return created.error();
    }
    hook_ = std::move(created).value();

    // Published before the detour is enabled: a press can arrive on the game's
    // thread the instant it is, and a detour whose original is still null would
    // jump into nothing.
    original_ = hook_.original<void*>();
    g_ability = this;

    if (auto enabled = hook_.Enable(); !enabled.ok()) {
        hook_ = hooks::Hook{};
        original_ = nullptr;
        g_ability = nullptr;
        return enabled.error();
    }
    return {};
}

void PlayerAbility::Remove() noexcept {
    // The aim first: a press already inside the detour must find nothing to
    // point rather than an object being taken apart.
    ClearAim();

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it replaced, so once this returns no further
    // detour can begin.
    hook_ = hooks::Hook{};
    original_ = nullptr;
    if (g_ability == this) {
        g_ability = nullptr;
    }
}

void PlayerAbility::Aim(float x, float y, std::uint64_t expires_at_ms) noexcept {
    // A point that is not a number would be handed to the game as a place to
    // throw something, which is not a thing the key can ever produce.
    if (!std::isfinite(x) || !std::isfinite(y)) {
        ClearAim();
        return;
    }
    point_.store(Pack(x, y), std::memory_order_relaxed);
    expires_at_ms_.store(expires_at_ms, std::memory_order_release);
}

void PlayerAbility::ClearAim() noexcept {
    expires_at_ms_.store(0, std::memory_order_release);
}

bool PlayerAbility::AimFor(float& x, float& y) noexcept {
    // Checked here rather than trusted to whoever published it: a runtime that
    // went quiet must not leave the player's presses going somewhere a monster
    // used to stand.
    const std::uint64_t expires = expires_at_ms_.load(std::memory_order_acquire);
    if (expires == 0 || NowMs() >= expires) {
        return false;
    }
    Unpack(point_.load(std::memory_order_relaxed), x, y);
    redirected_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

bool PlayerAbility::Cast(void* player, float x, float y) {
    if (!ready_.load(std::memory_order_acquire) || player == nullptr || !std::isfinite(x) ||
        !std::isfinite(y)) {
        return false;
    }

    // Through the method's own entry, detour and all, with the flag saying
    // whose call this is. Calling the trampoline instead would skip the detour
    // only once it exists, and whether it does is the IPC thread's to change —
    // the flag is the frame's own and cannot be changed under it.
    //
    // No thread attach: this is the game's main thread, which IL2CPP has known
    // since before the first frame. It is *only* that — see `MainThreadTick.h`
    // for what this call did on the render thread, where `Present` runs.
    casting_ = true;
    const bool used = reinterpret_cast<UseAbilityFn>(use_ability_)(
        player, x, EngineY(y), static_cast<std::int32_t>(AbilityPress::kStartUse), nullptr);
    casting_ = false;
    return used;
}

}  // namespace brownie::game
