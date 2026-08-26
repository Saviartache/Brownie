#include "core/KeyChord.h"

#include <cctype>
#include <cstddef>

#include <Windows.h>

namespace brownie::core {
namespace {

constexpr int kDown = 0x8000;

[[nodiscard]] bool Down(int virtual_key) noexcept {
    return (::GetAsyncKeyState(virtual_key) & kDown) != 0;
}

/// One bindable key on the keyboard, by position rather than by what it types.
struct ScanName {
    std::string_view name;
    std::uint16_t scan_code;
};

/// One bindable mouse button.
struct ButtonName {
    std::string_view name;
    std::uint8_t virtual_key;
};

/// Set 1 scan codes, which is what `MapVirtualKey` speaks on every Windows
/// keyboard. The names are the US keycaps, because the *position* is what is
/// being named and that is the layout everybody draws positions in.
///
/// Left out on purpose:
///
///   * the modifiers, which are the prefixes rather than keys of their own;
///   * `Escape`, which abandons a capture;
///   * the lock keys, which are switches the operating system reads;
///   * the numpad's `Enter`, which shares a virtual key with the main one — a
///     name that cannot be told from another name is a bind that lies.
constexpr ScanName kKeys[] = {
    {"1", 0x02},          {"2", 0x03},          {"3", 0x04},          {"4", 0x05},
    {"5", 0x06},          {"6", 0x07},          {"7", 0x08},          {"8", 0x09},
    {"9", 0x0A},          {"0", 0x0B},          {"Minus", 0x0C},      {"Equals", 0x0D},
    {"Backspace", 0x0E},  {"Tab", 0x0F},        {"Q", 0x10},          {"W", 0x11},
    {"E", 0x12},          {"R", 0x13},          {"T", 0x14},          {"Y", 0x15},
    {"U", 0x16},          {"I", 0x17},          {"O", 0x18},          {"P", 0x19},
    {"LeftBracket", 0x1A},{"RightBracket", 0x1B},{"Enter", 0x1C},     {"A", 0x1E},
    {"S", 0x1F},          {"D", 0x20},          {"F", 0x21},          {"G", 0x22},
    {"H", 0x23},          {"J", 0x24},          {"K", 0x25},          {"L", 0x26},
    {"Semicolon", 0x27},  {"Quote", 0x28},      {"Backquote", 0x29},  {"Backslash", 0x2B},
    {"Z", 0x2C},          {"X", 0x2D},          {"C", 0x2E},          {"V", 0x2F},
    {"B", 0x30},          {"N", 0x31},          {"M", 0x32},          {"Comma", 0x33},
    {"Period", 0x34},     {"Slash", 0x35},      {"NumpadMultiply", 0x37},
    {"Space", 0x39},      {"F1", 0x3B},         {"F2", 0x3C},         {"F3", 0x3D},
    {"F4", 0x3E},         {"F5", 0x3F},         {"F6", 0x40},         {"F7", 0x41},
    {"F8", 0x42},         {"F9", 0x43},         {"F10", 0x44},        {"Numpad7", 0x47},
    {"Numpad8", 0x48},    {"Numpad9", 0x49},    {"NumpadMinus", 0x4A},{"Numpad4", 0x4B},
    {"Numpad5", 0x4C},    {"Numpad6", 0x4D},    {"NumpadPlus", 0x4E}, {"Numpad1", 0x4F},
    {"Numpad2", 0x50},    {"Numpad3", 0x51},    {"Numpad0", 0x52},    {"NumpadPeriod", 0x53},
    {"F11", 0x57},        {"F12", 0x58},        {"NumpadDivide", 0xE035},
    {"Home", 0xE047},     {"Up", 0xE048},       {"PageUp", 0xE049},   {"Left", 0xE04B},
    {"Right", 0xE04D},    {"End", 0xE04F},      {"Down", 0xE050},     {"PageDown", 0xE051},
    {"Insert", 0xE052},   {"Delete", 0xE053},
};

/// The mouse buttons worth binding.
///
/// **Not the left or right button**, which are the game's own shoot and ability
/// — binding one of those would be a plugin that switches on every time the
/// player fires, and there is no way to press one without the other.
constexpr ButtonName kButtons[] = {
    {"Mouse3", VK_MBUTTON},
    {"Mouse4", VK_XBUTTON1},
    {"Mouse5", VK_XBUTTON2},
};

struct ModifierName {
    std::string_view name;
    std::uint8_t bit;
    int virtual_key;
};

/// In the order a chord spells them, so the same chord always reads the same.
constexpr ModifierName kModifiers[] = {
    {"Ctrl", kModCtrl, VK_CONTROL},
    {"Shift", kModShift, VK_SHIFT},
    {"Alt", kModAlt, VK_MENU},
};

[[nodiscard]] bool SameIgnoringCase(std::string_view left, std::string_view right) noexcept {
    if (left.size() != right.size()) return false;
    for (std::size_t i = 0; i < left.size(); ++i) {
        const auto a = static_cast<unsigned char>(left[i]);
        const auto b = static_cast<unsigned char>(right[i]);
        if (std::tolower(a) != std::tolower(b)) return false;
    }
    return true;
}

/// Which modifiers are down, as the bits a chord carries.
[[nodiscard]] std::uint8_t HeldModifiers() noexcept {
    std::uint8_t held = 0;
    for (const ModifierName& modifier : kModifiers) {
        if (Down(modifier.virtual_key)) held |= modifier.bit;
    }
    return held;
}

/// The virtual key a scan code means on the keyboard in front of the player
/// *now*, which is the whole reason a bind stores the scan code.
[[nodiscard]] int VirtualKeyOf(std::uint16_t scan_code) noexcept {
    return static_cast<int>(::MapVirtualKeyW(scan_code, MAPVK_VSC_TO_VK_EX));
}

/// Applies one word of a chord. Returns false when it is not one.
[[nodiscard]] bool ApplyWord(std::string_view word, KeyChord& chord) noexcept {
    for (const ModifierName& modifier : kModifiers) {
        if (SameIgnoringCase(word, modifier.name)) {
            chord.modifiers |= modifier.bit;
            return true;
        }
    }
    // Everything past the modifiers is the key itself, and there is exactly
    // one: a second would be a chord nothing can press.
    if (chord.bound()) return false;

    for (const ScanName& key : kKeys) {
        if (SameIgnoringCase(word, key.name)) {
            chord.scan_code = key.scan_code;
            return true;
        }
    }
    for (const ButtonName& button : kButtons) {
        if (SameIgnoringCase(word, button.name)) {
            chord.mouse_button = button.virtual_key;
            return true;
        }
    }
    return false;
}

}  // namespace

KeyChord ParseChord(std::string_view text) {
    KeyChord chord;
    if (text.empty()) return chord;

    std::string_view rest = text;
    for (;;) {
        const std::size_t plus = rest.find('+');
        const std::string_view word = plus == std::string_view::npos ? rest : rest.substr(0, plus);
        if (word.empty() || !ApplyWord(word, chord)) return KeyChord{};
        if (plus == std::string_view::npos) break;
        rest.remove_prefix(plus + 1);
    }
    // Modifiers with nothing to modify. Refused rather than kept, because a
    // chord that is only `Ctrl` is one every other chord would also match.
    return chord.bound() ? chord : KeyChord{};
}

std::string FormatChord(const KeyChord& chord) {
    if (!chord.bound()) return {};

    std::string text;
    for (const ModifierName& modifier : kModifiers) {
        if ((chord.modifiers & modifier.bit) == 0) continue;
        text.append(modifier.name);
        text.push_back('+');
    }
    if (chord.mouse_button != 0) {
        for (const ButtonName& button : kButtons) {
            if (button.virtual_key == chord.mouse_button) {
                text.append(button.name);
                return text;
            }
        }
        return {};
    }
    for (const ScanName& key : kKeys) {
        if (key.scan_code == chord.scan_code) {
            text.append(key.name);
            return text;
        }
    }
    // A scan code this build has no name for. Nothing rather than a number: an
    // unnamed key is one the overlay cannot show and the runtime cannot store.
    return {};
}

bool ChordHeld(const KeyChord& chord) noexcept {
    if (!chord.bound()) return false;
    if (HeldModifiers() != chord.modifiers) return false;
    if (chord.mouse_button != 0) return Down(chord.mouse_button);

    const int virtual_key = VirtualKeyOf(chord.scan_code);
    return virtual_key != 0 && Down(virtual_key);
}

KeyChord PressedChord() noexcept {
    const std::uint8_t modifiers = HeldModifiers();

    for (const ScanName& key : kKeys) {
        const int virtual_key = VirtualKeyOf(key.scan_code);
        if (virtual_key != 0 && Down(virtual_key)) {
            return KeyChord{key.scan_code, 0, modifiers};
        }
    }
    for (const ButtonName& button : kButtons) {
        if (Down(button.virtual_key)) {
            return KeyChord{0, button.virtual_key, modifiers};
        }
    }
    return KeyChord{};
}

bool CaptureCancelled() noexcept {
    return Down(VK_ESCAPE);
}

}  // namespace brownie::core
