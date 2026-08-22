// Where every shot in flight is going, as the runtime last described it.
//
// **The module draws it and does not work it out.** Where a shot will be is the
// game's own motion model applied to parameters that live in its data files —
// which the runtime reads and this side does not — so a second implementation
// here would be a second thing to keep in step with a moving target, and the
// one that drifts is the one drawn over the map claiming to be the truth. What
// arrives is a set of polylines in tiles; what this file does is hold them.
//
// **A set, replaced whole.** Half a set is a picture of two different moments,
// so records between `trail-begin` and `trail-end` go into a staging buffer and
// are committed together — the same shape the plugin list uses, for the same
// reason.
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

/// How long a committed set stands without being restated.
///
/// A few of the runtime's own publishes, so a stalled turn of its loop does not
/// blink the picture, and short enough that a runtime which stops talking stops
/// drawing within half a second.
inline constexpr std::uint64_t kTrailFreshMs = 500;

class ShotTrails {
  public:
    /// Applies one record. **IPC thread.**
    ///
    /// @returns whether this record was one of ours, so the caller can go on
    ///   offering it to whoever else parses records.
    [[nodiscard]] bool Apply(std::string_view record, std::uint64_t now_ms);

    /// Drops everything, staged and committed. Called when the link goes down.
    void Reset() noexcept;

    /// The committed set, or nothing once it has gone stale. **Any thread that
    /// does not also call `Apply`** — which is the render thread, since records
    /// arrive on the IPC one and are published through the same snapshot as
    /// everything else. See `Engine`.
    [[nodiscard]] const std::vector<ShotTrail>& trails() const noexcept { return committed_; }

    /// Whether what is committed is recent enough to draw.
    [[nodiscard]] bool fresh(std::uint64_t now_ms) const noexcept {
        return committed_at_ms_ != 0 && now_ms - committed_at_ms_ <= kTrailFreshMs;
    }

  private:
    std::vector<ShotTrail> committed_;
    std::vector<ShotTrail> staging_;
    bool building_ = false;
    std::uint64_t committed_at_ms_ = 0;
};

}  // namespace brownie::overlay
