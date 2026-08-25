// `UnityEngine.Color`, and the one word a colour travels between threads as.
//
// Shared rather than declared where it is used, because two features now hand
// the game a colour somebody picked — the health bar's tint and the player's
// glow — and a second copy of "four floats in the engine's order" is a second
// place for the order to be wrong.

#pragma once

#include <cstdint>

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
///
/// The cost is a channel quantised to 1/255 — which is the precision a colour
/// picker offers and the precision the game renders at anyway.
[[nodiscard]] constexpr std::uint32_t PackColour(const UiColor& colour) noexcept {
    const auto channel = [](float value) -> std::uint32_t {
        // Clamped rather than trusted: the value comes from a widget, and a
        // conversion of anything outside [0,1] to an integer is undefined.
        const float bounded = value < 0.0F ? 0.0F : (value > 1.0F ? 1.0F : value);
        return static_cast<std::uint32_t>(bounded * 255.0F + 0.5F);
    };
    return (channel(colour.r) << 24) | (channel(colour.g) << 16) | (channel(colour.b) << 8) |
           channel(colour.a);
}

[[nodiscard]] constexpr UiColor UnpackColour(std::uint32_t packed) noexcept {
    const auto channel = [](std::uint32_t byte) {
        return static_cast<float>(byte & 0xFFu) / 255.0F;
    };
    return UiColor{channel(packed >> 24), channel(packed >> 16), channel(packed >> 8),
                   channel(packed)};
}

}  // namespace brownie::game
