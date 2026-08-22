// Walking where the client would not let the player walk.
//
// The client asks the world manager whether a place can be stood on before it
// moves the player there, and while this is on the answer is always yes. One
// detour per predicate, over every one `MapFields.h` found, each of which
// returns `true` instead of calling through.
//
// **What this is for is the things standing on the map** — the trees and the
// like that a player walks around — and not the walls of a dungeon. A wall is
// the server's opinion as much as the client's, and no amount of answering yes
// here changes what the server sends back; the objects on a square are the
// client's own bookkeeping, and that is what this reaches. The reference
// implementation is the same feature and never did more than that: its own
// noclip only unblocked the *module's* walk-to-a-point, which is a thing this
// project does not have and did not copy.
//
// **All of them, and which one decides is not known.** A live run counted the
// calls once: of the nine this build declares, three are ever asked and six are
// never called at all. That was enough to retire the counters and not enough to
// narrow the set — a predicate that went unasked for one session in one map is
// not a predicate the game does not have, and the six cost nothing precisely
// because nothing calls them.
//
// **This is half of a feature.** Silencing the client's own gate is not what
// keeps the player where it let them go: the server has its own idea of where
// they are and pulls them back, so the runtime holds the client's uplink for as
// long as noclip is on. That half lives where the packets are, and this module
// never learns about it: what reaches here is one switch.
//
// **Each detour goes in on its own.** `ProjectileNoclip` refuses to install
// half of its pair because its two detours are a take and a put-back, and half
// of that is a hole in somebody's map. There is nothing to put back here — an
// override lasts exactly as long as the call it answers — so a predicate that
// fails to hook leaves the others working.
//
// **Installed and enabled are separate**, for the reason `ProjectileNoclip.h`
// gives: a detour is a write into the game's code and stays once it is in,
// while what the operator wants changes with a click. With this off every
// detour forwards its call and the client decides exactly as it did before.
//
// **The work is one atomic load on the ordinary path.** These predicates are
// asked several times per frame; the detour reads one relaxed flag and, off,
// jumps through the trampoline. Nothing is read out of the game and nothing is
// written into it.

#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>

#include "core/Result.h"
#include "game/MapFields.h"
#include "hooks/Hook.h"

namespace brownie::game {

class PlayerNoclip {
  public:
    /// One detour is one C function with an index baked into it, so there is a
    /// fixed number of them and this is it.
    static constexpr std::size_t kMaxGates = kMaxWalkabilityPredicates;

    PlayerNoclip() noexcept = default;

    PlayerNoclip(const PlayerNoclip&) = delete;
    PlayerNoclip& operator=(const PlayerNoclip&) = delete;
    PlayerNoclip(PlayerNoclip&&) = delete;
    PlayerNoclip& operator=(PlayerNoclip&&) = delete;

    /// Removes every detour. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~PlayerNoclip();

    /// Puts a detour on each predicate that has an address and is not in yet.
    /// **IPC thread.**
    ///
    /// Only one of these may exist per process, for the reason `AimHook` gives:
    /// a detour is a C callback with nowhere to carry a `this`. A second object
    /// is refused, and so are more predicates than {@link kMaxGates}.
    ///
    /// @returns success as soon as any detour is live, so a caller stops asking
    ///   when it has something; `kNotReady` while there is nothing to hook.
    Status Install(std::span<const WalkabilityPredicate> predicates);

    /// Removes them. Safe to call more than once, and from any thread.
    void Remove() noexcept;

    /// Whether any detour is live and doing its work.
    [[nodiscard]] bool installed() const noexcept { return hooked_ != 0; }

    /// How many detours went on, which is what the overlay shows.
    [[nodiscard]] std::size_t hooked() const noexcept { return hooked_; }

    /// Switches the feature on and off. Any thread, and cheap enough to call
    /// every frame — which is how the runtime's switch reaches it.
    void SetEnabled(bool on) noexcept { enabled_.store(on, std::memory_order_relaxed); }

    [[nodiscard]] bool enabled() const noexcept {
        return enabled_.load(std::memory_order_relaxed);
    }

    /// How many answers have been overridden across every predicate, for the
    /// overlay to show. A switch that is on and a feature that is working look
    /// identical without it.
    [[nodiscard]] std::uint32_t allowed() const noexcept {
        return allowed_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detours in PlayerNoclip.cpp. Public because a free
    // --- function cannot be a friend of a class it does not know about.

    /// Whether to answer this call instead of letting it through, counting it
    /// when it is.
    [[nodiscard]] bool Override() noexcept;

    /// The code the detour at `index` replaced, to call through to. Null when
    /// there is no such detour, which is what a stray call is checked against.
    [[nodiscard]] void* original(std::size_t index) const noexcept;

  private:
    /// One detour, so that either failing says nothing about the other.
    Status InstallOne(std::size_t index, void* target);

    std::array<hooks::Hook, kMaxGates> hooks_{};
    std::array<void*, kMaxGates> originals_{};

    /// How many detours are in, which is also how many entries above mean
    /// anything. Written by the IPC thread before a detour is enabled — which
    /// is what publishes it, because enabling a hook suspends every other
    /// thread.
    std::size_t hooked_ = 0;

    std::atomic<bool> enabled_{false};
    std::atomic<std::uint32_t> allowed_{0};
};

}  // namespace brownie::game
