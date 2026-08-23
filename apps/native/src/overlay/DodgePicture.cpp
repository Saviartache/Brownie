#include "overlay/DodgePicture.h"

#include <charconv>
#include <cstddef>

namespace brownie::overlay {
namespace {

constexpr std::string_view kBeginKind = "dodge-begin";
constexpr std::string_view kTrailKind = "trail";
constexpr std::string_view kMarkKind = "mark";
constexpr std::string_view kEndKind = "dodge-end";

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

/// The same, for the circles. The runtime's own cap is well under it.
constexpr std::size_t kMaxMarks = 256;

/// Larger than any circle worth drawing, in tiles.
///
/// A radius arrives as a number somebody else computed, and a nonsense one is a
/// ring across the whole map at every zoom level — which is not a debug view, it
/// is a white screen.
constexpr float kMaxRadiusTiles = 64.0F;

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

bool DodgePicture::Apply(std::string_view record, std::uint64_t now_ms) {
    std::string_view rest = record;
    const std::string_view kind = TakeField(rest);

    if (kind == kBeginKind) {
        staged_trails_.clear();
        staged_marks_.clear();
        building_ = true;
        return true;
    }

    if (kind == kEndKind) {
        if (!building_) {
            // A close with no open: the link came up mid-set, or something is
            // wrong. Committing what happened to be staged would draw half a
            // picture, so this drops it instead.
            staged_trails_.clear();
            staged_marks_.clear();
            return true;
        }
        building_ = false;
        trails_.swap(staged_trails_);
        marks_.swap(staged_marks_);
        staged_trails_.clear();
        staged_marks_.clear();
        committed_at_ms_ = now_ms;
        return true;
    }

    if (kind != kTrailKind && kind != kMarkKind) {
        return false;
    }
    // Outside a set. Ignored rather than drawn, for the reason above.
    if (!building_) {
        return true;
    }

    if (kind == kMarkKind) {
        int mark_kind = 0;
        int x = 0;
        int y = 0;
        int radius = 0;
        int ahead = 0;
        if (!ParseInt(TakeField(rest), mark_kind) || !ParseInt(TakeField(rest), x) ||
            !ParseInt(TakeField(rest), y) || !ParseInt(TakeField(rest), radius) ||
            !ParseInt(TakeField(rest), ahead)) {
            return true;
        }
        // A kind from a newer runtime, or a radius nobody meant. Dropped rather
        // than drawn as something else: a debug view that invents a circle is
        // worse than one missing a circle.
        if (mark_kind < 0 || mark_kind > kMaxMarkKind || radius < 0) {
            return true;
        }
        const float radius_tiles = static_cast<float>(radius) / kHundredths;
        if (radius_tiles > kMaxRadiusTiles || staged_marks_.size() >= kMaxMarks) {
            return true;
        }
        DodgeMark mark;
        mark.kind = static_cast<MarkKind>(mark_kind);
        mark.centre = TilePoint{static_cast<float>(x) / kHundredths,
                                static_cast<float>(y) / kHundredths};
        mark.radius_tiles = radius_tiles;
        const float fraction = static_cast<float>(ahead) / kPermille;
        mark.ahead = fraction < 0.0F ? 0.0F : (fraction > 1.0F ? 1.0F : fraction);
        staged_marks_.push_back(mark);
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
        staged_trails_.push_back(std::move(trail));
    }
    return true;
}

void DodgePicture::Reset() noexcept {
    trails_.clear();
    marks_.clear();
    staged_trails_.clear();
    staged_marks_.clear();
    building_ = false;
    committed_at_ms_ = 0;
}

}  // namespace brownie::overlay
