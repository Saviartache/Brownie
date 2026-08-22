// A line of the game's own text, over the player.
//
// The runtime has two ways to say something already — the overlay, which is
// behind the game window, and chat, which scrolls. Neither is where somebody
// looks while a countdown is running, and a countdown is what this exists for:
// noclip holds the client's uplink, that hold is on a budget, and how much of it
// is left has to be readable without looking away from the game.
//
// `MapObjectUIManager::ShowFloatingText` takes six arguments and they come from
// three places. Each of the three was got wrong once, in a live run, and what
// follows is what each attempt cost:
//
//   * **The receiver is read off the local player**, through the two fields
//     `MapFields`-style: the `ViewHandler` every map object carries, and the UI
//     manager that handler holds. Finding it by walking the scene for a node
//     named "Player" was tried: in a map with three hundred players it finds
//     one of them, and the line appears over a stranger. Damage numbers looked
//     right the whole time, because those are the game's own.
//   * **The style is observed**, because it could not be worked out: it is a
//     member of an enumeration whose type name is obfuscator output, and
//     IL2CPP's C API cannot read an enumeration's constants back at all.
//     Passing zero drew nothing, a hundred and eighty times. So both
//     `ShowFloatingText` overloads are detoured — the string one, and the `int`
//     one that every damage number in the game goes through — and the style
//     argument is kept. **The one seen on our own receiver is preferred**: that
//     is the style the game uses for text over this player, which is exactly
//     the question being asked. What a live run then reported is
//     {@link FloatingText::kDefaultKind}, so a line drawn before the game has
//     drawn any is no longer a line that waits.
//   * **The `MethodInfo*` is observed too**, and passed rather than nulled.
//     Most instance methods reached through their entry point ignore it — this
//     project passes null everywhere else and says so — but this one is called
//     with it by the game, and there is no reason to hand it something else
//     when the real one goes past several times a second.
//
// **The text and the colour are the runtime's**, and the colour is passed as a
// present `Nullable<Color32>` so it overrides whatever the style would have
// chosen — that is what lets the countdown ramp green to red.
//
// **A new receiver is primed before its first line.** The reference
// implementation called the method a dozen times with an empty string on each
// new manager; without it, it reports, the first line did not appear. Why is not
// known — a pool the manager fills lazily is the obvious guess and only a guess
// — so it comes over as it was, with its number, rather than being dropped as
// superstition. It showed nothing on the pass that primed and this one goes on
// to show, which is the one deliberate difference.
//
// **The message is one slot, not a queue.** A counter that ticks once a second
// has nothing to say about the second before it, and a queue would only make the
// game show a backlog after a stall.

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string_view>

#include "core/Result.h"
#include "game/Il2CppRuntime.h"
#include "hooks/Hook.h"

namespace brownie::game {

/// `System.Nullable<UnityEngine.Color32>`, as the compiler lays it out.
///
/// Eight bytes, so it travels in a register like any other small value type. The
/// assertion is not decoration: a layout this file is wrong about would put the
/// colour where the method expects the first of the three floats after it.
struct NullableColor32 {
    bool has_value;
    std::uint8_t padding[3];
    std::uint32_t rgba;
};
static_assert(sizeof(NullableColor32) == 8, "Nullable<Color32> must be eight bytes");

/// A Color32 from three channels, opaque. Unity packs it little-endian as
/// R, G, B, A — the same order the bytes appear in memory.
[[nodiscard]] constexpr std::uint32_t PackColor32(std::uint8_t r, std::uint8_t g,
                                                  std::uint8_t b) noexcept {
    return static_cast<std::uint32_t>(r) | (static_cast<std::uint32_t>(g) << 8) |
           (static_cast<std::uint32_t>(b) << 16) | (std::uint32_t{255} << 24);
}

class FloatingText {
  public:
    /// As much of a message as is kept. Long enough for a sentence and short
    /// enough to live in the object, which is what keeps {@link Queue} free of
    /// allocation on the thread that calls it.
    static constexpr std::size_t kMaxLength = 96;

    /// How many empty lines a new receiver is given first. The reference
    /// implementation's number — see the note at the top of this file.
    static constexpr int kPrimeCalls = 12;

    /// The style to draw in until the game has been seen drawing one.
    ///
    /// **Measured, not chosen.** It is what a live run of this build reported
    /// after the observation above had answered — the first number in this
    /// file's history that anybody has evidence for. It is the default rather
    /// than the answer because it belongs to a build: a game that renumbers its
    /// enumeration is followed the moment it draws anything, and until then a
    /// wrong style costs a line that looks unusual, not one that fails.
    static constexpr std::int32_t kDefaultKind = 6;

    FloatingText() noexcept = default;

