// Where a point on the screen is, in the world the wire talks about.
//
// **Measured, not modelled.** The obvious way to do this is to reverse the
// camera — read its rotation, its orthographic size and its viewport, and write
// the projection out by hand. That is three offsets that go stale on a patch
// and a formula that is wrong in a way nobody notices until the camera is
// rotated. Instead this asks the camera itself where three known world points
// land, which gives the projection as two vectors, and inverts that. The
// camera's rotation, its zoom, the window's borders, a render resolution that
// differs from the window's — none of it has to be known, because all of it is
// already in the answer.
//
// **Three probes, one frame.** A point, one tile east of it and one tile south
// of it. The differences are what one tile of world is worth in pixels along
// each axis, and a two-by-two solve turns a pixel offset back into tiles. It
// holds for any projection that is linear over the space of a tile, which an
// orthographic top-down camera is.
//
// **Nothing is cached between calls.** The camera object is a managed reference
// and the zoom and rotation change under the player's hands; a basis kept from
// an earlier frame is a basis that describes an earlier camera. Three managed
// calls a frame is what the feature costs while somebody is holding the chord,
// and nothing at all when they are not.
//
// **Game thread only**, below `Bind`. Every call here goes into managed code.

#pragma once

#include <atomic>
#include <optional>

#include "game/OffsetTable.h"

namespace brownie::game {

/// A point in the tiles the game and the wire both count in.
struct WorldPoint {
    float x = 0.0F;
    float y = 0.0F;
};

/// The two pixel counts a projection has to be told apart.
///
/// **The camera answers in the pixels it renders; the mouse and the overlay
/// are measured in the pixels of the window.** They are usually the same
/// number, and a resolution setting or a scaled presentation is enough to put
/// them apart — so the conversion between them is an input here rather than an
/// assumption.
///
/// It is deliberately *not* the camera's own viewport. This game renders the
/// map into a rect narrower than the window, with the HUD beside it, and
/// `WorldToScreenPoint` answers in whole-frame pixels regardless — scaling by
/// the viewport instead of by the frame stretches every answer sideways.
struct ViewSizes {
    /// The window's client area.
    float client_width = 0.0F;
    float client_height = 0.0F;
    /// The frame the game renders, which is the back buffer.
    float render_width = 0.0F;
    float render_height = 0.0F;
};

/// The camera's projection over the space of a few tiles, as measured.
///
/// **Everything either direction needs, and measuring it is the expensive
/// part** — three calls into managed code. So it is taken once for a frame and
/// handed to whatever that frame does with it, rather than each of them asking
/// the camera again.
struct ScreenBasis {
    /// The world point the rest of this is relative to.
    WorldPoint anchor;
    /// Where the anchor sits, in the window's own pixels.
    float origin_x = 0.0F;
    float origin_y = 0.0F;
    /// What one tile east is worth, in those pixels.
    float east_x = 0.0F;
    float east_y = 0.0F;
    /// And one tile south.
    float south_x = 0.0F;
    float south_y = 0.0F;
    /// The area one tile covers, in square pixels. Never zero in a basis that
    /// was handed out — see `kSmallestTileArea`.
    float determinant = 0.0F;
};

/// The tile at a point in the window. The inverse of {@link ToScreen}.
[[nodiscard]] WorldPoint ToWorld(const ScreenBasis& basis, float client_x,
                                 float client_y) noexcept;

/// Where a tile lands in the window. Two multiplications and an add — the
/// camera was already asked, and this is what its answer is for.
void ToScreen(const ScreenBasis& basis, WorldPoint point, float& client_x,
              float& client_y) noexcept;

class ScreenProjection {
  public:
    ScreenProjection() noexcept = default;

    ScreenProjection(const ScreenProjection&) = delete;
    ScreenProjection& operator=(const ScreenProjection&) = delete;
    ScreenProjection(ScreenProjection&&) = delete;
    ScreenProjection& operator=(ScreenProjection&&) = delete;

    /// Takes the entry points out of the table once they are all there.
    /// **IPC thread**, and asked again on every turn until it succeeds: the
    /// engine's classes are registered when the runtime gets round to them.
    ///
    /// All or nothing, for the reason `UnityScene::Bind` gives — a projection
    /// that can find the camera but not ask it anything is not a projection.
    void Bind(const OffsetTable& table) noexcept;

    [[nodiscard]] bool bound() const noexcept { return ready_.load(std::memory_order_acquire); }

    /// Asks the camera where three known points are, and returns what that says
    /// about every other point. **Game thread.**
    ///
    /// `anchor` is any point in tiles — the player's own position is the
    /// obvious one and the best conditioned, but nothing depends on it being
    /// current: every answer is the anchor plus an offset the camera itself
    /// measured, so an anchor from a moment ago carries its own screen position
    /// with it.
    ///
    /// Nothing on failure, which is the ordinary answer between realms and
    /// while the camera is being rebuilt.
    [[nodiscard]] std::optional<ScreenBasis> Measure(WorldPoint anchor, ViewSizes sizes) const;

  private:
    /// Unity's `Vector3`, which is three floats and is passed and returned by
    /// value. Declared here rather than shared, because this is the only file
    /// that speaks to a method taking one.
    struct Vector3 {
        float x;
        float y;
        float z;
    };

    /// `Camera.WorldToScreenPoint(Vector3)`, as the compiler generated it.
    ///
    /// Written out the way the source declares it rather than the way the
    /// platform passes it: a twelve-byte struct goes in by pointer and comes
    /// back through a hidden one, and letting the compiler apply that is the
    /// difference between describing the call and re-deriving an ABI by hand.
    using WorldToScreenPointFn = Vector3 (*)(void* self, Vector3 position, void* method_info);

    /// Where a world point lands, in the window's own pixels. False when the
    /// camera answered with something that is not a number, which it does for a
    /// camera whose projection is not built yet.
    [[nodiscard]] bool ToClient(void* camera, Vector3 world, float scale_x, float scale_y,
                                float render_height, float& out_x, float& out_y) const;

    /// `Camera.main`, or null when nothing is tagged as one right now.
    [[nodiscard]] void* Camera() const;

    void* camera_main_ = nullptr;
    void* world_to_screen_ = nullptr;

    /// Written last with a release, read first with an acquire: a caller that
    /// sees this sees every pointer above it.
    std::atomic<bool> ready_{false};
};

}  // namespace brownie::game
