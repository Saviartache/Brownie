#include "overlay/WorldRecord.h"

#include <array>
#include <charconv>
#include <cstddef>
#include <string>
#include <vector>

#include "overlay/ControlRecord.h"

namespace brownie::overlay {
namespace {

constexpr std::string_view kKind = "world";
constexpr std::string_view kWeaponKind = "weapon";
/// The kind, the name, and the four numbers.
constexpr std::size_t kWeaponFieldCount = 6;
constexpr std::string_view kMoveKind = "move";
constexpr std::string_view kAimKind = "aim";
constexpr std::string_view kAbilityCastKind = "ability-cast";
constexpr std::string_view kAbilityAimKind = "ability-aim";
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

/// `<kind>|x|y|holdMs`, which both ability records are.
[[nodiscard]] bool ParseAbilityRecord(std::string_view record, std::string_view kind,
                                      AbilityCommand& out) noexcept {
    std::string_view rest = record;
    if (TakeField(rest) != kind) {
        return false;
    }

    int x = 0;
    int y = 0;
    int hold = 0;
    if (!ParseInt(TakeField(rest), x) || !ParseInt(TakeField(rest), y) ||
        !ParseInt(TakeField(rest), hold)) {
        return false;
    }
    // No lifetime is not a brief one: a cast with no time to be made in, or an
    // aim that never applies — refused rather than acted on as a zero.
    if (hold <= 0) {
        return false;
    }

    out.x_hundredths = x;
    out.y_hundredths = y;
    out.hold_ms = hold;
    return true;
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

    // Appended after those, and read the same way: all three or none.
    int blasts = 0;
    int blasts_confirmed = 0;
    int blasts_unmatched = 0;
    const bool has_blasts = ParseInt(TakeField(rest), blasts) &&
                            ParseInt(TakeField(rest), blasts_confirmed) &&
                            ParseInt(TakeField(rest), blasts_unmatched);

    // Appended after those, and read the same way: both or neither.
    int shots_confirmed = 0;
    int shots_ended = 0;
    const bool has_client_shots = has_blasts && ParseInt(TakeField(rest), shots_confirmed) &&
                                  ParseInt(TakeField(rest), shots_ended);

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
    out.blast_stats_known = has_blasts;
    out.blasts = has_blasts ? blasts : 0;
    out.blasts_confirmed = has_blasts ? blasts_confirmed : 0;
    out.blasts_unmatched = has_blasts ? blasts_unmatched : 0;
    out.client_shot_stats_known = has_client_shots;
    out.shots_confirmed = has_client_shots ? shots_confirmed : 0;
    out.shots_ended = has_client_shots ? shots_ended : 0;
    return true;
}

bool ParseWeaponRecord(std::string_view record, WeaponStatus& out) {
    const std::vector<std::string> fields = SplitRecord(record);
    if (fields.size() < kWeaponFieldCount || fields[0] != kWeaponKind) {
        return false;
    }

    std::array<int, kWeaponFieldCount - 2> values{};
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (!ParseInt(fields[i + 2], values[i])) {
            return false;
        }
    }

    // Assigned only once every field has parsed, for the same reason the world
    // record is: half a description on screen reads as a whole one.
    out.known = true;
    // An empty name is the runtime saying the catalog has no entry for this
    // type — not a weapon whose name happens to be blank.
    out.described = !fields[1].empty();
    out.name = fields[1];
    out.object_type = values[0];
    out.speed_hundredths = values[1];
    out.lifetime_ms = values[2];
    out.range_hundredths = values[3];
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

    // Appended after the four this record has always carried, and read the way
    // the header describes: an older runtime stops before it and means a place
    // on the map, which is what it only ever sent. The same again for the
    // one-shot flag, which an older runtime never sends and never means.
    int from_player = 0;
    (void)ParseInt(TakeField(rest), from_player);
    int once = 0;
    (void)ParseInt(TakeField(rest), once);

    // All or none. Half a destination is a destination somewhere else.
    out.x_hundredths = x;
    out.y_hundredths = y;
    out.speed_hundredths = speed;
    out.hold_ms = hold;
    out.from_player = from_player != 0;
    out.once = once != 0;
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

    // Appended later, and read as a set: a shift needs the enemy and the place
    // the runtime had it, and two of the three describe no shift at all. An
    // older runtime stops after `holdMs` and is not malformed for it.
    int object_id = 0;
    int target_x = 0;
    int target_y = 0;
    const bool has_target = ParseInt(TakeField(rest), object_id) &&
                            ParseInt(TakeField(rest), target_x) &&
                            ParseInt(TakeField(rest), target_y);

    // And appended after those, read as a second set for the same reason: a
    // lead worked out here needs how the enemy moves, how fast the shot goes,
    // how long it has and how much of the answer to apply. Five of the six
    // describe no lead at all, so a record carrying part of the group is read
    // as carrying none of it and the shift above stands on its own.
    int velocity_x = 0;
    int velocity_y = 0;
    int angular = 0;
    int bullet_speed = 0;
    int max_flight = 0;
    int lead = 0;
    const bool has_motion =
        has_target && ParseInt(TakeField(rest), velocity_x) &&
        ParseInt(TakeField(rest), velocity_y) && ParseInt(TakeField(rest), angular) &&
        ParseInt(TakeField(rest), bullet_speed) && ParseInt(TakeField(rest), max_flight) &&
        ParseInt(TakeField(rest), lead) && bullet_speed > 0 && max_flight > 0;

    // And after those, on its own: an absent trim is a trim of nought, which is
    // a perfectly good aim — unlike an absent velocity, which is no lead at all.
    // So this one is not part of the group above and does not invalidate it.
    int lead_lag = 0;
    const bool has_lag = has_motion && ParseInt(TakeField(rest), lead_lag) && lead_lag >= 0;

    out.x_hundredths = x;
    out.y_hundredths = y;
    out.hold_ms = hold;
    if (has_target) {
        out.object_id = object_id;
        out.target_x_hundredths = target_x;
        out.target_y_hundredths = target_y;
    }
    if (has_motion) {
        out.has_motion = true;
        out.velocity_x_hundredths = velocity_x;
        out.velocity_y_hundredths = velocity_y;
        out.angular_velocity_milli = angular;
        out.bullet_speed_hundredths = bullet_speed;
        out.max_flight_ms = max_flight;
        out.lead_permille = lead;
        out.lead_lag_ms = has_lag ? lead_lag : 0;
    }
    return true;
}

bool ParseAbilityCastRecord(std::string_view record, AbilityCommand& out) noexcept {
    return ParseAbilityRecord(record, kAbilityCastKind, out);
}

bool ParseAbilityAimRecord(std::string_view record, AbilityCommand& out) noexcept {
    return ParseAbilityRecord(record, kAbilityAimKind, out);
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
