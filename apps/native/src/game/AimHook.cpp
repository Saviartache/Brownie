#include "game/AimHook.h"

#include <Windows.h>

namespace brownie::game {
namespace {

/// The two methods, as the compiler generated them.
///
/// **These prototypes and the queries in `PlayerFields.cpp` are halves of one
/// claim.** The query says which method; this says how to call it. A managed
/// method called through the wrong prototype does not fail, it corrupts —
/// arguments land in the wrong registers and the callee returns into a stack it
/// did not build — so the two are written together and changed together.
///
/// The trailing `MethodInfo*` is IL2CPP's, present on every managed method and
/// unused by an instance method reached through its entry point.
using ComputeShootAngleFn = void (*)(void* self, std::uint8_t slot, float* out_angle,
                                     bool* out_can_shoot, bool flag, void* method_info);
using ShootWithAngleFn = void (*)(void* self, float angle, void* method_info);

/// The one aim hook in this process.
///
/// File-level state, which this project otherwise refuses — justified for the
/// same reason the overlay's is: a detour is a C callback with nowhere to carry
/// a `this`. `Install` refuses a second, so which one this refers to is never a
/// question, and it is the only global here: everything else a detour needs it
/// reaches through this one pointer.
AimHook* g_hook = nullptr;

void ComputeShootAngleDetour(void* self, std::uint8_t slot, float* out_angle, bool* out_can_shoot,
                             bool flag, void* method_info) {
    AimHook* hook = g_hook;
    if (hook == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls — but the check costs a comparison and the
        // alternative is a jump through a null trampoline.
        return;
    }
    // The original runs first and its verdict stands. Whether the player may
    // shoot at all — cooldown, ammo, being stunned — is the client's decision
    // and none of this feature's business; only where the shot goes is.
    reinterpret_cast<ComputeShootAngleFn>(hook->compute_original())(self, slot, out_angle,
                                                                   out_can_shoot, flag,
                                                                   method_info);

    // **What the original just wrote is not kept, and that is a correction.**
    // It was, on the argument that an `out float angle` from a method called
    // `ComputeShootAngle` is where the player is pointing. A live session says
    // otherwise: it is `0` on every call, for every mouse position, so
    // everything that ranked by it ranked by due east. Where the cursor is now
    // comes from the camera, which can simply be asked — see
    // `game/ScreenProjection.h`.
    float angle = 0.0F;
    if (out_angle != nullptr && hook->AngleFor(self, angle)) {
        *out_angle = angle;
    }
}

void ShootWithAngleDetour(void* self, float angle, void* method_info) {
    AimHook* hook = g_hook;
    if (hook == nullptr) {
        return;
    }
    // **The cursor is not read here, on purpose.** By the time a shot reaches
    // this method the compute detour has already replaced the angle with the
    // aimed one, so keeping it would be keeping this feature's own output and
    // calling it the player's aim — a loop that locks onto whatever it happened
    // to pick first. The client's angle is only trustworthy where it is still
    // the client's, which is the compute detour and nowhere else.
    float aimed = 0.0F;
    if (hook->AngleFor(self, aimed)) {
        angle = aimed;
    }
    reinterpret_cast<ShootWithAngleFn>(hook->shoot_original())(self, angle, method_info);
}

}  // namespace

AimHook::~AimHook() {
    Remove();
}

Status AimHook::InstallOne(hooks::Hook& hook, void* target, void* detour, void*& original) {
    if (hook.installed()) {
        return {};
    }
    if (target == nullptr) {
        return Error{ErrorCode::kNotReady, "that method has not been resolved yet"};
    }

    auto created = hooks::Hook::Create(target, detour);
    if (!created.ok()) {
        return created.error();
    }
    hook = std::move(created).value();

    // The trampoline is published before the detour is enabled, because a shot
    // can arrive on the game's thread the instant it is — and a detour whose
    // original is still null would jump into nothing.
    original = hook.original<void*>();
    g_hook = this;

    if (auto enabled = hook.Enable(); !enabled.ok()) {
        hook = hooks::Hook{};
        original = nullptr;
        return enabled.error();
    }
    return {};
}

Status AimHook::Install(void* compute_shoot_angle, void* shoot_with_angle) {
    if (g_hook != nullptr && g_hook != this) {
        return Error{ErrorCode::kInvalidArgument, "another aim hook is already installed"};
    }

    // Each is attempted whatever the other did. One resolving a turn before the
    // other is the ordinary case — IL2CPP builds their classes when it gets
    // round to it — and refusing the first for want of the second would mean
    // aiming worked only when both arrived together.
    const Status compute =
        InstallOne(compute_, compute_shoot_angle, reinterpret_cast<void*>(&ComputeShootAngleDetour),
                   compute_original_);
    const Status shoot = InstallOne(
        shoot_, shoot_with_angle, reinterpret_cast<void*>(&ShootWithAngleDetour), shoot_original_);

    if (installed()) {
        return {};
    }
    return compute.ok() ? shoot : compute;
}

void AimHook::Remove() noexcept {
    // Aim first: a shot already inside a detour must find nothing to redirect
    // rather than an object being taken apart.
    Clear();

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it is replacing, so once these return no further
    // detour can begin.
    compute_ = hooks::Hook{};
    shoot_ = hooks::Hook{};
    compute_original_ = nullptr;
    shoot_original_ = nullptr;
    if (g_hook == this) {
        g_hook = nullptr;
    }
}

void AimHook::Aim(void* player, float radians, std::uint64_t expires_at_ms) noexcept {
    if (player == nullptr) {
        Clear();
        return;
    }
    angle_.store(radians, std::memory_order_relaxed);
    expires_at_ms_.store(expires_at_ms, std::memory_order_relaxed);
    // Last, and with a release: a detour that sees the player sees the angle
    // and the deadline that came with it.
    player_.store(player, std::memory_order_release);
}

void AimHook::Clear() noexcept {
    player_.store(nullptr, std::memory_order_release);
}

bool AimHook::AngleFor(const void* self, float& out) noexcept {
    // The commonest call by far — nothing is aimed — and it costs one load.
    void* aimed = player_.load(std::memory_order_acquire);
    if (aimed == nullptr || aimed != self) {
        return false;
    }
    // Checked here as well as in the frame that publishes it, because a render
    // thread that stalls must not leave the player firing at where something
    // used to be.
    if (::GetTickCount64() >= expires_at_ms_.load(std::memory_order_relaxed)) {
        return false;
    }

    out = angle_.load(std::memory_order_relaxed);
    redirected_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

}  // namespace brownie::game
