// A colour, as the three things this module has to hold it as.
//
// One word — `0xRRGGBBAA` — is how it crosses a thread, because a colour read
// while somebody is dragging a picker must be the old one or the new one and
// never half of each. Four floats are what a widget and the engine both want.
// `#rrggbbaa` is what the runtime sends and what goes back to it.
//
// **In `core` because two layers that must not know about each other both need
// it.** The overlay turns a setting's text into a picker; the engine turns a
// feature's text into something to hand the game. Sharing the conversion is
// what stops the two rounding, clamping or refusing differently — a colour that
// survives the overlay and is refused by the engine is a setting that silently
// does nothing.

#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace brownie::core {

/// The four channels of a packed colour, in the order every consumer wants
/// them: red, green, blue, alpha.
[[nodiscard]] constexpr std::array<float, 4> ColourChannels(std::uint32_t packed) noexcept {
    const auto channel = [](std::uint32_t byte) {
        return static_cast<float>(byte & 0xFFu) / 255.0F;
    };
    return {channel(packed >> 24), channel(packed >> 16), channel(packed >> 8), channel(packed)};
}

/// The same four back into one word.
///
/// **Clamped rather than trusted**: the values come from a widget or from a
/// managed object, and a conversion of anything outside [0,1] to an integer is
/// undefined. The cost is a channel quantised to 1/255, which is the precision
/// a picker offers and the precision the game renders at anyway.
[[nodiscard]] constexpr std::uint32_t PackColourChannels(
    const std::array<float, 4>& channels) noexcept {
    const auto channel = [](float value) -> std::uint32_t {
        const float bounded = value < 0.0F ? 0.0F : (value > 1.0F ? 1.0F : value);
        return static_cast<std::uint32_t>(bounded * 255.0F + 0.5F);
    };
    return (channel(channels[0]) << 24) | (channel(channels[1]) << 16) |
           (channel(channels[2]) << 8) | channel(channels[3]);
}

/// `#rrggbbaa` as one word, or nothing when the text is not that.
///
/// **One spelling, and everything else refused.** A short form accepted here
/// would be a colour read as black because a digit was missing, which looks
/// like a value that worked. The runtime normalises what a person typed before
/// it ever reaches this side, so anything else arriving is a bug rather than a
/// convenience to absorb.
[[nodiscard]] constexpr std::optional<std::uint32_t> ParseColour(std::string_view text) noexcept {
    constexpr std::size_t kDigits = 8;
    if (text.size() != kDigits + 1 || text.front() != '#') {
        return std::nullopt;
    }
    std::uint32_t packed = 0;
    for (const char digit : text.substr(1)) {
        const std::uint32_t nibble = digit >= '0' && digit <= '9'   ? std::uint32_t(digit - '0')
                                     : digit >= 'a' && digit <= 'f' ? std::uint32_t(digit - 'a' + 10)
                                     : digit >= 'A' && digit <= 'F' ? std::uint32_t(digit - 'A' + 10)
                                                                    : 16u;
        if (nibble > 15u) {
            return std::nullopt;
        }
        packed = (packed << 4u) | nibble;
    }
    return packed;
}

/// The inverse, in the lower case the runtime keeps colours in — so a value
/// that made the round trip compares equal to the one that was sent.
[[nodiscard]] inline std::string FormatColour(std::uint32_t packed) {
    constexpr char kDigits[] = "0123456789abcdef";
    std::string text = "#00000000";
    for (std::size_t i = 0; i < 8; ++i) {
        const auto nibble = (packed >> ((7 - i) * 4)) & 0xFu;
        text[i + 1] = kDigits[nibble];
    }
    return text;
}

}  // namespace brownie::core
