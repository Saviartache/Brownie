// A glow of the operator's own colour around the local player.
//
// **Two writes, because the game keeps the two halves apart.** Whether a
// character glows is a flag on the character; what colour the glow is comes
// from a style the game picks for it — see `GlowFields.h`. Neither is any use
// without the other, so they are one class: switching the flag on gives a red
// glow, and recolouring the style with nothing glowing changes nothing anybody
// can see.
//
// The flag is set through the game's own setter rather than by writing the
// field, for the reason movement goes through `MoveTo`: the setter rebuilds the
// character's visual, and a glow that has not been rebuilt is not drawn.
//
// **That rebuild is also why a repaint has to ask for one.** The style is read
// when a character's glow is next built, not every frame, so a colour written
// on its own would not appear until something else happened to rebuild. The
// setter is called again with the value already in the field — for the rebuild,
// not for the write — and only on the pass that repainted. Never on a loop: a
// rebuild asked for every pass is an animation restarted every pass.
//
// **Nothing here is sent anywhere.** The flag is a client-side field that no
// packet carries, and the style is a client-side object; the server is never
// told, and no other player's client is either.

#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <optional>

#include "game/Il2CppRuntime.h"
#include "game/OffsetTable.h"
#include "game/PlayerRoute.h"
#include "game/UnityColor.h"

namespace brownie::game {

class PlayerGlow {
  public:
    /// Resolves everything, or nothing. **IPC thread**, and repeatable: the
    /// style classes are built the first time the game draws a character that
    /// has one, so the early turns of a run find nothing.
    ///
    /// All-or-nothing on purpose. A glow lit without its colour is the game's
    /// red, which is not what was asked for and is worse than no glow at all.
    void Bind(const Il2CppRuntime& game, const OffsetTable& table);

    /// Holds the player glowing in `wanted`, or puts back what the game had.
    /// **Game thread only.**
    ///
    /// @returns whether anything was written this pass, which is nothing at all
    ///   once the glow is lit and painted — the ordinary case.
    bool Apply(const Il2CppRuntime& game, const PlayerRoute& route,
               std::optional<UiColor> wanted);

    /// Whether there is anything of ours left in the game to put back.
    [[nodiscard]] bool holding() const noexcept {
        return applied_flag_.has_value() || original_aura_.has_value() ||
               original_outline_.has_value();
    }

  private:
    /// The most bytes an outline style may occupy for this to touch it.
    ///
    /// The value is read whole, edited and put back, so it lands on the stack —
    /// and the bound is what keeps a size that came out of the game's own
    /// metadata from deciding how much stack that is. A style is a colour and a
    /// few floats; anything past this is not the struct being looked for, and
    /// refusing it leaves the feature off rather than reading past a buffer.
    static constexpr std::size_t kMaxStyleBytes = 64;

    /// Each returns whether it wrote anything, which is what decides whether
    /// the character has to be rebuilt for the result to be drawn.
    [[nodiscard]] bool HoldFlag(void* player, std::int32_t current);
    [[nodiscard]] bool RestoreFlag(void* player, std::int32_t current);
    [[nodiscard]] bool HoldColour(const Il2CppRuntime& game, const UiColor& colour);
    [[nodiscard]] bool RestoreColour(const Il2CppRuntime& game);

    /// Asks the game to rebuild the character's visual, by handing its setter
    /// the value already in the field.
    void Rebuild(void* player, std::int32_t current) const;

    // Written by `Bind` before `bound_` is published, read by the game thread
    // after it. Nothing is written again once it is set, so the game's thread
    // never sees half a binding.
    std::uint32_t glow_at_ = 0;
    void* set_glow_ = nullptr;
    Il2CppRuntime::StaticFieldRef aura_style_ = nullptr;
    Il2CppRuntime::StaticFieldRef outline_style_ = nullptr;
    std::uint32_t aura_colour_at_ = 0;
    /// Where the colour sits in the outline style's *value*, which is not where
    /// the metadata says: see `Il2CppRuntime::StaticValueLayout`.
    std::uint32_t outline_colour_at_ = 0;
    std::size_t outline_bytes_ = 0;
    std::atomic<bool> bound_{false};

    // Game thread only.
    std::optional<std::int32_t> original_flag_;
    std::optional<std::int32_t> applied_flag_;
    std::optional<UiColor> original_aura_;
    std::optional<UiColor> original_outline_;
};

}  // namespace brownie::game
