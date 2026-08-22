#include "overlay/WorldRecord.h"

#include <array>
#include <charconv>
#include <cstddef>

namespace brownie::overlay {
namespace {

constexpr std::string_view kKind = "world";
constexpr std::string_view kMoveKind = "move";
constexpr std::string_view kAimKind = "aim";
constexpr std::string_view kTextKind = "text";
/// The largest value a colour channel can carry.
constexpr int kMaxChannel = 255;
/// The kind, then the six numbers every version of this record has carried.
constexpr std::size_t kFieldCount = 7;

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

/// A whole number, or nothing. Anything the runtime did not mean to send —
/// empty, a float, text — fails rather than becoming a plausible zero.
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

bool ParseWorldRecord(std::string_view record, WorldStatus& out) noexcept {
    std::string_view rest = record;
    if (TakeField(rest) != kKind) {
        return false;
    }

    std::array<int, kFieldCount - 1> values{};
    for (auto& value : values) {
        if (!ParseInt(TakeField(rest), value)) {
            return false;
        }
    }

    // Defence was appended later, so it is read separately and its absence is
    // not a malformed record — an older runtime simply stops before it. The
    // rule in the header is that a reader stops early rather than refusing.
    int defense = 0;
    const bool has_defense = ParseInt(TakeField(rest), defense);

    // Appended after defence, and read the same way: all three or none, because
    // two of three counters is a story with a piece missing.
    int announced = 0;
    int no_owner = 0;
    int no_definition = 0;
    const bool has_stats = ParseInt(TakeField(rest), announced) &&
                           ParseInt(TakeField(rest), no_owner) &&
                           ParseInt(TakeField(rest), no_definition);

    // Assigned only once every field has parsed, so a malformed record cannot
    // leave a half-updated status on screen.
    out.known = true;
    out.hp = values[0];
    out.max_hp = values[1];
    out.x_hundredths = values[2];
    out.y_hundredths = values[3];
    out.entities = values[4];
    out.shots = values[5];
    out.defense_known = has_defense;
    out.defense = has_defense ? defense : 0;
    out.shot_stats_known = has_stats;
    out.shots_announced = has_stats ? announced : 0;
    out.shots_no_owner = has_stats ? no_owner : 0;
    out.shots_no_definition = has_stats ? no_definition : 0;
    return true;
}

bool ParseMoveRecord(std::string_view record, MoveCommand& out) noexcept {
    std::string_view rest = record;
    if (TakeField(rest) != kMoveKind) {
        return false;
    }

    int x = 0;
    int y = 0;
    int speed = 0;
    int hold = 0;
    if (!ParseInt(TakeField(rest), x) || !ParseInt(TakeField(rest), y) ||
        !ParseInt(TakeField(rest), speed) || !ParseInt(TakeField(rest), hold)) {
        return false;
    }
    // A step with no speed or no lifetime is not a slower walk, it is a walk
    // that never happens — refused rather than issued as a zero.
    if (speed <= 0 || hold <= 0) {
        return false;
    }

    // All or none. Half a destination is a destination somewhere else.
    out.x_hundredths = x;
    out.y_hundredths = y;
    out.speed_hundredths = speed;
    out.hold_ms = hold;
    return true;
}

bool ParseAimRecord(std::string_view record, AimCommand& out) noexcept {
    std::string_view rest = record;
    if (TakeField(rest) != kAimKind) {
        return false;
    }

    int x = 0;
    int y = 0;
    int hold = 0;
    if (!ParseInt(TakeField(rest), x) || !ParseInt(TakeField(rest), y) ||
        !ParseInt(TakeField(rest), hold)) {
        return false;
    }
    // An aim with no lifetime is not a brief aim, it is one that never applies
    // — refused rather than acted on as a zero.
    if (hold <= 0) {
        return false;
    }

    out.x_hundredths = x;
    out.y_hundredths = y;
    out.hold_ms = hold;
    return true;
}

bool ParseTextRecord(std::string_view record, TextCommand& out) noexcept {
    std::string_view rest = record;
    if (TakeField(rest) != kTextKind) {
        return false;
    }

    std::array<int, 3> channels{};
    for (auto& channel : channels) {
        if (!ParseInt(TakeField(rest), channel) || channel < 0 || channel > kMaxChannel) {
            return false;
        }
    }
    if (rest.empty()) {
        return false;
    }

    out.red = channels[0];
    out.green = channels[1];
    out.blue = channels[2];
    // Whatever is left, separators and all. `TakeField` has already stepped
    // past the one after the last channel.
    out.text = rest;
    return true;
}

}  // namespace brownie::overlay
