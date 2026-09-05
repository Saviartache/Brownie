#include "game/PlayerTileSpeed.h"

#include <utility>

#include "game/PlayerRoute.h"

namespace brownie::game {
namespace {

/// The two methods, as the compiler generated them.
///
/// **These prototypes and the queries in `PlayerFields.cpp` are halves of one
/// claim**, exactly as `ProjectileNoclip`'s are: the query says which method,
/// this says how to call it, and a managed method called through the wrong
/// prototype does not fail but corrupts. The two are written and changed
/// together.
///
/// The trailing `MethodInfo*` is IL2CPP's, present on every managed method and
/// unused by an instance method reached through its entry point.
using TileSpeedFn = float (*)(void* self, void* method_info);
using ApplyTileSpeedFn = void (*)(void* self, void* method_info);

/// The one tile-speed gate in this process. See `AimHook.cpp` for why a detour
/// has nowhere else to keep this.
PlayerTileSpeed* g_gate = nullptr;

float TileSpeedDetour(void* self, void* method_info) {
    PlayerTileSpeed* gate = g_gate;
    if (gate == nullptr || gate->tile_speed_original() == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls. There is no original left to ask, so an answer has
        // to be invented, and the honest one is the number that changes
        // nothing about how fast the character walks.
        return kFullTileSpeed;
    }
    if (gate->DenyTileSpeed()) {
        return kFullTileSpeed;
    }
    return reinterpret_cast<TileSpeedFn>(gate->tile_speed_original())(self, method_info);
}

void ApplyTileSpeedDetour(void* self, void* method_info) {
    PlayerTileSpeed* gate = g_gate;
    if (gate == nullptr) {
        return;
    }
    void* const original = gate->apply_original();
    if (original != nullptr) {
        // The game's own first, so that the sinking it keeps track of is the
        // client's account and not this module's. Only the number it derives
        // from that is corrected.
        reinterpret_cast<ApplyTileSpeedFn>(original)(self, method_info);
    }
    gate->KeepFullSpeed(self);
}

}  // namespace

PlayerTileSpeed::~PlayerTileSpeed() {
    Remove();
}

Status PlayerTileSpeed::Install(void* tile_speed, void* apply_tile_speed,
                                std::uint32_t multiplier_at) {
    if (installed()) {
        // Already in. Asking again is the loop retrying, not a second pair.
        return {};
    }
    if (g_gate != nullptr && g_gate != this) {
        return Error{ErrorCode::kInvalidArgument, "another tile-speed gate is already installed"};
    }
    if (tile_speed == nullptr || apply_tile_speed == nullptr) {
        return Error{ErrorCode::kNotReady, "both speed methods have to be resolved first"};
    }
    if (multiplier_at == 0) {
        return Error{ErrorCode::kNotReady, "the player's speed multiplier has not resolved"};
    }

    // Both trampolines before either detour is live: the pair is one mechanism
    // and half of it does nothing the other half does not undo.
    auto asked = hooks::Hook::Create(tile_speed, reinterpret_cast<void*>(&TileSpeedDetour));
    if (!asked.ok()) {
        return asked.error();
    }
    auto stored = hooks::Hook::Create(apply_tile_speed,
                                      reinterpret_cast<void*>(&ApplyTileSpeedDetour));
    if (!stored.ok()) {
        return stored.error();
    }

    tile_speed_ = std::move(asked).value();
    apply_ = std::move(stored).value();
    // Published before anything is enabled, because the game can ask the
    // instant one is — and a detour whose original is still null would answer
    // for a method it never replaced.
    tile_speed_original_ = tile_speed_.original<void*>();
    apply_original_ = apply_.original<void*>();
    multiplier_at_ = multiplier_at;
    g_gate = this;

    if (auto enabled = tile_speed_.Enable(); !enabled.ok()) {
        Detach();
        return enabled.error();
    }
    if (auto enabled = apply_.Enable(); !enabled.ok()) {
        Detach();
        return enabled.error();
    }

    live_.store(true, std::memory_order_release);
    return {};
}

void PlayerTileSpeed::Remove() noexcept {
    // Switched off first: a call already inside a detour must find a feature
    // that wants nothing rather than an object being taken apart.
    SetEnabled(false);
    Detach();
}

void PlayerTileSpeed::Detach() noexcept {
    live_.store(false, std::memory_order_release);

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it is replacing, so once these return no further
    // detour can begin and what they read can be cleared.
    apply_ = hooks::Hook{};
    tile_speed_ = hooks::Hook{};
    apply_original_ = nullptr;
    tile_speed_original_ = nullptr;
    multiplier_at_ = 0;
    if (g_gate == this) {
        g_gate = nullptr;
    }
}

bool PlayerTileSpeed::DenyTileSpeed() noexcept {
    if (!enabled_.load(std::memory_order_relaxed)) {
        return false;
    }
    denied_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

void PlayerTileSpeed::KeepFullSpeed(void* player) noexcept {
    // The commonest call by far — the feature is off — and it costs one load.
    if (!enabled_.load(std::memory_order_relaxed) || multiplier_at_ == 0) {
        return;
    }
    // Counted only when the write lands: a number that was not put back is not
    // a slowdown that was denied.
    if (WriteField(player, multiplier_at_, kFullTileSpeed)) {
        denied_.fetch_add(1, std::memory_order_relaxed);
    }
}

}  // namespace brownie::game
