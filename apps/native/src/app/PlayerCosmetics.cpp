#include "app/PlayerCosmetics.h"

namespace brownie::app {

void PlayerCosmetics::AdvanceSetup(const game::Il2CppRuntime& game,
                                   const game::OffsetTable& table) {
    skin_.Bind(table);
    arcane_style_.Bind(game, table);
    glow_.Bind(game, table);
    game_.store(&game, std::memory_order_release);
}

void PlayerCosmetics::BindPlayer(const game::PlayerRoute& route) noexcept {
    route_ = route;
    route_ready_.store(true, std::memory_order_release);
}

void PlayerCosmetics::Want(std::optional<std::int32_t> skin, std::string_view arcane_style,
                           std::optional<game::UiColor> glow) {
    if (wanted_skin_ != skin) {
        wanted_skin_ = skin;
        changed_ = true;
    }
    if (wanted_style_ != arcane_style) {
        wanted_style_.assign(arcane_style);
        changed_ = true;
    }
    // Compared rather than assigned, like the two above: a colour that has not
    // moved must not make this pass do work, because the pass that follows a
    // change is the one allowed to rebuild the character's visual.
    if (wanted_glow_.has_value() != glow.has_value() ||
        (glow.has_value() && !(*wanted_glow_ == *glow))) {
        wanted_glow_ = glow;
        changed_ = true;
    }
}

void PlayerCosmetics::Apply(std::uint64_t now_ms) {
    const bool skin_active = wanted_skin_.has_value() || skin_.holding();
    const bool style_active = !wanted_style_.empty() || arcane_style_.holding();
    const bool glow_active = wanted_glow_.has_value() || glow_.holding();
    if ((!skin_active && !style_active && !glow_active) ||
        !route_ready_.load(std::memory_order_acquire) || (!changed_ && !pass_.Due(now_ms))) {
        return;
    }

    const auto* runtime = game_.load(std::memory_order_acquire);
    if (runtime == nullptr) {
        return;
    }
    const game::ThreadScope scope{runtime->api(), runtime->domain()};
    if (!scope.attached()) {
        return;
    }

    if (skin_active) {
        (void)skin_.Apply(*runtime, route_, wanted_skin_);
    }
    if (style_active) {
        (void)arcane_style_.Apply(*runtime, route_, wanted_style_);
    }
    if (glow_active) {
        (void)glow_.Apply(*runtime, route_, wanted_glow_);
    }
    changed_ = false;
}

}  // namespace brownie::app
