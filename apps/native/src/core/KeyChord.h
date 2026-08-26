// A key a player can bind, named in a way that survives their keyboard layout.
//
// **The physical key, not the character it types.** Windows layouts map a scan
// code — which is the key's position on the keyboard, and is what the hardware
// sends — to a virtual key, and which virtual key that is depends on the
// layout: the key labelled `A` is `VK_A` on a US or Russian layout and `VK_Q`
// on a French one. `GetAsyncKeyState` takes virtual keys, so a bind stored as
// one is a bind that moves when the layout does.
//
// So a chord is stored as its **scan code**, and the layout is asked afresh
// every time the key is read. Pressing the key marked `F` binds `F`, whether it
// was typing `f`, `а` or `;` at the time, and it keeps working after the player
// switches layouts mid-session — which they do, because chat is in one language
// and the game's own keys are laid out for another.
//
// **The names are this module's, and only this module's.** The runtime stores
// what it is handed and never interprets it: only this side can watch a
// keyboard, name a key somebody just pressed, or know what a name means on the
// keyboard in front of them. See `docs/ipc.md` and
// `apps/runtime/src/plugins/pluginBind.ts`.

#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace brownie::core {

/// The modifiers a chord may require, as bits.
///
/// Either side of each pair counts: a player holding the right-hand Shift is
/// holding Shift, and telling the two apart would be a distinction nothing in
/// the overlay can show and nobody asked for.
inline constexpr std::uint8_t kModCtrl = 1U;
inline constexpr std::uint8_t kModShift = 2U;
inline constexpr std::uint8_t kModAlt = 4U;

/// One bindable key, plus the modifiers that must be held with it.
struct KeyChord {
    /// The key's scan code, with `0xE0` in the high byte for an extended key.
    /// Zero when the chord names a mouse button, or nothing at all.
    std::uint16_t scan_code = 0;
    /// The virtual key of a mouse button, when that is what was bound. Mouse
    /// buttons have no scan code — they are not on the keyboard — so they are
    /// the one thing here named by virtual key, and layouts cannot move them.
    std::uint8_t mouse_button = 0;
    std::uint8_t modifiers = 0;

    [[nodiscard]] bool bound() const noexcept { return scan_code != 0 || mouse_button != 0; }

    [[nodiscard]] bool operator==(const KeyChord& other) const noexcept {
        return scan_code == other.scan_code && mouse_button == other.mouse_button &&
               modifiers == other.modifiers;
    }
};

/// Reads `Ctrl+Shift+F`, or leaves the chord unbound when the text is not one.
///
/// Case-insensitive, because the only writer is {@link FormatChord} but the
/// only *editor* is a person with the configuration file open — and a bind
/// silently lost to a lower-case `f5` is a bind that looks like a bug in this.
/// Anything genuinely unrecognisable is unbound rather than partly read: half a
/// chord is a key nobody chose.
[[nodiscard]] KeyChord ParseChord(std::string_view text);

/// The one spelling of a chord, empty when it is unbound.
[[nodiscard]] std::string FormatChord(const KeyChord& chord);

/// Whether every part of the chord is down right now.
///
/// **The modifiers must match exactly**, so `Ctrl+F` and `F` are two different
/// binds rather than one that swallows the other. Reads the physical keyboard,
/// so the caller decides whether the player is looking at the game.
[[nodiscard]] bool ChordHeld(const KeyChord& chord) noexcept;

/// The bindable chord being pressed right now, for a capture prompt, or an
/// unbound one when nothing is.
///
/// A modifier on its own is not a chord: it qualifies the key that follows,
/// and finishing a capture on it would bind Shift to something the moment the
/// player reached for a capital letter.
[[nodiscard]] KeyChord PressedChord() noexcept;

/// Whether the key that abandons a capture is down.
///
/// Escape, and it is deliberately not bindable: a prompt that waits for a key
/// and has no way out is one a player can only escape by binding something.
[[nodiscard]] bool CaptureCancelled() noexcept;

}  // namespace brownie::core
