#include "app/PlayerControl.h"

#include <cmath>

namespace brownie::app {

MoveTarget MoveTargetFrom(const overlay::MoveCommand& move, std::uint64_t now_ms) noexcept {
    MoveTarget target;
    target.wanted = true;
    target.x = static_cast<float>(move.x_hundredths) / 100.0F;
    target.y = static_cast<float>(move.y_hundredths) / 100.0F;
    target.speed = static_cast<float>(move.speed_hundredths) / 100.0F;
    target.expires_at_ms = now_ms + static_cast<std::uint64_t>(move.hold_ms);
    return target;
}

AimTarget AimTargetFrom(const overlay::AimCommand& aim, std::uint64_t now_ms) noexcept {
    AimTarget target;
    target.wanted = true;
    target.x = static_cast<float>(aim.x_hundredths) / 100.0F;
    target.y = static_cast<float>(aim.y_hundredths) / 100.0F;
    target.expires_at_ms = now_ms + static_cast<std::uint64_t>(aim.hold_ms);
    return target;
}

float StepBudget(std::uint64_t elapsed_ms, float speed) noexcept {
    const float seconds =
        static_cast<float>(elapsed_ms > kMaxFrameMs ? kMaxFrameMs : elapsed_ms) / 1000.0F;
    const float budget = speed * seconds;
    return budget > kMaxStepTiles ? kMaxStepTiles : budget;
}

void PlayerControl::Bind(const game::Il2CppRuntime& game,
                         const game::PlayerRoute& route) noexcept {
    game_ = &game;
    route_ = route;
    // Released after both are in place, so a frame that sees the flag sees the
    // route and the runtime that go with it.
    ready_.store(true, std::memory_order_release);
}

PlayerControl::AimInstall PlayerControl::InstallAim(void* compute_shoot_angle,
                                                    void* shoot_with_angle) {
    AimInstall added;
    if (compute_shoot_angle == nullptr && shoot_with_angle == nullptr) {
        return added;
    }

    const bool had_compute = aim_.compute_installed();
    const bool had_shoot = aim_.shoot_installed();
    (void)aim_.Install(compute_shoot_angle, shoot_with_angle);

    added.compute_added = aim_.compute_installed() != had_compute;
    added.shoot_added = aim_.shoot_installed() != had_shoot;
    return added;
}

bool PlayerControl::Locate(game::PlayerLocation& out) const {
    if (!ready_.load(std::memory_order_acquire)) {
        return false;
    }
    return game::LocatePlayer(*game_, route_, out);
}

void PlayerControl::AimAt(const AimTarget& target) {
    aim_target_.Publish(target);
    // The runtime only sends these while auto-aim is on, so this is the
    // module's whole answer to "does anybody want the detours".
    aim_wanted_ = true;
}

void PlayerControl::Apply(std::uint64_t now_ms) {
    // Refreshed by version: the common frame copies nothing at all.
    move_target_.Refresh(frame_target_, frame_target_version_);
    aim_target_.Refresh(frame_aim_, frame_aim_version_);

    const std::uint64_t previous = last_frame_at_ms_;
    last_frame_at_ms_ = now_ms;

    if (!ready_.load(std::memory_order_acquire)) {
        return;
    }

    // **Everything cheap is decided before the player is looked for.** Finding
    // it is four reads that cannot be cached across frames, and on most frames
    // the answer to "is there anything to do" is no: no target, an expired one,
    // or a shot that is not due yet.
    //
    // A step is a distance over a time, so the first frame after a gap has none
    // to work with and issues nothing.
    const bool walking = frame_target_.wanted && now_ms < frame_target_.expires_at_ms &&
                         previous != 0 && now_ms > previous;
    const bool aiming = frame_aim_.wanted && now_ms < frame_aim_.expires_at_ms && aim_.installed();
    if (!walking && !aiming) {
        // Whatever was aimed at has expired or been withdrawn. Said out loud
        // rather than left to the hook's own deadline: the player gets their
        // own aim back on the next shot, not on the next frame that happens to
        // check.
        aim_.Clear();
        return;
    }

    // Walked afresh rather than cached: a pointer kept across a realm change
    // points at memory that has been given back, and this one is about to be
    // handed to the game as its own `this`. Once per frame, though, however
    // many features act on it.
    game::PlayerLocation player;
    if (!game::LocatePlayer(*game_, route_, player)) {
        // No player right now — between realms, at the login screen, during a
        // map rebuild. Nothing to aim from, so nothing is aimed.
        aim_.Clear();
        return;
    }

    if (walking) {
        (void)mover_.StepTowards(player, frame_target_.x, frame_target_.y,
                                 StepBudget(now_ms - previous, frame_target_.speed));
    }

    if (aiming) {
        // **The angle is worked out here, not in the detour.** The detour runs
        // inside the game's own shot path, where the cheapest thing that could
        // go wrong is a stutter; here there is a frame's worth of room and the
        // player's position has just been read anyway.
        //
        // Standing exactly on the target names no direction, and `atan2(0, 0)`
        // is a direction the game would take literally.
        const float dx = frame_aim_.x - player.x;
        const float dy = frame_aim_.y - player.y;
        if (dx == 0.0F && dy == 0.0F) {
            aim_.Clear();
        } else {
            aim_.Aim(player.object, std::atan2(dy, dx), frame_aim_.expires_at_ms);
        }
    }
}

}  // namespace brownie::app
