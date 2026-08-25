#include "game/PlayerSkin.h"

#include "game/PlayerFields.h"

namespace brownie::game {

void PlayerSkin::Bind(const OffsetTable& table) noexcept {
    if (skin_at_ == 0) {
        skin_at_ = table.FieldOffset(kPlayerSkin).value_or(0);
    }
    if (set_skin_ == nullptr) {
        set_skin_ = table.MethodAddress(kSetPlayerSkin).value_or(nullptr);
    }
}

bool PlayerSkin::Apply(const Il2CppRuntime& game, const PlayerRoute& route,
                       std::optional<std::int32_t> wanted) noexcept {
    if (!bound()) {
        return false;
    }
    void* const player = FindPlayer(game, route);
    std::int32_t current = 0;
    if (player == nullptr || !ReadField(player, skin_at_, current)) {
        return false;
    }

    using SetSkin = void (*)(void*, std::int32_t, void*);
    if (!wanted.has_value()) {
        if (!applied_.has_value()) {
            return false;
        }
        if (current != *applied_) {
            Forget();
            return false;
        }
        reinterpret_cast<SetSkin>(set_skin_)(player, *original_, nullptr);
        Forget();
        return true;
    }

    if (!applied_.has_value() || current != *applied_) {
        original_ = current;
    } else if (current == *wanted) {
        return false;
    }
    reinterpret_cast<SetSkin>(set_skin_)(player, *wanted, nullptr);
    applied_ = *wanted;
    return true;
}

void PlayerSkin::Forget() noexcept {
    original_.reset();
    applied_.reset();
}

}  // namespace brownie::game
