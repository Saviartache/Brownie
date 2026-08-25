// Where the game keeps the colour of a glow, and how the one we want is found.
//
// The counterpart of `PlayerFields.h` for the two styles a glowing character is
// drawn with. **The glow is not a colour the game is told — it is a style the
// game picks**, and the pick is made from a handful of objects built once, in a
// static constructor, and shared by every character on the map:
//
//   * `GlowStyle` is the aura, two colours and a size.
//   * `OutlineStyle` is the border drawn round the sprite: one colour, an
//     alpha and a strength. It is a *struct*, so its statics are values in the
//     class's own storage rather than objects to reach through — see
//     `Il2CppRuntime::StaticValueLayout` for what that costs.
//
// Every candidate style carries a priority and the highest one wins, so which
// style a character gets is decided by what is true about them: a supporter has
// one, a character the server marked as glowing has another. The one named here
// is the pair the *glowing* flag selects — see `kPlayerGlow` — which is the
// flag this module sets on the local player and nobody else.
//
// **So recolouring is done to the style, not to the character.** There is no
// per-character colour to write: the styles are shared, and the two named here
// are reachable only by a character the flag is set on. In practice that is
// ours; a character the server independently marked as glowing would be drawn
// in the chosen colour too, which is a local repaint of somebody else's glow
// and nothing they can see.
//
// Same rules as every other query in this module: obfuscated names carried with
// the type that identifies them, resolved from the game that is running, and no
// fingerprint until a live run has reported a shape.

#pragma once

#include <cstddef>
#include <string_view>

#include "game/OffsetTable.h"

namespace brownie::game {

/// The colour each style is drawn in, as an offset into one style object.
///
/// The aura's is its *second* colour: the first is the black the game pairs
/// every aura with, shared by the styles this module does not touch, and it is
/// the second that makes a red glow red.
inline constexpr std::string_view kGlowStyleColour = "glow.GlowStyle.colour";
inline constexpr std::string_view kOutlineStyleColour = "glow.OutlineStyle.colour";

/// The classes the two statics live on, as classes rather than as offsets: a
/// static field is found by asking its class, not by an offset into an object.
[[nodiscard]] const ClassQuery& GlowStyleClass() noexcept;
[[nodiscard]] const ClassQuery& OutlineStyleClass() noexcept;

/// The static holding the style the glowing flag selects, on each of them.
[[nodiscard]] std::string_view GlowStyleStaticName() noexcept;
[[nodiscard]] std::string_view OutlineStyleStaticName() noexcept;

/// Resolves whatever is still missing, and is cheap once nothing is.
///
/// Called on every turn of the loop, like the player's and the scene's: these
/// classes are built the first time the game draws a character that has a
/// style to pick, so an unresolved key at the login screen is the ordinary case
/// rather than a rename.
///
/// @returns how many keys resolved on this call.
std::size_t ResolveGlowFields(OffsetTable& table);

}  // namespace brownie::game
