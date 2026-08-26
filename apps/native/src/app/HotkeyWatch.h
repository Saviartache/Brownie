// The keys the runtime asked to be told about, watched.
//
// **Polled, not hooked.** A bind is a state — is this key down *now* — and
// asking once every turn of the loop answers it in one place, without a message
// filter that has to reconstruct it from four kinds of message and get focus
// loss right as well. It is the same argument the walk chord and the movement
// keys are read under; see `Engine::DrawFrame`.
//
// **This reports what happened and decides nothing.** A press goes to the
// runtime as an edge — the key went down, or a held one came up — and what that
// means to a plugin's switch is decided there, because the switch is there. A
// toggle in particular cannot be resolved here at all: flipping a switch needs
// to know which way it is currently set, and this side does not.
//
// Two rules make it safe rather than merely working, and both were paid for by
// the shape of the problem rather than by a live session:
//
//   * **a bind never fires on a key that was already down when it appeared** —
//     otherwise rebinding to the key you are holding fires instantly, and so
//     does reconnecting mid-press;
//   * **a hold that stops being watchable is released** — the player alt-tabbed,
//     opened the overlay, or rebound the key while holding it, and a hold with
//     no release behind it is a plugin left running by a key nobody is pressing.

#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/KeyChord.h"

namespace brownie::app {

/// The two things a press can mean, spelled as the runtime spells them. See
/// `apps/runtime/src/plugins/pluginBind.ts`.
inline constexpr std::string_view kToggleAction = "toggle";
inline constexpr std::string_view kHoldAction = "hold";

/// One bind, as the runtime described it.
///
/// A plugin can offer more than one key — one that switches it on, another that
/// tells it something mid-fight — so what identifies a bind is the plugin *and*
/// the slot, and nothing here interprets either.
struct HotkeyBind {
    std::string plugin_id;
    /// Which of that plugin's switches the key moves. Empty is its own.
    std::string slot;
    /// Whether the switch follows the key rather than flipping under it.
    bool hold = false;
    core::KeyChord chord;
};

class HotkeyWatch {
  public:
    /// Where an edge goes. Taken per call rather than held, so this owns no
    /// reference to anything that can outlive it.
    using Report = std::function<void(std::string_view plugin_id, std::string_view slot,
                                      std::string_view action, bool value)>;

    /// Whether one chord is held right now.
    using KeyState = std::function<bool(const core::KeyChord&)>;

    /// The real keyboard by default; the self-check hands in a table instead,
    /// because it has no keyboard to press and what is worth checking here is
    /// the edges rather than the reading.
    explicit HotkeyWatch(KeyState held = KeyState{&core::ChordHeld}) : held_{std::move(held)} {}

    /// Replaces the watched set, carrying over what is known about a bind that
    /// has not changed.
    ///
    /// Carried rather than rebuilt because the runtime re-publishes its whole
    /// plugin list whenever *anything* changes — moving one slider would
    /// otherwise re-arm every bind, and a toggle key still held at that moment
    /// would fire again for nothing.
    ///
    /// A bind that is gone, or whose key changed, releases its hold through
    /// `report` before it goes.
    void Watch(std::vector<HotkeyBind> binds, const Report& report);

    /// One turn. `watchable` is whether the player is looking at the game
    /// rather than at a panel over it or at another application; when they are
    /// not, every key reads as up — which is what releases a hold across an
    /// alt-tab instead of leaving it stuck on.
    void Poll(bool watchable, const Report& report);

    /// Whether anything is bound. The loop shortens its wait only while this is
    /// true, so a session with no binds pays nothing for the feature.
    [[nodiscard]] bool watching() const noexcept { return !watched_.empty(); }

  private:
    struct Watched {
        HotkeyBind bind;
        /// Whether the chord was down when it was last looked at.
        bool down = false;
        /// Whether a hold has been reported and not yet released.
        bool holding = false;
    };

    /// Reports the release of a hold, if one is live, and forgets it.
    static void Release(Watched& watched, const Report& report);

    KeyState held_;
    std::vector<Watched> watched_;
};

}  // namespace brownie::app
