#include "overlay/DodgePicture.h"

#include <charconv>
#include <cstddef>

namespace brownie::overlay {
namespace {

constexpr std::string_view kBeginKind = "dodge-begin";
constexpr std::string_view kTrailKind = "trails";
constexpr std::string_view kMarkKind = "marks";
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

/// The same, for the circles and the paths. The runtime's own caps are well
/// under both; what these bound is one malformed or hostile record.
constexpr std::size_t kMaxMarks = 256;
constexpr std::size_t kMaxTrails = 256;

/// The anchor value that means "wherever the player is". Anything else is the
/// place the record states, which is what an older runtime only ever sent.
constexpr int kAnchorPlayer = 1;

/// Larger than any circle worth drawing, in tiles.
///
/// A radius arrives as a number somebody else computed, and a nonsense one is a
/// ring across the whole map at every zoom level — which is not a debug view, it
/// is a white screen.
constexpr float kMaxRadiusTiles = 64.0F;

/// The next field up to `separator`, and what is left after it.
///
/// **Two levels, because a picture is a list of lists.** Fields are separated by
/// bars as everywhere else on this link; the numbers *inside* one — a path's
/// points, a circle's five figures — are separated by commas. One record per
/// kind rather than one per thing is what keeps a busy screen from being two
/// thousand messages a second; see `Application.showPicture`.
[[nodiscard]] std::string_view Take(std::string_view& rest, char separator) noexcept {
    const std::size_t at = rest.find(separator);
    if (at == std::string_view::npos) {
        const std::string_view last = rest;
        rest = {};
        return last;
    }
    const std::string_view field = rest.substr(0, at);
    rest.remove_prefix(at + 1);
    return field;
}

[[nodiscard]] std::string_view TakeField(std::string_view& rest) noexcept {
    return Take(rest, '|');
}

[[nodiscard]] std::string_view TakeNumber(std::string_view& rest) noexcept {
    return Take(rest, ',');
}

/// Faster than anything in this game moves, in tiles a second.
///
/// A velocity arrives as a number somebody else derived, and a nonsense one
/// carries a circle off the map. Treated as standing still rather than dropping
/// the circle: one drawn where it was stated says more than none at all.
constexpr float kMaxMarkSpeedTiles = 64.0F;

[[nodiscard]] float Believable(float tiles_per_second) noexcept {
    return tiles_per_second > kMaxMarkSpeedTiles || tiles_per_second < -kMaxMarkSpeedTiles
               ? 0.0F
               : tiles_per_second;
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

    // One field per thing, whichever kind this record carries. A field that does
    // not parse is dropped on its own rather than taking the record with it: a
    // picture missing one circle is still a picture.
    if (kind == kMarkKind) {
        for (;;) {
            std::string_view field = TakeField(rest);
            if (field.empty()) {
                break;
            }
            if (staged_marks_.size() >= kMaxMarks) {
                return true;
            }
            int mark_kind = 0;
            int x = 0;
            int y = 0;
            int radius = 0;
            int ahead = 0;
            if (!ParseInt(TakeNumber(field), mark_kind) || !ParseInt(TakeNumber(field), x) ||
                !ParseInt(TakeNumber(field), y) || !ParseInt(TakeNumber(field), radius) ||
                !ParseInt(TakeNumber(field), ahead)) {
                continue;
            }
            // A kind from a newer runtime, or a radius nobody meant. Dropped
            // rather than drawn as something else: a debug view that invents a
            // circle is worse than one missing a circle.
            if (mark_kind < 0 || mark_kind > kMaxMarkKind || radius < 0) {
                continue;
            }
            const float radius_tiles = static_cast<float>(radius) / kHundredths;
            if (radius_tiles > kMaxRadiusTiles) {
                continue;
            }
            // Appended after the five this record has always carried, and read
            // the way every appended field here is: an older runtime stops
            // before them and means a circle that sits still where it said,
            // which is what it only ever sent.
            int anchor = 0;
            int velocity_x = 0;
            int velocity_y = 0;
            (void)ParseInt(TakeNumber(field), anchor);
            (void)ParseInt(TakeNumber(field), velocity_x);
            (void)ParseInt(TakeNumber(field), velocity_y);
            DodgeMark mark;
            mark.kind = static_cast<MarkKind>(mark_kind);
            mark.centre =
                TilePoint{static_cast<float>(x) / kHundredths, static_cast<float>(y) / kHundredths};
            mark.radius_tiles = radius_tiles;
            const float fraction = static_cast<float>(ahead) / kPermille;
            mark.ahead = fraction < 0.0F ? 0.0F : (fraction > 1.0F ? 1.0F : fraction);
            mark.follows_player = anchor == kAnchorPlayer;
            mark.velocity_x = Believable(static_cast<float>(velocity_x) / kHundredths);
            mark.velocity_y = Believable(static_cast<float>(velocity_y) / kHundredths);
            staged_marks_.push_back(mark);
        }
        return true;
    }

    for (;;) {
        std::string_view field = TakeField(rest);
        if (field.empty()) {
            break;
        }
        if (staged_trails_.size() >= kMaxTrails) {
            return true;
        }
        int life_permille = 0;
        if (!ParseInt(TakeNumber(field), life_permille)) {
            continue;
        }

        ShotTrail trail;
        trail.life = static_cast<float>(life_permille) / kPermille;
        bool malformed = false;
        for (;;) {
            const std::string_view x_number = TakeNumber(field);
            if (x_number.empty()) {
                break;
            }
            int x = 0;
            int y = 0;
            // Both or neither: half a point is a point somewhere else.
            if (!ParseInt(x_number, x) || !ParseInt(TakeNumber(field), y) ||
                trail.points.size() >= kMaxPoints) {
                malformed = true;
                break;
            }
            trail.points.push_back(TilePoint{static_cast<float>(x) / kHundredths,
                                             static_cast<float>(y) / kHundredths});
        }

        // A path needs two ends to be a path.
        if (!malformed && trail.points.size() >= 2) {
            staged_trails_.push_back(std::move(trail));
        }
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
