// Getting hold of the running game, and keeping hold of what it told us.
//
// Everything here happens on the IPC thread and nothing here is ever undone:
// the runtime is bound once and lives until the module is unloaded, because a
// frame on the game's own thread reads through what this hands over and there
// is no moment at which taking it back would be safe.
//
// Failing is the ordinary case for most of a run. The module is loaded before
// IL2CPP starts, the class holding the player's stats does not exist until the
// game has made a player, and a method is registered whenever the runtime gets
// round to it. So every step is asked again on the next turn of the loop rather
// than attempted once at startup — which is what makes this self-healing after
// a realm change or a game patch instead of dead until a restart.

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include "game/Il2CppReady.h"
#include "game/Il2CppRuntime.h"
#include "game/MapFields.h"
#include "game/OffsetTable.h"
#include "game/PlayerHandle.h"
#include "game/PlayerRoute.h"
#include "overlay/Ui.h"

namespace brownie::app {

class GameBinding {
  public:
    GameBinding() noexcept = default;

    GameBinding(const GameBinding&) = delete;
    GameBinding& operator=(const GameBinding&) = delete;

    /// Watches for the runtime to finish starting. Cheap, and the answer is
    /// what gates everything below — see `game/Il2CppReady.h` for why the
    /// obvious test is wrong.
    void Observe() { ready_.Observe(); }

    /// Binds to the game's IL2CPP runtime if it is up and we have not already.
    void TryBind();

    /// Resolves any player field or method still missing.
    ///
    /// @returns whether anything new was found, so the caller knows the offset
    ///   report is worth republishing.
    [[nodiscard]] bool TryResolve();

    [[nodiscard]] bool bound() const noexcept { return game_ != nullptr; }

    /// The runtime, or null before it is bound.
    [[nodiscard]] const game::Il2CppRuntime* runtime() const noexcept { return game_.get(); }

    /// Why there is no runtime yet, in the words `Il2CppReady` uses.
    [[nodiscard]] const char* state() const noexcept { return ready_.state(); }

    /// Every offset this run has looked for, resolved or not. Empty until the
    /// runtime is bound, because an offset means nothing without it.
    [[nodiscard]] std::span<const game::OffsetTable::Entry> offsets() const noexcept;

    /// A resolved method's entry point, if it has one.
    [[nodiscard]] std::optional<void*> MethodAddress(std::string_view key) const;

    /// A resolved field's offset, if it has one.
    [[nodiscard]] std::optional<std::uint32_t> FieldOffset(std::string_view key) const;

    /// Everything resolved so far, for a feature that needs more than one
    /// answer out of it. Null until the runtime is bound.
    ///
    /// Handed over as a `const` reference, which is what makes this narrow:
    /// resolving is this class's job and nobody else can do it through this.
    [[nodiscard]] const game::OffsetTable* table() const noexcept;

    /// The walk from a static field to the player object, once every offset it
    /// needs has resolved.
    [[nodiscard]] std::optional<game::PlayerRoute> Route() const;

    /// Every `bool(float, float)` the world manager declares, found once and
    /// kept — see `game/MapFields.h` for why it is a shape and not a name.
    ///
    /// Not resolved with the rest, because finding them enumerates a class and
    /// nothing needs them until player noclip is switched on. Empty until the
    /// game has built a realm, so a caller asks again.
    [[nodiscard]] std::span<const game::WalkabilityPredicate> WalkabilityPredicates();

    /// Reads the player out of the game's memory, checked against what the
    /// server said.
    ///
    /// @returns whether the reading differs from the last one. Compared rather
    ///   than assigned because the model is only republished on a change — and
    ///   while the player stands still this is the one thing that would
    ///   otherwise freeze without anyone noticing.
    [[nodiscard]] bool ReadPlayer(const overlay::WorldStatus& world);

    [[nodiscard]] const overlay::MemoryReading& reading() const noexcept { return reading_; }

    /// The raw player object, for the diagnostic that prints it word by word.
    /// Empty when there is no player to read right now.
    [[nodiscard]] std::vector<std::byte> SnapshotPlayer();

  private:
    /// Holds a hook, so whoever owns this must declare it after the object that
    /// owns MinHook and thereby destroy it before.
    game::Il2CppReady ready_;
    std::unique_ptr<game::Il2CppRuntime> game_;
    /// Built once the runtime is bound, and destroyed with it: every offset in
    /// it belongs to this run of this game and means nothing without it.
    std::optional<game::OffsetTable> offsets_;
    game::PlayerHandle player_;
    overlay::MemoryReading reading_;
    std::vector<game::WalkabilityPredicate> walkability_;
};

}  // namespace brownie::app
