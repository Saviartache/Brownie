#include "game/TargetMotion.h"

#include <cmath>

namespace brownie::game {
namespace {

/// How quickly the running estimate follows a fresh reading.
///
/// Expressed as a time constant rather than as a share of each frame, because a
/// share of a frame is a different amount of smoothing on every machine: a
/// blend that settles in five frames settles in eighty milliseconds at sixty
/// frames a second and in twenty at two hundred and forty. A sixteenth of a
/// second is short against the flight being led and long against everything
/// that makes a single window jump — the float noise in two positions, and a
/// client that puts a tick's walking into one frame.
constexpr double kFollowMs = 60.0;

}  // namespace

void TargetMotion::Observe(std::int32_t object_id, float x, float y,
                           std::uint64_t now_ms) noexcept {
    if (object_id == 0 || !std::isfinite(x) || !std::isfinite(y)) {
        return;
    }

    Track* track = SlotFor(object_id);
    if (track == nullptr) {
        return;
    }

    if (!track->used || track->object_id != object_id) {
        *track = Track{};
        track->object_id = object_id;
        track->used = true;
    } else if (track->count > 0) {
        // Two readings on the same millisecond are one reading; a velocity from
        // them is a division by nought. Everything within the sample gap is
        // dropped for the plainer reason that the ring is meant to hold a span
        // and not a frame rate.
        if (now_ms < track->last_at_ms || now_ms - track->last_at_ms < kMotionSampleGapMs) {
            return;
        }

        const std::uint64_t elapsed = now_ms - track->last_at_ms;
        const Sample& last = track->samples[(track->next + kSamples - 1) % kSamples];
        const float step = std::hypot(x - last.x, y - last.y);
        // Out of view and back, or picked up and put down. Either way the
        // readings either side cannot be subtracted, so the target starts again
        // from where it actually is.
        //
        // **Measured against the pace this target has been keeping, not against
        // the frame.** A client that steps its monsters on the tick rather than
        // gliding between them delivers a whole tick's walking inside one
        // frame, and a bound of what could be walked in sixteen milliseconds
        // calls every one of those a teleport — which would leave such a client
        // with a ring two readings long and never a velocity at all.
        //
        // But a bound loose enough for that — a whole tick at the fastest
        // anything walks — lets a four-tile jump through, and a jump inside the
        // window is divided by the window: one teleport reads as twenty tiles a
        // second for the fifth of a second after it, which is a lead of several
        // tiles into empty floor. Exactly the miss this file exists to stop,
        // and worst on the chargers and blinkers that are already hard to hit.
        //
        // So the allowance is what this target has been doing: a tick of its
        // own pace, plus what a frame of the outright cap could carry. A step
        // that beats both did not come from walking.
        const float carried = track->has_velocity
                                  ? std::hypot(track->velocity_x, track->velocity_y) *
                                        static_cast<float>(kMotionWindowMs)
                                  : kMotionMaxTilesPerMs * static_cast<float>(kMotionWindowMs);
        const float walkable = kMotionMaxTilesPerMs * static_cast<float>(elapsed) + carried;
        if (elapsed > kMotionForgetMs || step > walkable) {
            const std::int32_t kept = track->object_id;
            *track = Track{};
            track->object_id = kept;
            track->used = true;
        }
    }

    const std::uint64_t previous_at = track->count > 0 ? track->last_at_ms : now_ms;
    track->samples[track->next] = Sample{x, y, now_ms};
    track->next = (track->next + 1) % kSamples;
    if (track->count < kSamples) {
        track->count += 1;
    }
    track->last_at_ms = now_ms;

    Follow(*track, now_ms - previous_at);
}

void TargetMotion::Follow(Track& track, std::uint64_t since_ms) noexcept {
    float sample_x = 0.0F;
    float sample_y = 0.0F;
    std::uint64_t span = 0;
    if (!Window(track, sample_x, sample_y, span)) {
        return;
    }

    track.span_ms = span;
    if (!track.has_velocity) {
        track.velocity_x = sample_x;
        track.velocity_y = sample_y;
        track.has_velocity = true;
        return;
    }

    // **A running estimate, not the latest window.** A window is a difference of
    // two positions and carries whatever those two positions carry — the float's
    // own last digit, and, on a client that steps rather than glides, whether
    // the far end of the window happened to land before or after a step. Either
    // makes a single window jump about while the monster walks evenly, and a
    // lead is that number multiplied by a flight time. Following it settles on
    // what the client is doing on average, which is the thing being led.
    const double follow = static_cast<double>(since_ms) / (static_cast<double>(since_ms) + kFollowMs);
    track.velocity_x += static_cast<float>((sample_x - track.velocity_x) * follow);
    track.velocity_y += static_cast<float>((sample_y - track.velocity_y) * follow);
}

bool TargetMotion::Window(const Track& track, float& out_x, float& out_y,
                          std::uint64_t& out_span_ms) noexcept {
    if (track.count < 2) {
        return false;
    }

    const Sample& newest = track.samples[(track.next + kSamples - 1) % kSamples];

    // Walking back from the newest: the first reading a whole window old is the
    // one wanted, and failing that the oldest there is — which is what a target
    // only just come into view has.
    const Sample* against = nullptr;
    for (int back = 2; back <= track.count; ++back) {
        const Sample& older = track.samples[(track.next + kSamples - back) % kSamples];
        against = &older;
        if (newest.at_ms - older.at_ms >= kMotionWindowMs) {
            break;
        }
    }
    if (against == nullptr) {
        return false;
    }

    const std::uint64_t span = newest.at_ms - against->at_ms;
    if (span < kMotionMinWindowMs) {
        return false;
    }

    const float elapsed = static_cast<float>(span);
    float velocity_x = (newest.x - against->x) / elapsed;
    float velocity_y = (newest.y - against->y) / elapsed;

    // Held to what could have been walked. Every step that went into the ring
    // is already inside the bound, so this is the arithmetic saying so rather
    // than a case that is expected to fire.
    const float speed = std::hypot(velocity_x, velocity_y);
    if (!std::isfinite(speed)) {
        return false;
    }
    if (speed > kMotionMaxTilesPerMs) {
        const float scale = kMotionMaxTilesPerMs / speed;
        velocity_x *= scale;
        velocity_y *= scale;
    }

    out_x = velocity_x;
    out_y = velocity_y;
    out_span_ms = span;
    return true;
}

bool TargetMotion::VelocityOf(std::int32_t object_id, std::uint64_t now_ms, float& out_x,
                              float& out_y, std::uint64_t& out_span_ms) const noexcept {
    const Track* track = FindSlot(object_id);
    if (track == nullptr || !track->has_velocity) {
        return false;
    }

    // The newest reading has to be this frame's, near enough. A target the
    // frame stopped looking at keeps its ring until the gap forgets it, and a
    // velocity served out of that ring would be the speed it had when it was
    // last watched rather than the speed it has.
    if (now_ms < track->last_at_ms || now_ms - track->last_at_ms > kMotionSampleGapMs * 2) {
        return false;
    }

    out_x = track->velocity_x;
    out_y = track->velocity_y;
    out_span_ms = track->span_ms;
    return true;
}

void TargetMotion::Clear() noexcept {
    for (Track& track : tracks_) {
        track = Track{};
    }
}

TargetMotion::Track* TargetMotion::SlotFor(std::int32_t object_id) noexcept {
    Track* free_slot = nullptr;
    Track* oldest = nullptr;
    for (Track& track : tracks_) {
        if (track.used && track.object_id == object_id) {
            return &track;
        }
        if (!track.used) {
            if (free_slot == nullptr) {
                free_slot = &track;
            }
            continue;
        }
        if (oldest == nullptr || track.last_at_ms < oldest->last_at_ms) {
            oldest = &track;
        }
    }
    if (free_slot != nullptr) {
        return free_slot;
    }
    // Every slot taken, so the one whose readings are furthest out of date goes
    // — it is the one whose velocity would have been refused anyway.
    return oldest;
}

const TargetMotion::Track* TargetMotion::FindSlot(std::int32_t object_id) const noexcept {
    for (const Track& track : tracks_) {
        if (track.used && track.object_id == object_id) {
            return &track;
        }
    }
    return nullptr;
}

}  // namespace brownie::game