    FloatingText(const FloatingText&) = delete;
    FloatingText& operator=(const FloatingText&) = delete;
    FloatingText(FloatingText&&) = delete;
    FloatingText& operator=(FloatingText&&) = delete;

    /// Removes both detours. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~FloatingText();

    /// The two hops from the local player to its UI manager. **IPC thread,
    /// once.**
    void Bind(std::uint32_t view_handler_at, std::uint32_t gui_manager_at);

    [[nodiscard]] bool bound() const noexcept { return bound_.load(std::memory_order_acquire); }

    /// Puts both detours in place, or neither. **IPC thread.**
    ///
    /// Both or neither because they answer one question between them: the
    /// string overload is what a line goes out through, and the `int` one is
    /// where the style comes from. Either alone leaves this unable to draw.
    ///
    /// Only one of these may exist per process, for the reason `AimHook` gives:
    /// a detour is a C callback with nowhere to carry a `this`.
    Status Install(void* show_text, void* show_number);

    /// Removes them. Safe to call more than once, and from any thread.
    void Remove() noexcept;

    [[nodiscard]] bool installed() const noexcept { return live_.load(std::memory_order_acquire); }

    /// The style the next line of ours will be drawn in.
    [[nodiscard]] std::int32_t kind() const noexcept;

    /// Leaves a message for the next pass, replacing whatever was waiting.
    /// **Any thread**, and it neither allocates nor calls into the game.
    ///
    /// Text longer than {@link kMaxLength} is truncated rather than refused: a
    /// countdown that stopped because somebody made its label longer would be a
    /// worse failure than one that reads short.
    void Queue(std::string_view text, std::uint32_t rgba) noexcept;

    /// Whether a message is waiting. **Any thread**, and it takes no lock.
    [[nodiscard]] bool pending() const noexcept {
        return has_pending_.load(std::memory_order_acquire);
    }

    /// Shows whatever is waiting, on `local_player`'s own manager. **Game
    /// thread only** — it allocates a managed string and calls managed code.
    ///
    /// @returns whether a line was shown. False when nothing is waiting and
    ///   between realms, where there is no player to hang it on.
    bool Apply(const Il2CppRuntime& game, void* local_player);

    /// How many of our lines have reached the game.
    [[nodiscard]] std::uint32_t shown() const noexcept {
        return shown_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detours in FloatingText.cpp. Public because a free
    // --- function cannot be a friend of a class it does not know about.

    /// Keeps what one of the game's own calls was made of.
    void Observe(const void* receiver, std::int32_t kind, void* method_info) noexcept;

    /// The code each detour replaced. The string one is also what our own line
    /// is sent through — calling into a hook from outside it is a loop waiting
    /// for the day the two disagree, and it would also record our line as the
    /// game's.
    [[nodiscard]] void* text_original() const noexcept { return text_original_; }
    [[nodiscard]] void* number_original() const noexcept { return number_original_; }

  private:
    /// Drops both hooks and everything published with them. Shared by `Remove`
    /// and by the failure path of `Install`, so a half-installed pair is never
    /// left behind.
    void Detach() noexcept;

    /// The UI manager on the local player's own view handler, or null.
    [[nodiscard]] void* ReceiverOf(void* local_player) const;

    hooks::Hook text_hook_;
    hooks::Hook number_hook_;
    void* text_original_ = nullptr;
    void* number_original_ = nullptr;
    std::atomic<bool> live_{false};

    std::uint32_t view_handler_at_ = 0;
    std::uint32_t gui_manager_at_ = 0;
    /// Written last with a release, read first with an acquire: a pass that
    /// sees this sees both offsets above it.
    std::atomic<bool> bound_{false};

    /// What the detours keep. Read by the pass, written by whichever thread the
    /// game draws on, so all of it is atomic.
    std::atomic<std::int32_t> any_kind_{kDefaultKind};
    /// The style seen on the player's own manager, and whether one has been.
    /// Preferred over `any_kind_`: a damage number over a monster is drawn in
    /// the style for damage over a monster.
    std::atomic<std::int32_t> own_kind_{0};
    std::atomic<bool> own_kind_seen_{false};
    std::atomic<void*> method_info_{nullptr};
    /// Published by the pass so a detour can tell the player's manager from
    /// everybody else's. Null until the first pass finds one.
    std::atomic<const void*> receiver_{nullptr};

    mutable std::mutex pending_lock_;
    std::array<char, kMaxLength> pending_{};
    std::uint32_t pending_rgba_ = 0;
    /// Set inside the lock and read outside it, which is the whole reason it is
    /// atomic: the flag says a message exists, and the lock is what makes
    /// reading the message itself safe.
    std::atomic<bool> has_pending_{false};

    /// Game thread only.
    void* primed_ = nullptr;
    std::atomic<std::uint32_t> shown_{0};
};

}  // namespace brownie::game
