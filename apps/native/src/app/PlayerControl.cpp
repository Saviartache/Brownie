#include "app/PlayerControl.h"

#include <cmath>

namespace brownie::app {

/// The hold a record asks for, bounded. See {@link kMaxHoldMs}.
namespace {
[[nodiscard]] std::uint64_t HeldFor(std::int32_t hold_ms) noexcept {
    const std::int32_t bounded = hold_ms > kMaxHoldMs ? kMaxHoldMs : hold_ms;
    return bounded > 0 ? static_cast<std::uint64_t>(bounded) : 0;
}

/// Turns a chord measured over `span_ms` into the tangent at its far end.
///
/// A velocity measured between two positions points along the line joining
/// them, which for a target going round a circle is the direction it had
/// halfway through — half a window's turn behind the one it has now. Rotating
/// by that half turn puts it back on the heading, and dividing by the sine
/// restores the speed the chord lost to the corner it cut.
///
/// A rate small enough to be noise is left alone: the correction divides by its
/// own sine on the way, and a straight line is what a target that is not
/// turning has anyway.
void TurnChordToTangent(float angular_velocity_per_ms, std::uint64_t span_ms, float& x,
                        float& y) noexcept {
    const double half_turn = static_cast<double>(angular_velocity_per_ms) *
                             static_cast<double>(span_ms) / 2.0;
    if (!std::isfinite(half_turn) || std::abs(half_turn) < 1e-6 || std::abs(half_turn) > 1.0) {
        return;
    }
    const double scale = half_turn / std::sin(half_turn);
    const double cos = std::cos(half_turn);
    const double sin = std::sin(half_turn);
    const double turned_x = (static_cast<double>(x) * cos - static_cast<double>(y) * sin) * scale;
    const double turned_y = (static_cast<double>(x) * sin + static_cast<double>(y) * cos) * scale;
    if (!std::isfinite(turned_x) || !std::isfinite(turned_y)) {
        return;
    }
    x = static_cast<float>(turned_x);
    y = static_cast<float>(turned_y);
}
}  // namespace

MoveTarget MoveTargetFrom(const overlay::MoveCommand& move, std::uint64_t now_ms) noexcept {
    MoveTarget target;
    target.wanted = true;
    target.x = static_cast<float>(move.x_hundredths) / 100.0F;
    target.y = static_cast<float>(move.y_hundredths) / 100.0F;
    target.speed = static_cast<float>(move.speed_hundredths) / 100.0F;
    target.expires_at_ms = now_ms + HeldFor(move.hold_ms);
    target.from_player = move.from_player;
    target.once = move.once;
    return target;
}

AimTarget AimTargetFrom(const overlay::AimCommand& aim, std::uint64_t now_ms) noexcept {
    AimTarget target;
    target.wanted = true;
    target.x = static_cast<float>(aim.x_hundredths) / 100.0F;
    target.y = static_cast<float>(aim.y_hundredths) / 100.0F;
    target.expires_at_ms = now_ms + HeldFor(aim.hold_ms);
    target.object_id = aim.object_id;
    target.target_x = static_cast<float>(aim.target_x_hundredths) / 100.0F;
    target.target_y = static_cast<float>(aim.target_y_hundredths) / 100.0F;
    target.has_motion = aim.has_motion;
    if (aim.has_motion) {
        // **Tiles a second on the wire, tiles a millisecond here.** Every speed
        // on the link is stated per second, because that is the unit a person
        // reading the overlay thinks in; every duration in the solver is a
        // millisecond, because that is what a flight time and a lifetime are
        // already stated in. This is the one place the two meet.
        target.shot.velocity_x = static_cast<float>(aim.velocity_x_hundredths) / 100000.0F;
        target.shot.velocity_y = static_cast<float>(aim.velocity_y_hundredths) / 100000.0F;
        target.shot.angular_velocity_per_ms =
            static_cast<float>(aim.angular_velocity_milli) / 1000000.0F;
        target.shot.bullet_speed_tiles_per_ms =
            static_cast<float>(aim.bullet_speed_hundredths) / 100000.0F;
        target.shot.max_flight_ms = static_cast<float>(aim.max_flight_ms);
        target.shot.lead = static_cast<float>(aim.lead_permille) / 1000.0F;
        target.shot.lead_lag_ms = static_cast<float>(aim.lead_lag_ms);
    }
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
        // And nothing the readings of the old map said is about this one: ids
        // are unique within a map and re-used across one, so a ring kept over
        // would be two monsters' positions subtracted from each other.
        target_motion_.Clear();
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
            // **What the step actually achieved, read back rather than
            // assumed** — and the difference is a bug that drove the character
            // into walls.
            //
            // The next frame works out what the player spent of the limit
            // themselves by subtracting our step from the ground that appeared
            // under them. Subtract a step the game *refused* — a wall, a
            // closed door, the client's own clamp — and their own movement
            // comes back short by exactly the amount that did not happen; the
            // frame after that reads that as room to spare and pushes harder,
            // which is a loop that ends with a character grinding along
            // geometry for as long as the record stands.
            //
            // The position is one read off an object already in hand, and the
            // game's method has already returned, so this is what happened
            // rather than what was asked for. It also folds in everything else
            // the call did on the way — the game's own speed clamp, a knockback
            // applied inside it — none of which the arithmetic here could know.
            float after_x = 0.0F;
            float after_y = 0.0F;
            if (game::ReadPosition(player.object, route_, after_x, after_y)) {
                last_step_x_ = after_x - player.x;
                last_step_y_ = after_y - player.y;
            } else {
                // The object went away inside the call, which is a realm change
                // arriving at an awkward moment. What was asked for is the best
                // guess left, and the next frame measures nothing anyway.
                const float carried = distance < room ? distance : room;
                last_step_x_ = (toward_x / distance) * carried;
                last_step_y_ = (toward_y / distance) * carried;
            }
            // **Spent by the frame that stepped, not by the frame that saw
            // it.** An offset is resolved from wherever the player is now, so a
            // one-shot target left standing would be carried again on the next
            // frame and every frame of the hold after it — which is a sprint,
            // and is exactly what the server takes back. A frame with nothing
            // to measure their own walking against issues no step and leaves
            // the target for the next one; the hold still bounds the wait.
            if (frame_target_.once) {
                frame_target_.wanted = false;
            }
        }
    }

    if (aiming) {
        // **Held in locals, never written back.** A frame with no new target
        // reuses the one it already has, so anything folded into the published
        // copy would be applied again next frame, and again the frame after —
        // an aim walking away from the monster it is chasing.
        float aim_x = frame_aim_.x;
        float aim_y = frame_aim_.y;

        // **Where the client has the enemy, which is what a shot is tested
        // against.** Bullet collision in this game is the client's own: it
        // moves its bullets, tests them against its own copy of the monsters
        // and reports the hit it has already made. The runtime only ever had a
        // reconstruction of that copy, rebuilt from packets and smoothed
        // between server ticks.
        //
        // **Read into locals of its own and believed only whole.** A lookup
        // that fails partway can have written one coordinate already, and a
        // position read out of an object the game has since given back can be
        // anything at all — either would be half the client's monster and half
        // the runtime's, which is a place neither of them has anything at.
        float client_x = 0.0F;
        float client_y = 0.0F;
        const bool seen =
            frame_aim_.object_id != 0 &&
            game::FindMapObject(*game_, map_objects_, frame_aim_.object_id, client_x, client_y) &&
            std::isfinite(client_x) && std::isfinite(client_y);

        // So: the client's reading where there is one, and the runtime's where
        // there is not — an aim that named no enemy, tables that have not
        // resolved, an enemy not in them. Each of those leaves this feature
        // exactly where it stood before any of it existed.
        const float seen_x = seen ? client_x : frame_aim_.target_x;
        const float seen_y = seen ? client_y : frame_aim_.target_y;

        // **And how fast the client is moving it, measured the same way.** One
        // reading a frame, differenced over a window, is the velocity of the
        // very thing a bullet is tested against — where the runtime's is
        // derived from the packets, which describe a monster the client is
        // still winding its own copy up to. The two agree while a monster holds
        // its pace and part company the moment it changes one, always the same
        // way round: the packets run ahead of what is drawn, so a lead built on
        // them is sent in front of the monster, and further in front the faster
        // it moves. See `game/TargetMotion.h`.
        if (seen) {
            target_motion_.Observe(frame_aim_.object_id, seen_x, seen_y, now_ms);
        }

        // **The lead is worked out here, from the two positions only this side
        // has.** The runtime chose the enemy and said how everything moves;
        // where the player and the monster actually are is the game's own
        // answer, read this frame. Both go into the flight time and the flight
        // time is the whole of the lead — so a player charging a monster is led
        // onto it rather than a stride past it, which is what the runtime's own
        // arithmetic could not do from a position it hears five times a second.
        bool solved = false;
        if (frame_aim_.has_motion) {
            game::AimShot shot = frame_aim_.shot;
            shot.shooter_x = player.x;
            shot.shooter_y = player.y;
            shot.target_x = seen_x;
            shot.target_y = seen_y;

            // The measured velocity where there is one, and the runtime's until
            // there is — a target a few frames old has no span to divide over,
            // and a lead from the packet stream is a great deal better than no
            // lead at all. Which of the two is in use changes nothing else: the
            // solver is handed a velocity either way.
            float measured_x = 0.0F;
            float measured_y = 0.0F;
            std::uint64_t span_ms = 0;
            if (seen && target_motion_.VelocityOf(frame_aim_.object_id, now_ms, measured_x,
                                                  measured_y, span_ms)) {
                // A displacement over a window is a chord, and its direction
                // belongs at the middle of that window rather than at the end.
                // For anything going round in a circle that is half a window's
                // turn behind the heading the monster actually has, so it is
                // rotated up to it — the same correction the runtime's own
                // tracker makes, and for the same reason. The turn rate itself
                // stays the runtime's: it is a rate, and rates are the half the
                // server's tick answers well.
                TurnChordToTangent(shot.angular_velocity_per_ms, span_ms, measured_x, measured_y);
                shot.velocity_x = measured_x;
                shot.velocity_y = measured_y;
            }
            solved = game::SolveAimPoint(shot, aim_x, aim_y);
        }
        if (!solved && seen) {
            // No solution to work with, so the runtime's point stands and only
            // the monster under it is corrected. The point is already a lead
            // and how far ahead of the monster it sits is what has to survive,
            // so the difference is applied to it rather than replacing it.
            aim_x = frame_aim_.x + (seen_x - frame_aim_.target_x);
            aim_y = frame_aim_.y + (seen_y - frame_aim_.target_y);
        }
        // What the overlay draws, so the picture is the shot rather than the
        // record behind it. The same argument {@link WalkTarget} makes.
        frame_aim_shown_x_ = aim_x;
        frame_aim_shown_y_ = aim_y;

        // **The angle is worked out here, not in the detour.** The detour runs
        // inside the game's own shot path, where the cheapest thing that could
        // go wrong is a stutter; here there is a frame's worth of room and the
        // player's position has just been read anyway.
        //
        // Standing exactly on the target names no direction, and `atan2(0, 0)`
        // is a direction the game would take literally — as it would an angle
        // that is not a number, which is what a position read out of an object
        // the game gave back mid-frame would make of this.
        const float dx = aim_x - player.x;
        const float dy = aim_y - player.y;
        if (!std::isfinite(dx) || !std::isfinite(dy) || (dx == 0.0F && dy == 0.0F)) {
            aim_.Clear();
        } else {
            aim_.Aim(player.object, std::atan2(dy, dx), frame_aim_.expires_at_ms);
        }
    }
}

}  // namespace brownie::app
