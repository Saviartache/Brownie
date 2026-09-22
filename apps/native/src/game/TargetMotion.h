// How fast the *client* is moving a monster, measured where the shot lives.
//
// **The other half of `MapObjects.h`.** A lead is a position plus a velocity
// carried forward, and until now only the position came from the client: the
// frame looked the monster up in the game's own tables and then applied a
// velocity the runtime had derived from the packet stream. The two are not
// readings of the same thing. The server states where a monster *is* at the end
// of each tick; the client moves its own copy towards that over the tick after
// it, so what is drawn — and what a bullet is tested against — is a smoothed,
// trailing version of the packets. The two agree only while a monster holds a
// steady speed, and they disagree by most of a tick's worth of ground the
// moment one speeds up, slows down or turns.
//
// That disagreement lands entirely in the lead, and always the same way round:
// the packets say a monster is already doing twenty tiles a second while the
// client is still winding its copy up to it, so the shot is sent to where the
// faster of the two would have been. Which is the complaint — a monster that
// moves is shot at from in front, and the quicker it moves the further in front
// it is missed.
//
// So the velocity is measured here, from the same positions the bullet is
// tested against, on the frames it is tested on — the result of whatever the
// client is doing between two server ticks rather than a model of it.
//
// **Over a window, not between two frames.** A frame-to-frame difference of two
// floats a few milliseconds apart is mostly the float's own last digit. A fixed
// lookback of about one server tick is long enough to be walking rather than
// rounding and short enough to still be the pace the monster has now.
//
// **What arrives in jumps is not measured at all.** A jump inside the window is
// divided by the window, so a single blink would read as twenty tiles a second
// for the fifth of a second after it — a lead of several tiles into empty
// floor, on exactly the chargers and blinkers that are hardest to hit anyway.
// A step beyond what this target has been keeping up is read as a reposition,
// which leaves the caller on the rate the runtime sent: the lead the feature
// had before any of this existed, rather than a worse one.
//
// Nothing here reads the game, allocates, locks or throws — the readings are
// handed to it, which is what lets the self-test drive it with numbers.

#pragma once

#include <cstdint>

namespace brownie::game {

/// How far back a velocity is measured, in milliseconds.
///
/// One server tick. Shorter follows whatever the client is doing inside a tick,
/// which for a client that steps rather than interpolates is nothing at all
/// followed by everything at once; longer averages away the turn that is being
/// led. The game's tick has been 200 ms for its whole life.
inline constexpr std::uint64_t kMotionWindowMs = 200;

/// The shortest span a velocity is believed over.
///
/// A target just come into view has only the readings taken since, and a
/// sixteenth of a second of them is already enough to beat the packet stream.
/// Below it the float noise in two positions is a larger part of the answer
/// than the walking is.
inline constexpr std::uint64_t kMotionMinWindowMs = 60;

/// How close together two readings may be before the second is dropped.
///
/// Not a rate limit for its own sake: it is what bounds the ring below to a
/// span rather than to a frame rate, so a machine running at four hundred
/// frames a second remembers the same fifth of a second as one running at sixty.
inline constexpr std::uint64_t kMotionSampleGapMs = 10;

/// How long a target's readings stay useful once they stop arriving.
///
/// Past it the monster has been free to turn, stop or die unwatched, and a
/// velocity measured across the gap describes none of those.
inline constexpr std::uint64_t kMotionForgetMs = 500;

/// The fastest anything is taken to travel under its own power, tiles per ms.
///
/// Twenty tiles a second, the same bound the runtime's tracker holds itself to.
/// What exceeds it did not walk — a teleport, a `GOTO`, the server putting a
/// monster back where it belongs — and the readings either side of one cannot
/// be subtracted into a velocity.
inline constexpr float kMotionMaxTilesPerMs = 0.02F;

/// Measured motion for the targets the frame has been reading.
///
/// **Game thread only**, like everything that reads the client's own tables.
/// Held by value inside `PlayerControl`: it is a fixed handful of kilobytes and
/// never grows, so there is nothing to own and nothing to free.
class TargetMotion {
  public:
    /// Records where the client has an object, on the frame that read it.
    ///
    /// Readings closer together than {@link kMotionSampleGapMs} are dropped,
    /// a gap longer than {@link kMotionForgetMs} starts the target again, and a
    /// step nothing could have walked is taken as a reposition rather than as
    /// an enormous velocity.
    void Observe(std::int32_t object_id, float x, float y, std::uint64_t now_ms) noexcept;

    /// How fast the client is moving that object, in tiles per millisecond.
    ///
    /// False for a target with too little history to divide — which is every
    /// target for the first few frames it is looked at, and is why the caller
    /// keeps whatever the runtime sent as its fallback rather than treating
    /// this as the only answer.
    ///
    /// @param out_span_ms The ground the answer was measured over, so a caller
    ///   that also knows a turn rate can correct the chord to a tangent. See
    ///   `AimSolver.h` — the same correction the runtime's tracker makes.
    [[nodiscard]] bool VelocityOf(std::int32_t object_id, std::uint64_t now_ms, float& out_x,
                                  float& out_y, std::uint64_t& out_span_ms) const noexcept;

    /// Forgets every target. For a realm change, where the ids are re-used.
    void Clear() noexcept;

  private:
    /// How many readings of one target are kept.
    ///
    /// {@link kMotionWindowMs} at one reading per {@link kMotionSampleGapMs},
    /// and half as many again so the window is still spanned on a frame that
    /// arrived late.
    static constexpr int kSamples = 32;

    /// How many targets are remembered at once.
    ///
    /// One would do for a feature that held its target, and auto-aim does not:
    /// two monsters a hair apart in range trade places every other plan, and a
    /// single slot would throw away the history of each as the other took it —
    /// leaving the measurement permanently unmade and the fallback permanently
    /// in use. Four covers that without pretending to be a world model: what is
    /// not aimed at is not read, so a fifth slot would only ever hold something
    /// already stale.
    static constexpr int kTargets = 4;

    struct Sample {
        float x = 0.0F;
        float y = 0.0F;
        std::uint64_t at_ms = 0;
    };

    struct Track {
        std::int32_t object_id = 0;
        bool used = false;
        /// Where the next reading goes, and how many of the ring are filled.
        int next = 0;
        int count = 0;
        std::uint64_t last_at_ms = 0;
        /// The running estimate, and the window the last reading of it spanned.
        bool has_velocity = false;
        float velocity_x = 0.0F;
        float velocity_y = 0.0F;
        std::uint64_t span_ms = 0;
        Sample samples[kSamples]{};
    };

    /// The slot holding this id, or the one worth taking for it.
    [[nodiscard]] Track* SlotFor(std::int32_t object_id) noexcept;
    [[nodiscard]] const Track* FindSlot(std::int32_t object_id) const noexcept;

    /// The difference across the ring's window, before it is followed.
    [[nodiscard]] static bool Window(const Track& track, float& out_x, float& out_y,
                                     std::uint64_t& out_span_ms) noexcept;

    /// Moves the running estimate towards the latest window.
    static void Follow(Track& track, std::uint64_t since_ms) noexcept;

    Track tracks_[kTargets]{};
};

}  // namespace brownie::game
