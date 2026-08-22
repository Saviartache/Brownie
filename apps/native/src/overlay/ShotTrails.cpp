#include "overlay/ShotTrails.h"

#include <charconv>
#include <cstddef>

namespace brownie::overlay {
namespace {

constexpr std::string_view kBeginKind = "trail-begin";
constexpr std::string_view kTrailKind = "trail";
constexpr std::string_view kEndKind = "trail-end";

/// Hundredths of a tile, as every other position on this link travels.
constexpr float kHundredths = 100.0F;
/// Thousandths, which is how a fraction travels.
constexpr float kPermille = 1000.0F;

/// More points than any path the runtime is meant to send.
///
/// A bound on what one malformed or hostile record can make this allocate. The
/// runtime caps its own paths well under this; anything past it is not a longer
/// path, it is a record that should be refused.
constexpr std::size_t kMaxPoints = 64;

/// The next `|`-separated field, and what is left after it.
[[nodiscard]] std::string_view TakeField(std::string_view& rest) noexcept {
    const std::size_t bar = rest.find('|');
    if (bar == std::string_view::npos) {
        const std::string_view last = rest;
        rest = {};
        return last;
    }
    const std::string_view field = rest.substr(0, bar);
    rest.remove_prefix(bar + 1);
    return field;
}

/// A whole number, or nothing. Anything the runtime did not mean to send fails
/// rather than becoming a plausible zero.
[[nodiscard]] bool ParseInt(std::string_view text, int& out) noexcept {
    if (text.empty()) {
        return false;
    }
    const char* const begin = text.data();
    const char* const end = begin + text.size();
    const auto parsed = std::from_chars(begin, end, out);
    return parsed.ec == std::errc{} && parsed.ptr == end;
}

}  // namespace

bool ShotTrails::Apply(std::string_view record, std::uint64_t now_ms) {
    std::string_view rest = record;
    const std::string_view kind = TakeField(rest);

    if (kind == kBeginKind) {
        staging_.clear();
        building_ = true;
        return true;
    }

    if (kind == kEndKind) {
        if (!building_) {
            // A close with no open: the link came up mid-set, or something is
            // wrong. Committing what happened to be staged would draw half a
            // picture, so this drops it instead.
            return true;
        }
        building_ = false;
        committed_.swap(staging_);
        staging_.clear();
        committed_at_ms_ = now_ms;
        return true;
    }

    if (kind != kTrailKind) {
        return false;
    }
    // Outside a set. Ignored rather than drawn, for the reason above.
    if (!building_) {
        return true;
    }

    int life_permille = 0;
    if (!ParseInt(TakeField(rest), life_permille)) {
        return true;
    }

    ShotTrail trail;
    trail.life = static_cast<float>(life_permille) / kPermille;
    for (;;) {
        const std::string_view x_field = TakeField(rest);
        if (x_field.empty()) {
            break;
        }
        int x = 0;
        int y = 0;
        // Both or neither: half a point is a point somewhere else.
        if (!ParseInt(x_field, x) || !ParseInt(TakeField(rest), y)) {
            return true;
        }
        if (trail.points.size() >= kMaxPoints) {
            return true;
        }
        trail.points.push_back(
            TilePoint{static_cast<float>(x) / kHundredths, static_cast<float>(y) / kHundredths});
    }

    // A path needs two ends to be a path.
    if (trail.points.size() >= 2) {
        staging_.push_back(std::move(trail));
    }
    return true;
}

void ShotTrails::Reset() noexcept {
    committed_.clear();
    staging_.clear();
    building_ = false;
    committed_at_ms_ = 0;
}

}  // namespace brownie::overlay
