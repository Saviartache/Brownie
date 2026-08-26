// Reading the runtime's world record.
//
// The record is `|`-separated and its fields are integers only — see
// `apps/runtime/src/overlay/WorldStatusStage.ts`, which is where the decision to
// send numbers rather than text was made. That is what lets this be a split and
// a parse instead of a percent-decoder. The weapon record at the bottom is the
// one exception, and says why.
//
// **A record this does not recognise is ignored.** `docs/ipc.md` makes that a
// rule rather than a courtesy: a newer runtime describing something this build
// has never heard of must not break it, and neither must a truncated record from
// a version that sent fewer fields than it does now.

#pragma once

#include <cstdint>
#include <string_view>

#include "overlay/Ui.h"

namespace brownie::overlay {

/// Parses one record.
///
/// Returns false for any record that is not a world record, or that is one but
/// does not carry every field this build reads. A partially filled status is
/// worse than none: it would draw a position of zero as though the player were
/// standing at the corner of the map.
[[nodiscard]] bool ParseWorldRecord(std::string_view record, WorldStatus& out) noexcept;

/// Parses `weapon|<name>|<type>|<speed>|<lifetimeMs>|<range>`.
///
/// **The one status record with text in it**, so unlike the rest of this file it
/// goes through `SplitRecord` and its percent-decoding. Kept here anyway because
/// it is the same kind of thing — the runtime describing the player's state for
/// the overlay to show — and a third file for one parser is a worse trade than
/// one exception stated out loud.
///
/// A weapon the runtime could not describe still parses: the name is empty and
/// the numbers are nought, which is what `WeaponStatus::described` reports.
[[nodiscard]] bool ParseWeaponRecord(std::string_view record, WeaponStatus& out);

/// Where to walk, how fast the step may be, and how long the target stands.
struct MoveCommand {
    std::int32_t x_hundredths = 0;
    std::int32_t y_hundredths = 0;
    /// Tiles per second, in hundredths. The frame turns this into a distance;
    /// commanding further than it allows is what the server snaps back.
    std::int32_t speed_hundredths = 0;
    /// How long to keep walking towards this if nothing replaces it. The
    /// runtime says nothing when it decides to stand still, so a target has to
    /// stop meaning anything on its own.
    std::int32_t hold_ms = 0;
    /// Whether the two numbers above are an offset from the player rather than
    /// a place on the map.
    ///
    /// **Because only this side knows where the character actually is.** The
    /// runtime learns that from `MOVE` and `NEWTICK`, five times a second,
    /// while the character walks at the frame rate — so a heading the planner
    /// chose, added to the runtime's idea of the position, names somewhere the
    /// player may already have walked past. Resolving it here, on the frame
    /// that acts, is what makes a dodge a step instead of a tug of war.
    ///
    /// The chord that walks to the cursor is the other kind and stays absolute:
    /// a cursor is measured against the game's own camera, so it already names
    /// a point on the map.
    bool from_player = false;
    /// Whether this target is spent by the first frame that acts on it.
    ///
    /// **Because an offset from the player is resolved afresh every frame.** An
    /// ordinary walk wants exactly that: the target stays a fixed distance ahead
    /// and the character keeps walking towards it for as long as the hold lasts.
    /// A dodge that has to be out of the way *now* wants the opposite — one
    /// frame's worth of movement, once — and reissuing the same offset on the
    /// next frame would carry it again, and again, for as many frames as fit
    /// inside the hold. That is a sprint, and it is the one thing the server
    /// takes back.
    ///
    /// So a one-shot target is cleared by the frame that actually steps towards
    /// it. **By the frame that steps, not by the frame that sees it**: a frame
    /// with nothing to measure the player's own walking against issues no step
    /// at all, and consuming the target there would drop the hop on the floor.
    /// The hold is still what bounds how long it may wait for one.
    ///
    /// See `apps/runtime/src/features/dodge/Hop.ts`.
    bool once = false;
};

/// Parses `move|x|y|speed|holdMs[|fromPlayer[|once]]`, in hundredths of a tile
/// and milliseconds.
///
/// The runtime decides *where* — it holds the world model and the planner —
/// and the module only carries the answer to the one thread that may act on
/// it. Integers for the same reason the world record uses them: no decoder,
/// and nothing to get wrong between two languages.
///
/// The last field was appended later and its absence is not a malformed
/// record: an older runtime only ever means a place on the map.
[[nodiscard]] bool ParseMoveRecord(std::string_view record, MoveCommand& out) noexcept;

/// Where the player's shots should go, and how long that stands.
struct AimCommand {
    std::int32_t x_hundredths = 0;
    std::int32_t y_hundredths = 0;
    /// How long to keep pointing there if nothing replaces it. The runtime says
    /// nothing when it has no target, so an aim has to stop meaning anything on
    /// its own — otherwise the player would keep shooting at where something
    /// used to be.
    std::int32_t hold_ms = 0;
    /// Which enemy the point was worked out against, or nought for none.
    ///
    /// **What lets this side correct the point the runtime could not.** Bullet
    /// collision is the client's own, so a shot lands against where the *client*
    /// has the monster — and the runtime only ever had a reconstruction of that,
    /// rebuilt from packets and smoothed between server ticks. Naming the enemy
    /// lets the frame look it up in the game's own tables and shift the aim by
    /// however far the two disagree. See `game/MapObjects.h`.
    std::int32_t object_id = 0;
    /// Where the runtime believed that enemy was when it worked the point out.
    ///
    /// The point alone cannot be corrected: it is already a lead, and how far
    /// ahead of the monster it sits is exactly what must survive the shift. The
    /// difference between this and the client's own reading is the correction,
    /// and it is applied to the point rather than replacing it.
    std::int32_t target_x_hundredths = 0;
    std::int32_t target_y_hundredths = 0;
};

/// Parses `aim|x|y|holdMs` and the optional `|objectId|targetX|targetY` after
/// it, in hundredths of a tile and milliseconds.
///
/// The three are read as one: a correction needs the enemy *and* where the
/// runtime had it, so a record carrying some of them is read as carrying none
/// rather than as a shift measured from nowhere. An older runtime stops after
/// `holdMs`, which is the rule this file already follows for defence.
[[nodiscard]] bool ParseAimRecord(std::string_view record, AimCommand& out) noexcept;

/// A line for the game to show over the player, and the colour to show it in.
///
/// No style: which of the game's floating-text kinds to use is not the
/// runtime's to say and never was. The module copies the one the game itself
/// last used — see `game::FloatingText`.
struct TextCommand {
    /// The three channels, each 0..255. Anything outside that is a record the
    /// runtime did not mean to send, and is refused rather than clamped.
    std::int32_t red = 0;
    std::int32_t green = 0;
    std::int32_t blue = 0;
    /// **Borrowed from the record**, and only valid for as long as it is.
    std::string_view text;
};

/// `text|<red>|<green>|<blue>|<message>`, or false for anything else.
///
/// **The message is the whole of the rest of the record**, separators included,
/// which is why it comes last. The alternative is an escape scheme for one field
/// that carries prose — and the reference implementation's version of this
/// packed a colour into the *message* as a `|#RRGGBB` suffix, then had to strip
/// it again before display and remember not to compare against the stripped
/// copy. Putting the numbers first costs nothing and there is nothing to strip.
///
/// An empty message is refused: a line with nothing on it is not something the
/// runtime meant to show.
[[nodiscard]] bool ParseTextRecord(std::string_view record, TextCommand& out) noexcept;

}  // namespace brownie::overlay
