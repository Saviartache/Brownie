#include "game/ScreenProjection.h"

#include <cmath>

#include "game/SceneFields.h"

namespace brownie::game {
namespace {

/// Two more of the engine's methods, as the compiler generated them — the third
/// is in the header, where the member type it names is declared.
///
/// **These prototypes and the queries in `SceneFields.cpp` are halves of one
/// claim.** The query says which method; this says how to call it. A managed
/// method called through the wrong prototype does not fail, it corrupts.
using CameraMainFn = void* (*)(void* method_info);

/// How far apart the two probe points are, in tiles.
///
/// One tile: large enough that the difference between the two screen positions
/// is tens of pixels and the rounding in them does not matter, and small enough
/// that a projection only linear *locally* is still linear across it.
constexpr float kProbeTiles = 1.0F;

/// The smallest determinant that counts as a projection.
///
/// The determinant is the area one tile covers in square pixels, so this is a
/// tile smaller than a pixel across — a camera that is being rebuilt, zoomed
/// out past anything playable, or answering with a degenerate matrix. Written
/// as a positive test so that a `NaN` fails it too.
constexpr float kSmallestTileArea = 1.0F;

[[nodiscard]] bool Finite(float value) noexcept {
    return std::isfinite(value);
}

}  // namespace

void ScreenProjection::Bind(const OffsetTable& table) noexcept {
    if (ready_.load(std::memory_order_relaxed)) {
        return;
    }

    // Into locals first, so a half-filled object is never published: the
    // release below is what makes the whole set visible at once.
    void* const camera_main = table.MethodAddress(kCameraMain).value_or(nullptr);
    void* const world_to_screen = table.MethodAddress(kWorldToScreenPoint).value_or(nullptr);
    if (camera_main == nullptr || world_to_screen == nullptr) {
        return;
    }

    camera_main_ = camera_main;
    world_to_screen_ = world_to_screen;
    ready_.store(true, std::memory_order_release);
}

void* ScreenProjection::Camera() const {
    return reinterpret_cast<CameraMainFn>(camera_main_)(nullptr);
}

bool ScreenProjection::ToClient(void* camera, Vector3 world, float scale_x, float scale_y,
                                float render_height, float& out_x, float& out_y) const {
    const Vector3 screen =
        reinterpret_cast<WorldToScreenPointFn>(world_to_screen_)(camera, world, nullptr);
    if (!Finite(screen.x) || !Finite(screen.y)) {
        return false;
    }
    // Unity counts pixels from the bottom left of what it rendered; a window
    // counts them from the top left of what it owns. Both conversions happen
    // here so that everything below this line is in one space.
    out_x = screen.x * scale_x;
    out_y = (render_height - screen.y) * scale_y;
    return true;
}

WorldPoint ToWorld(const ScreenBasis& basis, float client_x, float client_y) noexcept {
    // The point as an offset from the anchor's own place on the screen, solved
    // back into the two world axes.
    const float dx = client_x - basis.origin_x;
    const float dy = client_y - basis.origin_y;
    const float east = (dx * basis.south_y - dy * basis.south_x) / basis.determinant;
    const float south = (basis.east_x * dy - basis.east_y * dx) / basis.determinant;
    return WorldPoint{basis.anchor.x + east, basis.anchor.y + south};
}

void ToScreen(const ScreenBasis& basis, WorldPoint point, float& client_x,
              float& client_y) noexcept {
    const float east = point.x - basis.anchor.x;
    const float south = point.y - basis.anchor.y;
    client_x = basis.origin_x + east * basis.east_x + south * basis.south_x;
    client_y = basis.origin_y + east * basis.east_y + south * basis.south_y;
}

std::optional<ScreenBasis> ScreenProjection::Measure(WorldPoint anchor, ViewSizes sizes) const {
    if (!bound() || !(sizes.client_width > 0.0F) || !(sizes.client_height > 0.0F) ||
        !(sizes.render_width > 0.0F) || !(sizes.render_height > 0.0F)) {
        return std::nullopt;
    }

    void* const camera = Camera();
    if (camera == nullptr) {
        return std::nullopt;
    }

    const float scale_x = sizes.client_width / sizes.render_width;
    const float scale_y = sizes.client_height / sizes.render_height;
    const float render_height = sizes.render_height;

    // **Unity's Y runs the other way from the game's.** A tile to the south is
    // one *less* on the engine's Y axis, which is why the anchor is negated
    // going in and the second probe steps the way it does.
    float origin_x = 0.0F;
    float origin_y = 0.0F;
    float east_x = 0.0F;
    float east_y = 0.0F;
    float south_x = 0.0F;
    float south_y = 0.0F;
    if (!ToClient(camera, Vector3{anchor.x, -anchor.y, 0.0F}, scale_x, scale_y, render_height,
                  origin_x, origin_y) ||
        !ToClient(camera, Vector3{anchor.x + kProbeTiles, -anchor.y, 0.0F}, scale_x, scale_y,
                  render_height, east_x, east_y) ||
        !ToClient(camera, Vector3{anchor.x, -(anchor.y + kProbeTiles), 0.0F}, scale_x, scale_y,
                  render_height, south_x, south_y)) {
        return std::nullopt;
    }

    // One tile of each world axis, in the window's pixels.
    ScreenBasis basis;
    basis.anchor = anchor;
    basis.origin_x = origin_x;
    basis.origin_y = origin_y;
    basis.east_x = (east_x - origin_x) / kProbeTiles;
    basis.east_y = (east_y - origin_y) / kProbeTiles;
    basis.south_x = (south_x - origin_x) / kProbeTiles;
    basis.south_y = (south_y - origin_y) / kProbeTiles;
    basis.determinant = basis.east_x * basis.south_y - basis.east_y * basis.south_x;

    // Checked here, once, so that neither direction has to: a basis that leaves
    // this function is one both of them can divide by. Written as a positive
    // test, which a `NaN` fails too.
    if (!(std::abs(basis.determinant) > kSmallestTileArea)) {
        return std::nullopt;
    }
    return basis;
}

}  // namespace brownie::game
