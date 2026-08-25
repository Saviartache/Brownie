// `UnityEngine.Color`, and the one word a colour travels between threads as.
//
// Shared rather than declared where it is used, because two features now hand
// the game a colour somebody picked — the health bar's tint and the player's
// glow — and a second copy of "four floats in the engine's order" is a second
// place for the order to be wrong.
//
// The arithmetic itself is `core/Colour.h`, which the overlay uses too: this
// file is only where four channels become the layout managed code expects.

#pragma once

#include <cstdint>

#include "core/Colour.h"

namespace brownie::game {

/// `UnityEngine.Color`: four floats, in the order the engine stores them.
///
/// Passed to and from managed code by pointer, because sixteen bytes is past
/// what the platform's calling convention puts in a register — which is what
/// makes a detour able to substitute one at all.
struct UiColor {
    float r = 0.0F;
    float g = 0.0F;
    float b = 0.0F;
    float a = 1.0F;
};

/// Whether two colours are the same one.
///
/// Exact comparison, which is right for what it is asked about: every colour
/// this module writes came out of {@link UnpackColour}, so "is what is there
/// still what we put there" is a question about copies of one computation, not
/// about two arithmetic results that ought to be close.
[[nodiscard]] constexpr bool operator==(const UiColor& left, const UiColor& right) noexcept {
    return left.r == right.r && left.g == right.g && left.b == right.b && left.a == right.a;
}

/// One colour as a single 32-bit word, `0xRRGGBBAA`.
///
/// **So that changing the colour cannot be observed half-done.** A colour is
/// read on the game's thread while the operator may be dragging a picker on
/// another; four separate floats would let that read see last frame's red
/// beside this frame's green. One word is one load, and a colour is either the
/// old one or the new one.
[[nodiscard]] constexpr std::uint32_t PackColour(const UiColor& colour) noexcept {
    return core::PackColourChannels({colour.r, colour.g, colour.b, colour.a});
}

[[nodiscard]] constexpr UiColor UnpackColour(std::uint32_t packed) noexcept {
    const auto channels = core::ColourChannels(packed);
    return UiColor{channels[0], channels[1], channels[2], channels[3]};
}

}  // namespace brownie::game
