#include "game/PlayerMover.h"

#include <cmath>

namespace brownie::game {
namespace {

/// Close enough to stop asking. Below this the step is smaller than the noise
/// in the position, and issuing it every frame would be a jitter of its own.
constexpr float kArrived = 0.02F;

/// The game's own method, as the compiler generated it.
///
/// IL2CPP gives every managed method a trailing `MethodInfo*`, which an
/// instance method reached through its entry point does not use — the reference
/// implementation passes null here too. The calling convention is the platform
/// default on x64, where the first four arguments travel in registers.
using MoveToFn = bool (*)(void* self, float x, float y, void* method_info);

}  // namespace

void PlayerMover::Bind(void* move_to) noexcept {
    if (ready_.load(std::memory_order_relaxed) || move_to == nullptr) {
        return;
    }
    move_to_ = move_to;
    // Released after the pointer is in place, so a reader that sees the flag
    // sees the method that goes with it.
    ready_.store(true, std::memory_order_release);
}

bool PlayerMover::StepTowards(const PlayerLocation& player, float targetX, float targetY,
                              float maxDistance) const {
    if (!ready_.load(std::memory_order_acquire) || player.object == nullptr ||
        maxDistance <= 0.0F) {
        return false;
    }

    const float dx = targetX - player.x;
    const float dy = targetY - player.y;
    const float distance = std::sqrt(dx * dx + dy * dy);
    if (distance <= kArrived) {
        return false;
    }

    // Same direction, capped magnitude. Past this cap the game does not walk
    // further, it *appears* further — and the server takes it back.
    float stepX = targetX;
    float stepY = targetY;
    if (distance > maxDistance) {
        const float scale = maxDistance / distance;
        stepX = player.x + dx * scale;
        stepY = player.y + dy * scale;
    }

    // No thread attach. This runs on the game's own render thread, which the
    // runtime attached long ago — and attaching a thread that is already
    // attached, inside a frame, is work for nothing at best.
    const auto move = reinterpret_cast<MoveToFn>(move_to_);
    return move(player.object, stepX, stepY, nullptr);
}

}  // namespace brownie::game
