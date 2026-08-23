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
    target.from_player = move.from_player;
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

float RoomToStep(float budget, float own_x, float own_y, float toward_x, float toward_y) noexcept {
    if (!(budget > 0.0F)) {
        return 0.0F;
    }
    const float length = std::sqrt(toward_x * toward_x + toward_y * toward_y);
    if (!(length > 0.0F)) {
        return 0.0F;
    }

    // The near intersection of the step's ray with the circle of everything the
    // frame may reach. `along` is how much of their walking is already going
    // the way the step points — it is what makes agreeing directions cost the
    // step everything and opposing ones cost it nothing.
    const float along = (own_x * toward_x + own_y * toward_y) / length;
    const float spent = own_x * own_x + own_y * own_y;
    const float reach = along * along + budget * budget - spent;
    if (!(reach > 0.0F)) {
        return 0.0F;
    }

    const float room = std::sqrt(reach) - along;
    if (!(room > 0.0F)) {
        return 0.0F;
    }
    return room > budget ? budget : room;
}

void PlayerControl::Bind(const game::Il2CppRuntime& game,
                         const game::PlayerRoute& route) noexcept {
    game_ = &game;
    route_ = route;
    // Released after both are in place, so a frame that sees the flag sees the
    // route and the runtime that go with it.
    ready_.store(true, std::memory_order_release);
}

void PlayerControl::InstallAim(void* compute_shoot_angle, void* shoot_with_angle) {
    if (compute_shoot_angle == nullptr && shoot_with_angle == nullptr) {
        return;
    }
    (void)aim_.Install(compute_shoot_angle, shoot_with_angle);
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

    // Nothing is being walked at until this frame says so. Cleared first so
    // every path out of here leaves an honest answer behind it.
    frame_walking_ = false;

    const std::uint64_t previous = last_frame_at_ms_;
    last_frame_at_ms_ = now_ms;

    if (!ready_.load(std::memory_order_acquire)) {
        player_seen_ = false;
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
        // Nothing was read this frame, so there is no position to measure the
        // next one against — a walk that starts after a quiet stretch would
        // otherwise be charged for every frame of it.
        player_seen_ = false;
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
        player_seen_ = false;
        return;
    }

    // **What the player is spending of the speed limit themselves.** Everything
    // the position moved since the last frame, less whatever this module asked
    // for then: the remainder is theirs, and it does not matter whether it came
    // from the keys, a knockback or the server putting them back. See
    // `RoomToStep` for why it is the sum that has to be bounded.
    //
    // **Unmeasured means no step**, exactly as the first frame after a gap
    // issues none and for the same reason. A frame that had nothing to do
    // skipped the position read, so the frame that takes the wheel after one
    // has nothing to compare against — and the only guess available there errs
    // in the single direction the server punishes.
    float own_x = 0.0F;
    float own_y = 0.0F;
    bool measured = false;
    if (player_seen_) {
        const float moved_x = player.x - last_player_x_ - last_step_x_;
        const float moved_y = player.y - last_player_y_ - last_step_y_;
        // A position read out of an object the game has since given back can be
        // anything at all, and a step sized from one that is not a number is
        // not a number either.
        if (std::isfinite(moved_x) && std::isfinite(moved_y)) {
            own_x = moved_x;
            own_y = moved_y;
            measured = true;
        }
    }
    player_seen_ = true;
    last_player_x_ = player.x;
    last_player_y_ = player.y;
    last_step_x_ = 0.0F;
    last_step_y_ = 0.0F;

    if (walking) {
        // **An offset is resolved here and nowhere else.** The runtime cannot
        // do it: where the player is reaches it on the server's tick, five
        // times a second, while this runs every frame — so a heading it turned
        // into a place would be a place the character had already walked past.
        frame_walk_x_ = frame_target_.from_player ? player.x + frame_target_.x : frame_target_.x;
        frame_walk_y_ = frame_target_.from_player ? player.y + frame_target_.y : frame_target_.y;
        frame_walking_ = true;

        const float toward_x = frame_walk_x_ - player.x;
        const float toward_y = frame_walk_y_ - player.y;
        const float distance = std::sqrt(toward_x * toward_x + toward_y * toward_y);
        const float room =
            measured ? RoomToStep(StepBudget(now_ms - previous, frame_target_.speed), own_x, own_y,
                                  toward_x, toward_y)
                     : 0.0F;
        if (mover_.StepTowards(player, frame_walk_x_, frame_walk_y_, room) && distance > 0.0F) {
            // Remembered so the next frame reads back their walking and not
            // ours. What the mover was asked for, which is the direction at
            // whichever of the two lengths is shorter — see `StepTowards`.
            const float carried = distance < room ? distance : room;
            last_step_x_ = (toward_x / distance) * carried;
            last_step_y_ = (toward_y / distance) * carried;
        }
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
