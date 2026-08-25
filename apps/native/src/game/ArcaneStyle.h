#pragma once

#include <atomic>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "game/Il2CppRuntime.h"
#include "game/OffsetTable.h"
#include "game/PlayerRoute.h"

namespace brownie::game {

/// The live effect library identifies player-compatible entries by the paired
/// pet consumable id, while older builds may still expose the player id itself.
[[nodiscard]] bool MatchesArcaneStyle(std::string_view candidate,
                                      std::string_view requested) noexcept;

/// Applies a game-owned ShaderProperties entry to the local player's sprite.
/// Managed objects are found afresh for every pass; only their string ids are
/// retained, so the garbage collector never has to account for a native root.
class ArcaneStyle {
  public:
    void Bind(const Il2CppRuntime& game, const OffsetTable& table);

    /// Applies `wanted`, or restores the value observed before our first write
    /// when `wanted` is empty. Game thread only.
    [[nodiscard]] bool Apply(const Il2CppRuntime& game, const PlayerRoute& route,
                             std::string_view wanted);

    [[nodiscard]] bool holding() const noexcept { return !applied_id_.empty(); }

  private:
    struct FoundProperties {
        void* value;
        std::string id;
    };

    [[nodiscard]] std::optional<FoundProperties> Find(const Il2CppRuntime& game, void* manager,
                                                       std::string_view id);
    [[nodiscard]] std::optional<std::string> IdOf(const Il2CppRuntime& game,
                                                  void* properties) const;
    void Forget() noexcept;

    std::uint32_t player_properties_at_ = 0;
    std::uint32_t library_items_at_ = 0;
    std::uint32_t properties_id_at_ = 0;
    void* get_shader_effects_ = nullptr;
    void* get_library_ = nullptr;
    void* set_player_properties_ = nullptr;
    std::atomic<bool> static_bound_{false};

    /// The closed List<ShaderProperties> class is available only after the game
    /// returns a live list. The game thread publishes it; setup resolves its
    /// generic methods on the IPC thread and publishes those back.
    std::atomic<ClassRef> list_class_{nullptr};
    std::atomic<MethodRef> list_count_{nullptr};
    std::atomic<MethodRef> list_item_{nullptr};

    // Game thread only.
    std::string original_id_;
    std::string applied_id_;
};

}  // namespace brownie::game
