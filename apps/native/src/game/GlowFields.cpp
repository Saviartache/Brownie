#include "game/GlowFields.h"

#include <array>

namespace brownie::game {
namespace {

/// The namespace is empty because these classes are in the global one. Spelled
/// out rather than defaulted, so that a class which later moves into a
/// namespace is a visible edit here rather than a silent failure to resolve.
constexpr std::string_view kGlobalNamespace{};

/// Both are obfuscator output with no known real name, so neither carries an
/// alias: an alias is a name we have *seen*, and inventing one would only widen
/// where a match may be made.
constexpr std::string_view kGlowStyleClassName = "INPKDKIEDLB";
constexpr std::string_view kOutlineStyleClassName = "LDHFNAFNELO";

constexpr ClassQuery kGlowStyle{kGlobalNamespace, kGlowStyleClassName, {}};
constexpr ClassQuery kOutlineStyle{kGlobalNamespace, kOutlineStyleClassName, {}};

/// The static field on each class holding the style the glowing flag picks.
///
/// Each class declares several, one per reason a character might glow, and
/// these are the two the flag reaches. Named rather than found by shape: every
/// static on the class has the same type as these, so shape identifies none of
/// them.
constexpr std::string_view kGlowStyleStatic = "ANMLNOFPHOC";
constexpr std::string_view kOutlineStyleStatic = "ADJCJLHNMEB";

constexpr std::string_view kColourType = "UnityEngine.Color";

struct KeyedFieldQuery {
    std::string_view key;
    FieldQuery query;
};

/// The queries.
///
/// **No fingerprints.** A field's shape may only be written from a class a live
/// run described — see `PlayerFields.cpp`, where every number came off a real
/// session — and no live run has yet reported these. `type_count` left at zero
/// disables the layer, so a rename here is a key that goes unresolved and a
/// feature that stays off.
///
/// The type is still given, because it is what the offset is checked against
/// once a live run does report a shape — and because a `Color` read as
/// something else would be four floats of whatever follows it.
constexpr std::array kFields{
    KeyedFieldQuery{kGlowStyleColour,
                    FieldQuery{kGlowStyle, "APDEEPOICMN", {}, kColourType, 0, 0}},
    KeyedFieldQuery{kOutlineStyleColour,
                    FieldQuery{kOutlineStyle, "PACDNKLMHAK", {}, kColourType, 0, 0}},
};

}  // namespace

const ClassQuery& GlowStyleClass() noexcept {
    return kGlowStyle;
}

const ClassQuery& OutlineStyleClass() noexcept {
    return kOutlineStyle;
}

std::string_view GlowStyleStaticName() noexcept {
    return kGlowStyleStatic;
}

std::string_view OutlineStyleStaticName() noexcept {
    return kOutlineStyleStatic;
}

std::size_t ResolveGlowFields(OffsetTable& table) {
    std::size_t resolved = 0;
    for (const auto& entry : kFields) {
        // Already answered, and an answer cannot change for the run. Skipped
        // rather than re-resolved, because resolving enumerates every field the
        // class declares.
        if (table.FieldOffset(entry.key).has_value()) {
            continue;
        }
        if (table.ResolveField(entry.key, entry.query).ok()) {
            ++resolved;
        }
    }
    return resolved;
}

}  // namespace brownie::game
