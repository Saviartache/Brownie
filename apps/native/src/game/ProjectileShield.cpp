#include "game/ProjectileShield.h"

#include <cmath>
#include <utility>

#include "game/PlayerRoute.h"

namespace brownie::game {
namespace {

/// The initialiser, as the compiler generated it.
///
/// **This prototype and `kInitQuery` in `ProjectileFields.cpp` are halves of
/// one claim**, exactly as `AimHook`'s are: the query says which method, this
/// says how to call it, and a managed method called through the wrong prototype
/// does not fail but corrupts. Here the two halves check each other, which is
/// rarer and worth saying: the query pins the argument *count* at twelve, so a
/// build whose initialiser takes a different number of them resolves nothing
/// and installs nothing rather than calling through this.
///
/// What the query cannot pin is which of the twelve are floats, because that is
/// what puts an argument in an XMM register instead of a general one. Read off
/// the recovered signature, in order:
///
/// ```text
/// ObjectProperties, ProjectileProperties, Int32, UInt32, Single, Int32,
/// String, String, Single, Single, Boolean, Boolean
/// ```
///
/// and checked against the prologue, which reads its last two booleans from
/// `[rsp+0A8h]` and `[rsp+0B0h]` — the eleventh and twelfth stack slots of
/// exactly this layout.
///
/// Every argument is forwarded untouched; the only one this file has any use
/// for is `self`, which the method also hands back. The trailing `MethodInfo*`
/// is IL2CPP's, present on every managed method and unused by an instance
/// method reached through its entry point.
using ShotInitFn = void* (*)(void* self, void* object_properties, void* projectile_properties,
                             std::int32_t owner_id, std::uint32_t bullet_id, float angle,
                             std::int32_t damage, void* texture_name, void* effect_name,
                             float x_scale, float y_scale, bool flag_a, bool flag_b,
                             void* method_info);

/// The one projectile shield in this process. See `AimHook.cpp` for why a
/// file-level pointer is the honest answer here and not a lapse.
ProjectileShield* g_shield = nullptr;

/// Let the game build the shot, then take it apart.
///
/// **After the original and not before.** The size and both flags are written
/// by the very method this wraps — the size from the shot's own properties, the
/// flags from its owner's — so anything written on the way in is overwritten on
/// the way through.
void* ShotInitDetour(void* self, void* object_properties, void* projectile_properties,
                     std::int32_t owner_id, std::uint32_t bullet_id, float angle,
                     std::int32_t damage, void* texture_name, void* effect_name, float x_scale,
                     float y_scale, bool flag_a, bool flag_b, void* method_info) {
    ProjectileShield* shield = g_shield;
    if (shield == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls — there is no original left to call, so the shot
        // cannot be built. Handing back the object unbuilt is the only answer
        // available and it is the one that changes least: the caller gets the
        // projectile it passed in.
        return self;
    }

    void* projectile = reinterpret_cast<ShotInitFn>(shield->init_original())(
        self, object_properties, projectile_properties, owner_id, bullet_id, angle, damage,
        texture_name, effect_name, x_scale, y_scale, flag_a, flag_b, method_info);

    // The method returns the shot it initialised, which is its own `this`. Used
    // rather than `self` so that a build where those come apart — a subclass
    // that hands back something else — acts on the object the game will fly.
    shield->Guard(projectile);
    return projectile;
}

}  // namespace

std::optional<ShotEdit> PlanShotEdit(ShieldMode mode, float multiplier) noexcept {
    switch (mode) {
        case ShieldMode::Off:
            return std::nullopt;

        case ShieldMode::Shrink: {
            // Refused rather than clamped, which is the opposite of what the
            // player's own collider does with its multiplier and is deliberate:
            // that one has a value it can fall back on — the game's — while a
            // nonsense scale here would be applied to every shot in the realm
            // before anybody noticed. A mode whose number does not make sense
            // does nothing at all.
            if (!std::isfinite(multiplier) || multiplier < 0.0F || multiplier > 1.0F) {
                return std::nullopt;
            }
            // A scale of exactly one is the game's own shot. Saying "no edit"
            // rather than writing the number back is what keeps the counter
            // honest: nothing was guarded.
            if (multiplier == 1.0F) {
                return std::nullopt;
            }
            ShotEdit edit;
            edit.scale_collision_half = true;
            edit.collision_scale = multiplier;
            return edit;
        }

        case ShieldMode::Disarm: {
            ShotEdit edit;
            edit.set_flags = true;
            edit.damages_players = 0;
            // Already nought on every shot this can reach — the two flags are
            // opposites and the guard only lets through shots carrying the
            // other one — so this write says what the shot should be rather
            // than changing it. Stated rather than skipped because "set the
            // flags" is then one thing both modes mean, and a mode that wrote
            // one flag and left the other would be a shot half turned.
            edit.damages_enemies = 0;
            return edit;
        }

        case ShieldMode::Redirect: {
            ShotEdit edit;
            edit.set_flags = true;
            edit.damages_players = 0;
            edit.damages_enemies = 1;
            return edit;
        }
    }
    return std::nullopt;
}

ProjectileShield::~ProjectileShield() {
    Remove();
}

Status ProjectileShield::Install(const ShotFieldRoute& route, void* init) {
    if (installed()) {
        return {};
    }
    if (g_shield != nullptr && g_shield != this) {
        return Error{ErrorCode::kInvalidArgument, "another projectile shield is already installed"};
    }
    if (init == nullptr) {
        return Error{ErrorCode::kNotReady, "the projectile initialiser has to be resolved first"};
    }
    if (!route.complete()) {
        return Error{ErrorCode::kNotReady, "the projectile fields have not all resolved"};
    }

    auto hook = hooks::Hook::Create(init, reinterpret_cast<void*>(&ShotInitDetour));
    if (!hook.ok()) {
        return hook.error();
    }

    init_ = std::move(hook).value();
    // Published before the detour is enabled, because a shot can be fired on
    // the game's thread the instant it is — and a detour whose original is
    // still null would hand back an uninitialised projectile.
    init_original_ = init_.original<void*>();
    route_ = route;
    g_shield = this;

    if (auto enabled = init_.Enable(); !enabled.ok()) {
        Detach();
        return enabled.error();
    }

    live_.store(true, std::memory_order_release);
    return {};
}

void ProjectileShield::Remove() noexcept {
    // Nothing new is taken apart from the moment this returns, whatever is
    // still inside the detour.
    SetMode(ShieldMode::Off);
    Detach();
}

void ProjectileShield::Detach() noexcept {
    live_.store(false, std::memory_order_release);

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it replaces, so once this returns no shot is
    // being built through the detour.
    init_ = hooks::Hook{};
    init_original_ = nullptr;
    route_ = ShotFieldRoute{};
    if (g_shield == this) {
        g_shield = nullptr;
    }
}

void ProjectileShield::Guard(void* projectile) noexcept {
    // The commonest call by far — the feature is off — and it costs one load.
    const auto edit = PlanShotEdit(mode_.load(std::memory_order_relaxed),
                                   multiplier_.load(std::memory_order_relaxed));
    if (!edit.has_value()) {
        return;
    }

    // **The guard, and the reason nothing here can disarm the player.** Read
    // before anything is written, and a shot without this flag is left exactly
    // as the game built it.
    std::uint8_t damages_players = 0;
    if (!ReadField(projectile, route_.damages_players_at, damages_players) ||
        damages_players == 0) {
        return;
    }

    if (edit->scale_collision_half) {
        float half = 0.0F;
        if (!ReadField(projectile, route_.collision_half_at, half)) {
            return;
        }
        // Scaled rather than replaced: a shot's size is its own, and one number
        // for all of them would make the big shots small and the small big.
        if (!WriteField(projectile, route_.collision_half_at, half * edit->collision_scale)) {
            return;
        }
    }

    if (edit->set_flags) {
        // `damagesPlayers` first, which is the one that makes the shot
        // harmless. A write that lands and a write that does not would
        // otherwise be able to leave a shot hunting monsters while still
        // hunting the player.
        if (!WriteField(projectile, route_.damages_players_at, edit->damages_players)) {
            return;
        }
        if (!WriteField(projectile, route_.damages_enemies_at, edit->damages_enemies)) {
            return;
        }
    }

    guarded_.fetch_add(1, std::memory_order_relaxed);
}

}  // namespace brownie::game
