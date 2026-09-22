// Where to point so that a shot and a moving target arrive at the same place.
//
// **The arithmetic lives here so that the frame can do it.** The runtime holds
// the world model and picks the enemy, but it cannot answer this question: an
// intercept is a distance divided by a shot's speed, the distance is measured
// from wherever the player *actually* is, and only the game knows that. What
// reaches the runtime is the client's position once a server tick and its own
// reconstruction of the monsters between them — so a lead worked out over there
// is a lead for a shooter who has since run up to two tiles, and for a monster
// the client is drawing somewhere else. Both errors go into the flight time,
// and the flight time is the whole of the lead.
//
// So the runtime sends *rates* — how the target is moving, how fast the shot
// travels, how long it lives — and the frame supplies the *positions*, out of
// the game's own memory, on the frame the shot is about to be fired. Rates are
// the half the server's tick answers well: a velocity is a displacement per
// tick and does not care which frame reads it. Positions are the half only the
// client has.
//
// Nothing here reads the game, allocates, locks or throws. It is a closed piece
// of arithmetic over its argument, which is what lets the self-test hammer it
// with numbers instead of with a session.
//
// The mirror of `apps/runtime/src/features/autoaim/intercept.ts`, deliberately:
// the runtime still solves it once to decide whether an enemy is worth shooting
// at, and two answers to that question that disagree would be a target chosen
// here and refused there.

#pragma once

namespace brownie::game {

/// One shot at one target, in tiles and milliseconds.
///
/// Tiles per millisecond rather than per second because that is what makes a
/// flight time come out in the same unit the hold and the lifetime are already
/// stated in. The record on the wire carries tiles a second, like every other
/// speed on that link, and `AimTargetFrom` is where the two meet.
struct AimShot {
    /// Where the shot leaves from. **The game's own reading, this frame.**
    float shooter_x = 0.0F;
    float shooter_y = 0.0F;
    /// Where the target is. The client's own reading where there is one, and
    /// the runtime's where the client's tables could not be walked.
    float target_x = 0.0F;
    float target_y = 0.0F;
    /// Tiles per millisecond. Nought is a target not known to be moving.
    ///
    /// **The frame's own measurement where it has one**, and the runtime's
    /// packet-derived rate until it does — see `TargetMotion.h`. The position
    /// above comes out of the client's tables, and a velocity from anywhere
    /// else is a lead measured between two different readings of the same
    /// monster.
    float velocity_x = 0.0F;
    float velocity_y = 0.0F;
    /// Radians per millisecond. Nought keeps the target on a straight line.
    float angular_velocity_per_ms = 0.0F;
    /// Tiles per millisecond, as the game's own projectile data states it.
    float bullet_speed_tiles_per_ms = 0.0F;
    /// How long the shot has to hit something with — **not simply its
    /// lifetime**: one that stops at a stated range gets there before it
    /// expires. It also bounds the aim point, because a solution sits exactly
    /// `speed × flight` from the shooter by construction.
    float max_flight_ms = 0.0F;
    /// How much of the offset the solution names to actually apply, where 1 is
    /// all of it. A share of the *answer*, never of the speed fed into it:
    /// scaling the velocity asks a different question, and at anything above 1
    /// it asks one that a target moving near the shot's speed has no answer to.
    float lead = 1.0F;
    /// How much of the flight not to lead through, in milliseconds.
    ///
    /// **The one empirical number in the chain, and it is a time rather than a
    /// share on purpose.** Everything above is derived — the position out of the
    /// client's tables, the velocity out of readings of them, the flight out of
    /// the game's own projectile data — and what is left over when a shot still
    /// lands in front of a monster is that the thing a bullet is tested against
    /// is some interval behind what can be read about it. That interval is a
    /// property of the client, not of the monster, so the ground it costs is
    /// `velocity × interval`: nothing at all against something standing still,
    /// and more the faster the target moves, which is the shape of the error
    /// being corrected. A share of the lead would instead grow with the
    /// *distance* as well, and shorten the lead on a slow monster far away that
    /// was never being missed.
    ///
    /// Subtracted from the flight the meeting is placed at, never from the
    /// flight that was solved: what the shot can reach is a fact about the
    /// weapon and is not the thing being trimmed.
    float lead_lag_ms = 0.0F;
};

/// Solves for the meeting point, or reports that there is not one.
///
/// False rather than a best effort, for the cases that are genuinely different
/// from a bad answer: the shot has no speed to give, the target has no
/// reachable meeting point, the meeting happens after the shot has stopped
/// mattering, and any of the numbers describing the problem not being a number.
/// A caller that gets false has lost nothing — it still has whatever the
/// runtime sent — and a caller that acted on a plausible-looking number instead
/// would be pointing the player's shots at a `NaN`.
[[nodiscard]] bool SolveAimPoint(const AimShot& shot, float& out_x, float& out_y) noexcept;

}  // namespace brownie::game
