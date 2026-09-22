#include "game/AimSolver.h"

#include <cmath>

namespace brownie::game {
namespace {

/// The most samples the arc search takes, and the fewest.
///
/// The arc has no closed form, so it is walked: enough steps that even the
/// fastest turn the tracker will report advances by at most an eighth of a
/// right angle between two of them, which is what stops the search stepping
/// over a meeting and out the far side. The ceiling is what keeps a nonsense
/// turn rate from being a loop the frame notices.
constexpr int kMinArcSteps = 32;
constexpr int kMaxArcSteps = 512;

/// How many halvings the meeting is narrowed by once a step has bracketed it.
///
/// Twenty-four takes a two-hundred-millisecond bracket to a nanosecond, which
/// is far past what a float position can tell apart.
constexpr int kBisectionSteps = 24;

/// Below this a turn rate is a straight line, and dividing by it is not.
///
/// The arc formulae divide by the rate, so a rate small enough to be noise is
/// answered with the straight-line motion it is indistinguishable from rather
/// than with a radius the size of the map.
constexpr double kStraightPerMs = 1e-9;

/// Used only to turn a turn rate into a step count. `std::numbers` is C++20 and
/// this file is the only place in the module that wants it.
constexpr double kPi = 3.14159265358979323846;

/// Where the target has got to after `flight_ms`.
void TargetAt(const AimShot& shot, double flight_ms, double& x, double& y) noexcept {
    const double angular = shot.angular_velocity_per_ms;
    const double velocity_x = shot.velocity_x;
    const double velocity_y = shot.velocity_y;
    if (std::abs(angular) < kStraightPerMs) {
        x = shot.target_x + velocity_x * flight_ms;
        y = shot.target_y + velocity_y * flight_ms;
        return;
    }

    const double turn = angular * flight_ms;
    const double sin = std::sin(turn);
    const double cos = std::cos(turn);
    x = shot.target_x + (velocity_x * sin - velocity_y * (1.0 - cos)) / angular;
    y = shot.target_y + (velocity_y * sin + velocity_x * (1.0 - cos)) / angular;
}

/// How much further the target is than the shot has flown, at `flight_ms`.
///
/// Nought where they meet, and it is what the arc search brackets rather than
/// solves: the shot's reach grows linearly and the target's distance does not,
/// so the first crossing from positive to negative is the first meeting.
[[nodiscard]] double Residual(const AimShot& shot, double flight_ms) noexcept {
    double x = 0.0;
    double y = 0.0;
    TargetAt(shot, flight_ms, x, y);
    return std::hypot(x - shot.shooter_x, y - shot.shooter_y) -
           static_cast<double>(shot.bullet_speed_tiles_per_ms) * flight_ms;
}

/// The smallest non-negative root of `a·t² + 2b·t + c`, or nothing.
///
/// The degenerate case is not an edge case here: a stationary target — which is
/// most of them — makes `a` exactly `-speed²`, and one moving at precisely the
/// shot's speed makes it nought, at which point the quadratic formula divides
/// by nought. Both are handled rather than guarded against, because "the enemy
/// is standing still" must not be the case that fails.
[[nodiscard]] bool StraightFlightTime(double a, double b, double c, double& out) noexcept {
    if (c == 0.0) {
        out = 0.0;
        return true;
    }

    if (std::abs(a) < 1e-12) {
        // Linear: 2b·t + c = 0. Only closing motion has a solution; `b >= 0` is
        // a target retreating at exactly the shot's speed, which never catches
        // up.
        if (b >= 0.0) {
            return false;
        }
        out = c / (-2.0 * b);
        return true;
    }

    const double discriminant = b * b - a * c;
    if (discriminant < 0.0) {
        return false;
    }

    const double root = std::sqrt(discriminant);
    const double first = (-b - root) / a;
    const double second = (-b + root) / a;
    const double low = first < second ? first : second;
    const double high = first < second ? second : first;
    if (low >= 0.0) {
        out = low;
        return true;
    }
    if (high >= 0.0) {
        out = high;
        return true;
    }
    return false;
}

/// The first meeting with a target following a constant-turn arc.
[[nodiscard]] bool TurningFlightTime(const AimShot& shot, double& out) noexcept {
    if (shot.target_x == shot.shooter_x && shot.target_y == shot.shooter_y) {
        out = 0.0;
        return true;
    }

    const double max_flight = shot.max_flight_ms;
    const double per_step =
        std::abs(static_cast<double>(shot.angular_velocity_per_ms)) * max_flight * 16.0 / kPi;
    int steps = kMinArcSteps;
    if (per_step > kMaxArcSteps) {
        steps = kMaxArcSteps;
    } else if (per_step > kMinArcSteps) {
        steps = static_cast<int>(std::ceil(per_step));
    }

    double low = 0.0;
    for (int step = 1; step <= steps; ++step) {
        const double high = (max_flight * step) / steps;
        if (Residual(shot, high) <= 0.0) {
            double left = low;
            double right = high;
            for (int iteration = 0; iteration < kBisectionSteps; ++iteration) {
                const double middle = (left + right) / 2.0;
                if (Residual(shot, middle) <= 0.0) {
                    right = middle;
                } else {
                    left = middle;
                }
            }
            out = right;
            return true;
        }
        low = high;
    }
    return false;
}

}  // namespace

bool SolveAimPoint(const AimShot& shot, float& out_x, float& out_y) noexcept {
    if (!(shot.bullet_speed_tiles_per_ms > 0.0F) || !(shot.max_flight_ms > 0.0F) ||
        !std::isfinite(shot.max_flight_ms)) {
        return false;
    }
    if (!std::isfinite(shot.shooter_x) || !std::isfinite(shot.shooter_y) ||
        !std::isfinite(shot.target_x) || !std::isfinite(shot.target_y) ||
        !std::isfinite(shot.velocity_x) || !std::isfinite(shot.velocity_y) ||
        !std::isfinite(shot.angular_velocity_per_ms) || !std::isfinite(shot.lead) ||
        !std::isfinite(shot.lead_lag_ms)) {
        return false;
    }

    const double dx = static_cast<double>(shot.target_x) - shot.shooter_x;
    const double dy = static_cast<double>(shot.target_y) - shot.shooter_y;
    const double vx = shot.velocity_x;
    const double vy = shot.velocity_y;
    const double speed = shot.bullet_speed_tiles_per_ms;

    double flight_ms = 0.0;
    const bool solved =
        std::abs(static_cast<double>(shot.angular_velocity_per_ms)) < kStraightPerMs
            // |D + V·t| = speed·t, squared and collected: a·t² + 2b·t + c = 0.
            ? StraightFlightTime(vx * vx + vy * vy - speed * speed, dx * vx + dy * vy,
                                 dx * dx + dy * dy, flight_ms)
            : TurningFlightTime(shot, flight_ms);
    if (!solved || !(flight_ms >= 0.0) || flight_ms > shot.max_flight_ms) {
        return false;
    }

    // **Led through the flight, less whatever the target is behind by.** The
    // meeting is where the shot and the target both arrive; the trim says the
    // target is not quite where this side can see it, and the ground that costs
    // is its velocity times the interval — which is why it comes off the time
    // rather than off the answer. Never below nought: a trim longer than the
    // flight is an aim on the target itself, not behind it.
    const double led_through = static_cast<double>(flight_ms) - shot.lead_lag_ms;
    double meeting_x = 0.0;
    double meeting_y = 0.0;
    TargetAt(shot, led_through > 0.0 ? led_through : 0.0, meeting_x, meeting_y);

    // A share of the offset the solution names, measured from where the target
    // is now — so nought aims at the monster and one aims at the meeting.
    const double lead = shot.lead;
    const double x = shot.target_x + (meeting_x - shot.target_x) * lead;
    const double y = shot.target_y + (meeting_y - shot.target_y) * lead;
    if (!std::isfinite(x) || !std::isfinite(y)) {
        return false;
    }

    out_x = static_cast<float>(x);
    out_y = static_cast<float>(y);
    return true;
}

}  // namespace brownie::game
