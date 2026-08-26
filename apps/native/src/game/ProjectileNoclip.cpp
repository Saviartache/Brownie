#include "game/ProjectileNoclip.h"

#include <utility>

#include "game/PlayerRoute.h"

namespace brownie::game {
namespace {

/// The two methods, as the compiler generated them.
///
/// **These prototypes and the queries in `ProjectileFields.cpp` are halves of
/// one claim**, exactly as `AimHook`'s are: the query says which method, this
/// says how to call it, and a managed method called through the wrong prototype
/// does not fail but corrupts. The two are written together and changed
/// together.
///
/// The trailing `MethodInfo*` is IL2CPP's, present on every managed method and
/// unused by an instance method reached through its entry point.
using HitsWallFn = bool (*)(void* self, std::int32_t x, std::int32_t y, void* method_info);
using TileBlocksFn = bool (*)(void* self, std::int32_t x, std::int32_t y, void* method_info);

/// The one projectile noclip in this process. See `AimHook.cpp` for why a
/// file-level pointer is the honest answer here and not a lapse.
ProjectileNoclip* g_noclip = nullptr;

/// The square this thread has put aside, if any.
///
/// **Per thread, not per hook.** Taking and putting back are the two ends of
/// one call, so two threads asking about two shots at once must not share one
/// slot — one would put back the other's square and leave its own passable for
/// good. The game asks about its shots on its own thread, so in practice there
/// is one of these; it costs a thread-local load to make the case where that
/// stops being true harmless instead of permanent.
thread_local TileSwap t_swap;

/// The outer check: run the game's own, then put back whatever the inner
/// detour changed underneath it.
bool HitsWallDetour(void* self, std::int32_t x, std::int32_t y, void* method_info) {
    ProjectileNoclip* hook = g_noclip;
    if (hook == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls — there is no original left to call, so an answer has
        // to be invented, and it is the one that grants nothing: a shot that
        // stops at a wall is what the game does anyway.
        return true;
    }

    // Anything left over from an inner call that did not come through here.
    // A no-op in the ordinary flow, where the line below has just restored it.
    t_swap.Restore();

    const bool blocked = reinterpret_cast<HitsWallFn>(hook->hits_wall_original())(self, x, y,
                                                                                  method_info);
    // The end of the scope the inner detour opened. Unconditional, because a
    // swap that is not put back is a square that stays passable.
    t_swap.Restore();
    return blocked;
}

/// The inner test: run the game's own, and if it says "wall", make the square
/// passable for as long as the outer check takes to look at it.
bool TileBlocksDetour(void* self, std::int32_t x, std::int32_t y, void* method_info) {
    ProjectileNoclip* hook = g_noclip;
    if (hook == nullptr) {
        return true;
    }

    const bool blocked = reinterpret_cast<TileBlocksFn>(hook->tile_blocks_original())(self, x, y,
                                                                                      method_info);
    if (blocked) {
        hook->LetThrough(self, t_swap);
    }
    // The game's own answer, unchanged. What the outer check acts on is the
    // square, which it re-reads for itself.
    return blocked;
}

}  // namespace

bool TileSwap::Apply(void* projectile, const ProjectileTileRoute& route) noexcept {
    if (held() || projectile == nullptr || !route.complete()) {
        return false;
    }

    // Whether this is one of the player's own shots. The guard on everything
    // below, and the reason a half-resolved route installs nothing.
    std::uint8_t damages_enemies = 0;
    if (!ReadField(projectile, route.damages_enemies_at, damages_enemies) ||
        damages_enemies == 0) {
        return false;
    }

    void* tile = nullptr;
    if (!ReadField(projectile, route.tile_at, tile) || tile == nullptr) {
        return false;
    }

    std::int32_t layer = 0;
    if (!ReadField(tile, route.layer_at, layer)) {
        return false;
    }
    if (layer == kPassableLayer) {
        // Already the value that would be written. Saying "nothing was taken"
        // is what keeps a restore from writing a layer this never read.
        return false;
    }
    if (!WriteField(tile, route.layer_at, kPassableLayer)) {
        return false;
    }

    // Recorded only once the write succeeded: half a swap is a restore to an
    // address that was never changed.
    tile_ = tile;
    layer_at_ = route.layer_at;
    saved_ = layer;
    return true;
}

void TileSwap::Restore() noexcept {
    if (tile_ == nullptr) {
        return;
    }
    // Dropped whether or not the write lands. A square whose memory has gone
    // away since cannot be put back, and holding the pointer to try again on
    // the next shot would be holding a freed one.
    (void)WriteField(tile_, layer_at_, saved_);
    tile_ = nullptr;
}

ProjectileNoclip::~ProjectileNoclip() {
    Remove();
}

Status ProjectileNoclip::Install(const ProjectileTileRoute& route, void* hits_wall,
                                 void* tile_blocks) {
    if (installed()) {
        return {};
    }
    if (g_noclip != nullptr && g_noclip != this) {
        return Error{ErrorCode::kInvalidArgument, "another projectile noclip is already installed"};
    }
    if (hits_wall == nullptr || tile_blocks == nullptr) {
        return Error{ErrorCode::kNotReady, "both collision methods have to be resolved first"};
    }
    if (!route.complete()) {
        return Error{ErrorCode::kNotReady, "the projectile and tile fields have not all resolved"};
    }

    // Both trampolines before either detour is live: the pair is one mechanism
    // and half of it is worse than none.
    auto outer = hooks::Hook::Create(hits_wall, reinterpret_cast<void*>(&HitsWallDetour));
    if (!outer.ok()) {
        return outer.error();
    }
    auto inner = hooks::Hook::Create(tile_blocks, reinterpret_cast<void*>(&TileBlocksDetour));
    if (!inner.ok()) {
        return inner.error();
    }

    hits_wall_ = std::move(outer).value();
    tile_blocks_ = std::move(inner).value();
    // Published before anything is enabled, because a shot can arrive on the
    // game's thread the instant one is — and a detour whose original is still
    // null would jump into nothing.
    hits_wall_original_ = hits_wall_.original<void*>();
    tile_blocks_original_ = tile_blocks_.original<void*>();
    route_ = route;
    g_noclip = this;

    // **The outer first, and the order is load-bearing.** The inner is what
    // makes a square passable and the outer is what puts it back, so an inner
    // running on its own would leave a hole in the map that nothing closes.
    if (auto enabled = hits_wall_.Enable(); !enabled.ok()) {
        Detach();
        return enabled.error();
    }
    if (auto enabled = tile_blocks_.Enable(); !enabled.ok()) {
        Detach();
        return enabled.error();
    }

    live_.store(true, std::memory_order_release);
    return {};
}

void ProjectileNoclip::Remove() noexcept {
    // Nothing new is taken from the moment this returns, whatever is still
    // inside a detour.
    SetEnabled(false);
    Detach();
}

void ProjectileNoclip::Detach() noexcept {
    live_.store(false, std::memory_order_release);

    // **The inner first.** Removing a hook suspends every other thread and
    // fixes up any instruction pointer inside the code it replaces, so once
    // this returns nothing can take another square — while the outer is still
    // there to put back anything a thread is holding.
    tile_blocks_ = hooks::Hook{};
    hits_wall_ = hooks::Hook{};
    tile_blocks_original_ = nullptr;
    hits_wall_original_ = nullptr;
    route_ = ProjectileTileRoute{};
    if (g_noclip == this) {
        g_noclip = nullptr;
    }
}

void ProjectileNoclip::LetThrough(void* projectile, TileSwap& swap) noexcept {
    // The commonest call by far — the feature is off — and it costs one load.
    if (!enabled_.load(std::memory_order_relaxed)) {
        return;
    }
    if (swap.Apply(projectile, route_)) {
        passed_.fetch_add(1, std::memory_order_relaxed);
    }
}

}  // namespace brownie::game
