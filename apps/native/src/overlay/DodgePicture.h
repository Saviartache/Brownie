// What the dodge planner is thinking, as the runtime last described it.
//
// **The module draws it and does not work it out.** Where a shot will be is the
// game's own motion model applied to parameters that live in its data files, and
// how near a monster may stand is a setting the runtime owns — so a second
// implementation here would be a second thing to keep in step with a moving
// target, and the one that drifts is the one drawn over the map claiming to be
// the truth. What arrives is polylines and circles in tiles; what this file does
// is hold them.
//
// **Two halves of one picture.** The paths answer "is the prediction right"; the
// circles answer "is the *decision* right" — the ring a shot has to enter before
// it is answered, the distance a monster is kept at, the reach the planner tries
// not to drift past, where a bomb is going to land. Every complaint the feature
// has ever had was about one of those distances, and every one of them is a
// number in a panel that nobody can check against a moving fight.
//
// **A set, replaced whole.** Half a set is a picture of two different moments,
// so records between `dodge-begin` and `dodge-end` go into staging buffers and
// are committed together — the same shape the plugin list uses, for the same
// reason. Both halves in one bracket, because they describe one plan.
//
// **And packed, one record per kind rather than one per thing.** Fifty paths and
// sixty circles twenty times a second is two thousand messages a second as a
// record apiece, against a reader that takes sixteen kilobytes per turn of its
// loop — the module fell behind, the picture arrived too late to be fresh, and
// it blinked out until the box was unticked and ticked again.
//
// **It expires.** The runtime says nothing when nobody is watching, and a
// runtime that was killed or restarted says nothing either, so silence has to
// mean "stop drawing" on its own. Otherwise a set from a fight two minutes ago
// would hang over the map for the rest of the session.

#pragma once

#include <cstdint>
#include <string_view>
#include <vector>

namespace brownie::overlay {

/// A place on the map, in the tiles the wire counts in.
struct TilePoint {
    float x = 0.0F;
    float y = 0.0F;
};

/// One shot's remaining path, from where it is now to where it stops existing.
struct ShotTrail {
    /// How much of its life is left, from one at the moment it was fired to
    /// nought as it expires. What the colour along the line is made of.
    float life = 0.0F;
    std::vector<TilePoint> points;
};

/// What one circle means. Mirrors `DodgeMarkKind` in the runtime.
///
/// **Numbers on the wire and a name here**, because the record is a fixed set of
/// fields rather than a schema: a kind this build does not recognise is dropped
/// rather than drawn as whichever shape happens to be first, so a newer runtime
/// against an older module loses a circle instead of inventing one.
enum class MarkKind : int {
    Player = 0,
    Engage = 1,
    Body = 2,
    KeepAway = 3,
    InRange = 4,
    Blast = 5,
};

/// The largest kind this build knows, for refusing the ones it does not.
inline constexpr int kMaxMarkKind = 5;

/// One circle on the ground.
struct DodgeMark {
    MarkKind kind = MarkKind::Player;
    TilePoint centre;
    float radius_tiles = 0.0F;
    /// How much of this one's wait is still ahead, from one to nought. Only a
    /// blast has a wait; everything else is a fact about now and carries one.
    float ahead = 1.0F;
};

/// How long a committed set stands without being restated.
///
/// Several of the runtime's own publishes, so neither a stalled turn of its loop
/// nor a busy moment on the link blinks the picture — and short enough that a
/// runtime which stops talking stops drawing about as fast as anybody notices.
inline constexpr std::uint64_t kPictureFreshMs = 1000;

class DodgePicture {
  public:
    /// Applies one record. **IPC thread.**
    ///
    /// @returns whether this record was one of ours, so the caller can go on
    ///   offering it to whoever else parses records.
    [[nodiscard]] bool Apply(std::string_view record, std::uint64_t now_ms);

    /// Drops everything, staged and committed. Called when the link goes down.
    void Reset() noexcept;

    /// The committed set. **Any thread that does not also call `Apply`** — which
    /// is the render thread, since records arrive on the IPC one and are
    /// published through the same snapshot as everything else. See `Engine`.
    [[nodiscard]] const std::vector<ShotTrail>& trails() const noexcept { return trails_; }
    [[nodiscard]] const std::vector<DodgeMark>& marks() const noexcept { return marks_; }

    /// Whether what is committed is recent enough to draw.
    [[nodiscard]] bool fresh(std::uint64_t now_ms) const noexcept {
        return committed_at_ms_ != 0 && now_ms - committed_at_ms_ <= kPictureFreshMs;
    }

  private:
    std::vector<ShotTrail> trails_;
    std::vector<DodgeMark> marks_;
    std::vector<ShotTrail> staged_trails_;
    std::vector<DodgeMark> staged_marks_;
    bool building_ = false;
    std::uint64_t committed_at_ms_ = 0;
};

}  // namespace brownie::overlay
