// What the module does through the scene itself, and the pass that does it.
//
// **Three things, and they are together here for one reason**: they need the
// same walk through Unity's object model, and doing that walk three times would
// be three times the calls into the game for the same answer. One holds the
// player's health bar at a fixed colour; one zeroes the player's collision
// radius; one shows a line of the game's own text over the player. The first
// two are the reference module's and are off until somebody switches them on;
// the third does nothing until the runtime has something to say.
//
// **Two threads meet here, as they do in `PlayerControl`.** What the operator
// switched on is noticed on the render thread; resolving and installing a
// detour is the IPC thread's, because putting a hook in suspends every other
// thread in the game and a frame is not the place to do that. The pass itself
// runs on the game's own thread, which is the only one that may call into
// managed code.
//
// **The pass is on a cadence and a slow one.** It starts with
// `GameObject.Find`, which walks the scene; the reference module ran it twice a
// second and no faster, and there is nothing here that a frame would notice
// happening later.

#pragma once

#include <atomic>
#include <cstdint>

#include <string_view>

#include "app/Cadence.h"
#include "game/FloatingText.h"
#include "game/HealthBarTint.h"
#include "game/Il2CppRuntime.h"
#include "game/OffsetTable.h"
#include "game/PlayerCollision.h"
#include "game/PlayerRoute.h"
#include "game/UnityScene.h"

namespace brownie::app {

/// What the operator has switched on. Off is the default for both, and the
/// module does nothing to the scene until one of them is not.
struct ScenePatchWants {
    /// Hold the local player's health bar at one colour — the module's sign
    /// that it is attached and acting.
    bool health_bar_tint = false;
    /// What colour to hold it at. Ignored while the tint is off.
    game::UiColor tint_colour = game::HealthBarTint::kDefaultColour;
    /// Zero the local player's collision radius, which is what area damage is
    /// decided against — see `game/PlayerCollision.h`.
    bool no_hitbox = false;
};

class ScenePatches {
  public:
    /// How often the scene is walked. Slow on purpose — see the file comment.
    static constexpr std::uint32_t kPassIntervalMs = 500;

    ScenePatches() noexcept = default;

    ScenePatches(const ScenePatches&) = delete;
    ScenePatches& operator=(const ScenePatches&) = delete;

    /// What the operator wants, from the frame that drew the switches.
    /// **Game thread**, in the same frame as {@link Apply} — the switches are
    /// drawn inside the `Present` detour and acted on there.
    void Want(const ScenePatchWants& wants) noexcept;

    /// Binds whatever has resolved since last time, and installs the tint's
    /// detour once something wants it. **IPC thread**, every turn until there
    /// is nothing left to do.
    void AdvanceSetup(const game::Il2CppRuntime& game, const game::OffsetTable& table);

    /// One pass over the scene, if one is due and anything is switched on.
    /// **Game thread only.**
    void Apply(std::uint64_t now_ms);

    /// Stops touching the game: the tint stops substituting and no further pass
    /// happens. Any thread.
    ///
    /// **The detours stay in place**, because taking one out means suspending
    /// every thread in the game and this is called from the one path where the
    /// game is already on its way out. They forward every call once nothing is
    /// watched, which is what this leaves behind.
    void Release() noexcept;

    /// Whether the tint's detour is in place, and how many calls it has
    /// substituted — for the overlay to show that a switch did something.
    [[nodiscard]] bool tint_installed() const noexcept { return tint_.installed(); }
    [[nodiscard]] std::uint32_t tinted() const noexcept { return tint_.tinted(); }

    /// Whether the collision write has everything it needs, and how many times
    /// it has happened.
    [[nodiscard]] bool collision_bound() const noexcept { return collision_.bound(); }
    [[nodiscard]] std::uint32_t collisions_cleared() const noexcept { return collision_.applied(); }

    /// The route to the local player, which the floating text starts its two
    /// hops from. **IPC thread**, once, and until it arrives no line is shown.
    void BindPlayer(const game::PlayerRoute& route) noexcept;

    /// Leaves a line for the game to show over the player, replacing whatever
    /// was waiting. **Any thread** — it is the IPC thread that calls it, and it
    /// neither allocates nor touches the game.
    ///
    /// Unlike the two switches this is not a want: there is nothing to keep
    /// wanting, and a message shown twice because a pass came round again would
    /// be a message nobody asked for.
    void ShowText(std::string_view text, std::uint32_t rgba) noexcept { text_.Queue(text, rgba); }

    /// Whether the text detours are in, and how many lines of ours have reached
    /// the game.
    [[nodiscard]] bool text_installed() const noexcept { return text_.installed(); }
    [[nodiscard]] std::uint32_t texts_shown() const noexcept { return text_.shown(); }

  private:
    /// Finds the health bar's fill and hands it to the tint. Game thread.
    void TrackHealthBar();

    /// Resolves the classes a feature needs as a class rather than as an
    /// offset. IPC thread; each is asked again until it answers.
    void BindClasses(const game::Il2CppRuntime& game, const game::OffsetTable& table);

    game::UnityScene scene_;
    game::HealthBarTint tint_;
    game::PlayerCollision collision_;
    game::FloatingText text_;

    /// Where the local player is reached from. Written once by the IPC thread
    /// before {@link route_ready_}, read by the pass on the game's.
    game::PlayerRoute route_{};
    std::atomic<bool> route_ready_{false};

    /// Published by the IPC thread, read by the game's. Both are written once
    /// and never changed, so an acquire on either is enough.
    std::atomic<const game::Il2CppRuntime*> game_{nullptr};
    std::atomic<game::ClassRef> image_class_{nullptr};

    std::atomic<bool> tint_wanted_{false};
    std::atomic<bool> hitbox_wanted_{false};
    std::atomic<bool> released_{false};

    // --- Game thread only. Both `Want` and `Apply` run inside the same frame,
    // --- so nothing below needs to be published to anybody.

    /// The last colour asked for, and whether it still has to be shown.
    ///
    /// A repaint outside the pass, because the pass runs twice a second and a
    /// colour picker being dragged has to answer now — a slider that shows its
    /// result half a second later is a slider nobody can aim.
    std::uint32_t colour_ = game::PackColour(game::HealthBarTint::kDefaultColour);
    bool repaint_ = false;

    Cadence pass_{kPassIntervalMs};
};

}  // namespace brownie::app
