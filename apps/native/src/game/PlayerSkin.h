#pragma once

#include <cstdint>
#include <optional>

#include "game/Il2CppRuntime.h"
#include "game/OffsetTable.h"
#include "game/PlayerRoute.h"

namespace brownie::game {

/// Applies a skin through the local player's own visual update path.
class PlayerSkin {
  public:
    void Bind(const OffsetTable& table) noexcept;

    /// Applies `wanted`, or restores the skin observed before our first write.
    /// Game thread only.
    [[nodiscard]] bool Apply(const Il2CppRuntime& game, const PlayerRoute& route,
                             std::optional<std::int32_t> wanted) noexcept;

    [[nodiscard]] bool holding() const noexcept { return applied_.has_value(); }

  private:
    [[nodiscard]] bool bound() const noexcept { return skin_at_ != 0 && set_skin_ != nullptr; }
    void Forget() noexcept;

    std::uint32_t skin_at_ = 0;
    void* set_skin_ = nullptr;

    // Game thread only.
    std::optional<std::int32_t> original_;
    std::optional<std::int32_t> applied_;
};

}  // namespace brownie::game
