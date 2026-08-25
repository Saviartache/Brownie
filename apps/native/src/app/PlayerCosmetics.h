#pragma once

#include <atomic>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "app/Cadence.h"
#include "game/ArcaneStyle.h"
#include "game/Il2CppRuntime.h"
#include "game/OffsetTable.h"
#include "game/PlayerGlow.h"
#include "game/PlayerRoute.h"
#include "game/PlayerSkin.h"
#include "game/UnityColor.h"

namespace brownie::app {

/// Owns the local player's native cosmetic overrides and their restoration.
class PlayerCosmetics {
  public:
    static constexpr std::uint32_t kPassIntervalMs = 100;

    void AdvanceSetup(const game::Il2CppRuntime& game, const game::OffsetTable& table);
    void BindPlayer(const game::PlayerRoute& route) noexcept;

    /// Records the current claims. Game thread only.
    void Want(std::optional<std::int32_t> skin, std::string_view arcane_style,
              std::optional<game::UiColor> glow);

    /// Applies changed claims and periodically repairs game-driven rebuilds.
    /// Game thread only.
    void Apply(std::uint64_t now_ms);

  private:
    game::PlayerSkin skin_;
    game::ArcaneStyle arcane_style_;
    game::PlayerGlow glow_;

    game::PlayerRoute route_{};
    std::atomic<bool> route_ready_{false};
    std::atomic<const game::Il2CppRuntime*> game_{nullptr};

    // Game thread only.
    std::optional<std::int32_t> wanted_skin_;
    std::string wanted_style_;
    std::optional<game::UiColor> wanted_glow_;
    bool changed_ = false;
    Cadence pass_{kPassIntervalMs};
};

}  // namespace brownie::app
