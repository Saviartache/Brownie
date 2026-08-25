#include "overlay/ControlRecord.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iterator>
#include <utility>

namespace brownie::overlay {
namespace {

constexpr std::string_view kSyncBegin = "sync-begin";
constexpr std::string_view kSyncEnd = "sync-end";
constexpr std::string_view kPlugin = "plugin";
constexpr std::string_view kSetting = "setting";

/// Field positions, counted from the kind. Named because a bare `fields[9]` in
/// the middle of a parser is unreadable and the wire format is positional
/// precisely so that new fields can be appended after these.
enum PluginField : std::size_t {
    kPluginId = 1,
    kPluginName = 2,
    kPluginCategory = 3,
    kPluginEnabled = 4,
    kPluginState = 5,
    kPluginError = 6,
    kPluginEnableable = 7,
    /// Everything up to the error. `enableable` was appended later, and a
    /// record without it describes a plugin this build can still draw.
    kPluginMinimumFields = 7,
};

enum SettingField : std::size_t {
    kSettingPlugin = 1,
    kSettingKey = 2,
    kSettingLabel = 3,
    kSettingType = 4,
    kSettingValueType = 5,
    kSettingValue = 6,
    kSettingHasMin = 7,
    kSettingMin = 8,
    kSettingHasMax = 9,
    kSettingMax = 10,
    kSettingStep = 11,
    kSettingAdvanced = 12,
    kSettingOptions = 13,
    kSettingGroup = 14,
    kSettingVisibleWhen = 15,
    /// Everything up to and including the value. A record shorter than this
    /// describes no control at all; anything after it has a usable default.
    kSettingMinimumFields = 7,
};

/// The order the overlay files categories in, roughly what a run is spent on:
/// fighting, moving, carrying, looking, and the rest.
constexpr std::string_view kCategoryOrder[] = {"combat",  "movement", "items",
                                               "visuals", "utility",  "commands",
                                               "developer"};

/// Where a category sorts. An unrecognised one belongs to a runtime newer than
/// this build, so it is filed after the known ones rather than dropped.
[[nodiscard]] std::size_t CategoryRank(std::string_view category) noexcept {
    for (std::size_t rank = 0; rank < std::size(kCategoryOrder); ++rank) {
        if (kCategoryOrder[rank] == category) return rank;
    }
    return std::size(kCategoryOrder);
}

[[nodiscard]] bool IsUnreserved(char byte) noexcept {
    // Exactly `encodeURIComponent`'s set, so what this produces round-trips
    // through the runtime's `decodeURIComponent` unchanged.
    return (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
           (byte >= '0' && byte <= '9') || byte == '-' || byte == '_' || byte == '.' ||
           byte == '!' || byte == '~' || byte == '*' || byte == '\'' || byte == '(' || byte == ')';
}

[[nodiscard]] bool HexDigit(char byte, unsigned& out) noexcept {
    if (byte >= '0' && byte <= '9') {
        out = static_cast<unsigned>(byte - '0');
        return true;
    }
    if (byte >= 'a' && byte <= 'f') {
        out = static_cast<unsigned>(byte - 'a') + 10U;
        return true;
    }
    if (byte >= 'A' && byte <= 'F') {
        out = static_cast<unsigned>(byte - 'A') + 10U;
        return true;
    }
    return false;
}

/// Anything the built-in font cannot draw, or that would break layout, becomes
/// a question mark. See the rule in `ControlRecord.h`.
[[nodiscard]] char Printable(char byte) noexcept {
    const auto value = static_cast<unsigned char>(byte);
    return (value >= 0x20U && value < 0x7FU) ? byte : '?';
}

[[nodiscard]] std::string DecodeField(std::string_view field) {
    std::string decoded;
    decoded.reserve(field.size());

    for (std::size_t i = 0; i < field.size(); ++i) {
        if (field[i] != '%') {
            decoded.push_back(Printable(field[i]));
            continue;
        }
        unsigned high = 0;
        unsigned low = 0;
        if (i + 2 >= field.size() || !HexDigit(field[i + 1], high) ||
            !HexDigit(field[i + 2], low)) {
            // Malformed encoding. The runtime's decoder returns the field
            // verbatim rather than throwing, for the same reason: a mis-escaped
            // label is a display problem, and losing the whole interaction over
            // one is worse than showing it raw.
            std::string raw;
            raw.reserve(field.size());
            for (const char byte : field) {
                raw.push_back(Printable(byte));
            }
            return raw;
        }
        decoded.push_back(Printable(static_cast<char>((high << 4U) | low)));
        i += 2;
    }
    return decoded;
}

[[nodiscard]] bool Flag(const std::vector<std::string>& fields, std::size_t at) noexcept {
    return at < fields.size() && fields[at] == "1";
}

[[nodiscard]] const std::string& Field(const std::vector<std::string>& fields, std::size_t at) {
    static const std::string kEmpty;
    return at < fields.size() ? fields[at] : kEmpty;
}

/// A finite number, or nothing. A field that is absent, empty or not a number
/// leaves the caller's value alone rather than becoming a plausible zero.
[[nodiscard]] bool Number(const std::string& text, float& out) noexcept {
    if (text.empty()) {
        return false;
    }
    const char* const begin = text.c_str();
    char* end = nullptr;
    const float value = std::strtof(begin, &end);
    if (end != begin + text.size() || !std::isfinite(value)) {
        return false;
    }
    out = value;
    return true;
}

[[nodiscard]] SettingKind KindOf(const std::string& name) noexcept {
    if (name == "boolean") return SettingKind::kBoolean;
    if (name == "number") return SettingKind::kNumber;
    if (name == "range") return SettingKind::kRange;
    if (name == "select") return SettingKind::kSelect;
    if (name == "multiSelect") return SettingKind::kMultiSelect;
    if (name == "colour") return SettingKind::kColour;
    if (name == "button") return SettingKind::kButton;
    // Text is the fallback for a kind this build predates: every setting has a
    // value that can be shown and edited as text, so an unknown one is still
    // usable rather than invisible.
    return SettingKind::kText;
}

/// Splits `a;b;c`, the list form the codec uses inside a single field.
[[nodiscard]] std::vector<std::string> SplitList(const std::string& raw) {
    std::vector<std::string> items;
    if (raw.empty()) {
        return items;
    }
    std::size_t start = 0;
    for (;;) {
        const std::size_t separator = raw.find(';', start);
        if (separator == std::string::npos) {
            items.push_back(raw.substr(start));
            return items;
        }
        items.push_back(raw.substr(start, separator - start));
        start = separator + 1;
    }
}

[[nodiscard]] std::vector<SettingOption> ParseOptions(const std::string& raw) {
    std::vector<SettingOption> options;
    for (const std::string& item : SplitList(raw)) {
        // `Label=value`. A cell without one is both at once, which is what the
        // runtime would have sent had the two been equal anyway.
        const std::size_t equals = item.find('=');
        if (equals == std::string::npos) {
            options.push_back({item, item});
            continue;
        }
        options.push_back({item.substr(0, equals), item.substr(equals + 1)});
    }
    return options;
}

}  // namespace

std::vector<std::string> SplitRecord(std::string_view record) {
    std::vector<std::string> fields;
    std::size_t start = 0;
    for (;;) {
        const std::size_t bar = record.find('|', start);
        if (bar == std::string_view::npos) {
            fields.push_back(DecodeField(record.substr(start)));
            return fields;
        }
        fields.push_back(DecodeField(record.substr(start, bar - start)));
        start = bar + 1;
    }
}

std::string EncodeField(std::string_view value) {
    static constexpr char kHex[] = "0123456789ABCDEF";

    std::string encoded;
    encoded.reserve(value.size());
    for (const char byte : value) {
        if (IsUnreserved(byte)) {
            encoded.push_back(byte);
            continue;
        }
        const auto raw = static_cast<unsigned char>(byte);
        encoded.push_back('%');
        encoded.push_back(kHex[raw >> 4U]);
        encoded.push_back(kHex[raw & 0x0FU]);
    }
    return encoded;
}

std::string BuildAction(std::string_view kind, std::initializer_list<std::string_view> fields) {
    std::string action{kind};
    for (const std::string_view field : fields) {
        action.push_back('|');
        action.append(EncodeField(field));
    }
    return action;
}

bool ControlMirror::Apply(std::string_view record) {
    const std::vector<std::string> fields = SplitRecord(record);
    const std::string& kind = fields.front();

    if (kind == kSyncBegin) {
        staging_.clear();
        syncing_ = true;
        return false;
    }

    if (kind == kSyncEnd) {
        if (!syncing_) {
            return false;
        }
        syncing_ = false;
        // Grouped once here rather than every frame, and stably, so plugins
        // sharing a category keep the order the runtime listed them in.
        std::stable_sort(staging_.begin(), staging_.end(),
                         [](const PluginRow& left, const PluginRow& right) {
                             return CategoryRank(left.category) < CategoryRank(right.category);
                         });
        plugins_ = std::move(staging_);
        staging_.clear();
        ++version_;
        return true;
    }

    // Outside a sync there is nothing to add to. A stray record is ignored
    // rather than applied to the committed list, which is what keeps a commit
    // atomic instead of merely usually atomic.
    if (!syncing_) {
        return false;
    }

    if (kind == kPlugin) {
        if (fields.size() < kPluginMinimumFields) {
            return false;
        }
        PluginRow row;
        row.id = fields[kPluginId];
        row.name = fields[kPluginName];
        row.category = fields[kPluginCategory];
        row.enabled = Flag(fields, kPluginEnabled);
        row.state = fields[kPluginState];
        row.error = fields[kPluginError];
        // A runtime that predates the field is one that could not disable a
        // toggle anyway, so its plugins are all offered.
        row.enableable = fields.size() <= kPluginEnableable || Flag(fields, kPluginEnableable);
        staging_.push_back(std::move(row));
        return false;
    }

    if (kind == kSetting) {
        if (fields.size() < kSettingMinimumFields) {
            return false;
        }
        // Settings follow their plugin, so the last one is almost always it —
        // but searching is what makes that an optimisation rather than an
        // assumption about an ordering nothing enforces.
        const std::string& owner = fields[kSettingPlugin];
        PluginRow* plugin = nullptr;
        for (PluginRow& candidate : staging_) {
            if (candidate.id == owner) {
                plugin = &candidate;
            }
        }
        if (plugin == nullptr) {
            return false;
        }

        SettingRow row;
        row.key = fields[kSettingKey];
        row.label = fields[kSettingLabel];
        row.kind = KindOf(fields[kSettingType]);
        row.value_type = fields[kSettingValueType];
        row.value = fields[kSettingValue];
        (void)Number(row.value, row.number);
        row.has_min = Flag(fields, kSettingHasMin);
        (void)Number(Field(fields, kSettingMin), row.min);
        row.has_max = Flag(fields, kSettingHasMax);
        (void)Number(Field(fields, kSettingMax), row.max);
        (void)Number(Field(fields, kSettingStep), row.step);
        row.advanced = Flag(fields, kSettingAdvanced);
        row.options = ParseOptions(Field(fields, kSettingOptions));
        row.group = Field(fields, kSettingGroup);

        const std::string& visible = Field(fields, kSettingVisibleWhen);
        if (const std::size_t equals = visible.find('='); equals != std::string::npos) {
            row.visible_key = visible.substr(0, equals);
            // The values are `|`-separated inside this one field, which the
            // percent-encoding kept out of the record's own framing.
            std::string_view rest{visible};
            rest.remove_prefix(equals + 1);
            for (;;) {
                const std::size_t bar = rest.find('|');
                if (bar == std::string_view::npos) {
                    row.visible_values.emplace_back(rest);
                    break;
                }
                row.visible_values.emplace_back(rest.substr(0, bar));
                rest.remove_prefix(bar + 1);
            }
        }

        plugin->settings.push_back(std::move(row));
        return false;
    }

    // A kind this build has never heard of. Ignored, which is the contract.
    return false;
}

void ControlMirror::Reset() noexcept {
    plugins_.clear();
    staging_.clear();
    syncing_ = false;
    // An emptied list is a new state of the list, so it counts as a sync. An
    // overlay waiting for its interaction to be answered is answered by the
    // link going down, and would otherwise wait for a runtime that has gone.
    ++version_;
}

}  // namespace brownie::overlay
