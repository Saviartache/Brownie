// What the module is doing to the character, drawn where it is happening.
//
// **A panel cannot answer "is it aiming at the right thing".** The numbers were
// there all along — a target in tiles, a cursor in tiles — and reading pairs of
// coordinates off a table while a fight moves is not something anybody can do.
// Drawn over the map, the same numbers are a dot on the ground: either it is on
// the monster or it is not, and either the character is heading for it or it is
// not.
//
// Two sets, because they answer different questions and are switched on
// separately: where the module is *walking* and where it is *pointing*.
//
// **Pixels only.** Everything here arrives already projected, so this file
// knows nothing about cameras, tiles or the game — see `ScreenProjection.h` for
// where the conversion happens and `Engine::DrawFrame` for who does it. That is
// the same direction every other dependency in the overlay runs: the overlay
// draws what it is handed and decides nothing.
//
// Colours come from the active ImGui theme, per the rule in `Overlay.h`.

#pragma once

namespace brownie::overlay {

/// A place in the window, in its own client pixels.
struct ScreenPoint {
    float x = 0.0F;
    float y = 0.0F;
};

/// Where the character is, where it is being sent, and where it is being
/// pointed — any of which may be absent this frame.
struct MovementMarkers {
    bool has_player = false;
    ScreenPoint player;
    /// The target the module is walking towards right now, if it has one.
    bool has_target = false;
    ScreenPoint target;
    /// Where the cursor is, while anything is measuring it.
    bool has_cursor = false;
    ScreenPoint cursor;
};

/// Where the module is pointing the player's shots.
///
/// A ring and the line to it, and no numbers: what the distance and the bearing
/// are is in the panel's own line, and a plate of text following a target
/// around is in the way of the thing it describes.
struct AimMarkers {
    bool has_player = false;
    ScreenPoint player;
    /// The point the shots are being turned towards, if there is one right now.
    bool has_target = false;
    ScreenPoint target;
};

/// Where every shot in flight is going, already projected.
///
/// **Flat arrays rather than a vector of paths**, because this is rebuilt every
/// frame from something that is rebuilt every fiftieth of a second: the caller
/// projects into buffers it keeps, and a frame with a hundred shots on it
/// allocates nothing. `points` holds every path end to end; `lengths` says how
/// many belong to each; `lives` says how much of each shot's life is left, from
/// one when it was fired to nought as it expires.
struct TrailMarkers {
    const ScreenPoint* points = nullptr;
    const int* lengths = nullptr;
    const float* lives = nullptr;
    /// How wide each shot's own collision square is, in pixels. Nought for a
    /// shot the game gives no collision at all, which draws as a bare line.
    const float* widths = nullptr;
    /// Where each shot is *now*, as the four corners of its collision square —
    /// projected rather than sized here, because the camera can be turned and a
    /// square in the world is not one on the screen. Four per trail, in order.
    const ScreenPoint* heads = nullptr;
    int count = 0;
};

/// Draws them over the game. Call between `NewFrame` and `Render`.
///
/// On the foreground list rather than in a window, because these belong to the
/// map and not to the overlay: they are drawn whether or not a panel is open,
/// which is also when they are worth seeing.
void DrawMovement(const MovementMarkers& markers);
void DrawAim(const AimMarkers& markers);

/// Draws each shot's remaining path, coloured by how much life it has left.
///
/// **The one place in the overlay that does not take its colours from the
/// theme**, and the reason is that here the colour *is* the information: green
/// to red is how long a shot has left, and a theme that happened to be blue
/// would leave the picture saying nothing. Everything else on the map follows
/// the theme, as `Overlay.h` requires.
void DrawShotTrails(const TrailMarkers& markers);

/// What one of the planner's circles is, so the drawing can tell them apart.
///
/// Mirrors `MarkKind` in `DodgePicture.h`, which mirrors the runtime's. Kept as
/// a plain int rather than the enum so this file needs nothing from the record
/// layer — the overlay draws what it is handed and knows nothing about wires.
enum class RingRole : int {
    Player = 0,
    Engage = 1,
    Body = 2,
    KeepAway = 3,
    Blast = 4,
    Anchor = 5,
};

/// One shape on the ground, already projected.
struct RingMark {
    RingRole role = RingRole::Player;
    ScreenPoint centre;
    /// In the window's own pixels, which is what the projection gives.
    float radius = 0.0F;
    /// How much of its wait is still ahead, from one to nought. Only a blast
    /// has a wait; everything else carries one and ignores it.
    float ahead = 1.0F;
    /// The outline to draw instead of a circle, in window pixels, closed.
    ///
    /// **A body collides as an axis-aligned square and a circle is a different
    /// shape**, so the ones that are squares arrive as their own corners — and
    /// as corners rather than as a size, because the camera can be turned and a
    /// square in the world is a slanted quad on the screen. Null for the shapes
    /// that genuinely are radii: a ring round the character, a blast.
    const ScreenPoint* outline = nullptr;
    int outline_count = 0;
};

/// The most points an outline may carry, which bounds what one shape costs.
inline constexpr int kMaxOutlinePoints = 64;

/// Draws the distances the planner is reasoning about.
///
/// **The circles are the argument, and each one answers a complaint.** The
/// engagement ring says why a shot was or was not answered; the keep-away
/// circles say what the planner is refusing to stand inside, and around what;
/// the range ring says why it will not follow the player further out; a blast's
/// footprint says what it is walking out of and how soon.
///
/// Sizes are pixels because a tile is a different number of them at every zoom,
/// and the caller is the only thing that knows the camera. See
/// `ScreenProjection.h`.
void DrawDodgeRings(const RingMark* marks, int count);

}  // namespace brownie::overlay
