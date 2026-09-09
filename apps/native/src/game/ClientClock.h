// Running the client's own clock faster than the wall.
//
// Unity measures every frame by asking `UnityEngine.Time` how much of a second
// has passed. Movement, animation, cooldowns, the client's own tick — all of it
// is that number multiplied by a rate. While this is on the number is handed
// back larger than it was, so the whole client runs fast without anything in it
// knowing that it does.
//
// **This is what a speed hack is, and writing a speed onto the player is not.**
// The first attempt at this feature held the player's tile-speed multiplier
// above one — the field the ground uses to slow a character down in water. It
// changes nothing: whatever the client derives that field into is derived again
// from the game's own numbers on the next tick, and the movement code is not
// the only thing that has to agree the player has moved. The reference
// implementation scaled the clock, and the clock is the only place where one
// number moves the whole client at once.
//
// **Deltas are scaled; absolute time is accumulated.** `deltaTime` and its two
// relatives answer "how long was that frame", and multiplying them is the whole
// trick. `realtimeSinceStartup` answers "what time is it", which cannot be
// multiplied — the product of a scale and a number that has been climbing since
// the process started is a jump of hours. So a clock of our own advances by the
// scaled step instead, and hands that out. It **only ever moves forward**, at
// or ahead of real time, so switching the feature off leaves the client's time
// where it is rather than snapping it backwards into timers it has already
// passed. The reference implementation snapped it back; monotonic is cheaper to
// reason about and costs nothing.
//
// **The three deltas are required and the two absolute readings are not.**
// Scaling the frame is the feature; carrying the absolute clock with it is
// consistency for whatever compares timestamps. A build that will not give up
// `realtimeSinceStartup` still gets a client that runs fast, so it is taken
// when it resolves and skipped when it does not.
//
// **What the reference had and this does not** is two detours against
// CodeStage's Anti-Cheat Toolkit: it rescaled that library's own "reliable"
// time after each update, and skipped its speed-hack detector while the scale
// was up. Neither is here, because nothing has yet shown that this build ships
// that library — its own resolver gave up looking after five seconds — and a
// detour written against a class nobody has seen is a guess with a hook on it.
// If the client's time turns out to be corrected under us, that is where to
// look.
//
// **Installed and enabled are separate**, for the reason `ProjectileNoclip.h`
// gives: a detour is a write into the game's code and stays once it is in,
// while what the operator wants changes with a click. With this off every
// detour hands back exactly what Unity answered.
//
// **The work on the ordinary path is one relaxed load.** These are asked
// several times a frame, and off they do nothing but jump through the
// trampoline and return.

#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <span>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::game {

/// The rate the client runs at when nobody has asked for anything else.
inline constexpr float kRealTime = 1.0F;

/// The fastest this will run it. Five times is a client whose frames are still
/// drawn between two real ones; the number is a ceiling on a slider rather than
/// a measurement, and the runtime's own maximum is the one an operator sees.
inline constexpr float kMaxClientSpeed = 5.0F;

/// Which of Unity's clock readings this stands in front of.
///
/// The order is the order `Install` is handed them in, and one detour is one C
/// function with an index baked into it — so this is a layout as much as a
/// list.
enum class ClockReading : std::size_t {
    /// The three that answer "how long was that frame", which are multiplied.
    kDeltaTime = 0,
    kFixedDeltaTime = 1,
    kUnscaledDeltaTime = 2,
    /// The two that answer "what time is it", which are accumulated.
    kRealtimeSinceStartup = 3,
    kRealtimeSinceStartupAsDouble = 4,
};

class ClientClock {
  public:
    /// How many readings there are, which is also how long the span `Install`
    /// takes must be.
    static constexpr std::size_t kReadings = 5;

    /// How many of them are required. The three deltas, and the file header
    /// says why the other two are not.
    static constexpr std::size_t kRequiredReadings = 3;

    ClientClock() noexcept = default;

    ClientClock(const ClientClock&) = delete;
    ClientClock& operator=(const ClientClock&) = delete;
    ClientClock(ClientClock&&) = delete;
    ClientClock& operator=(ClientClock&&) = delete;

    /// Removes every detour. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~ClientClock();

    /// Puts a detour on each reading that has an address. **IPC thread.**
    ///
    /// Only one of these may exist per process, for the reason `AimHook` gives:
    /// a detour is a C callback with nowhere to carry a `this`.
    ///
    /// @param readings One address per {@link ClockReading}, in that order.
    ///   Null means the build did not give that one up.
    /// @returns `kNotReady` while any of the first {@link kRequiredReadings} is
    ///   missing or refuses to hook, because scaling one delta and not the
    ///   others is a client whose parts disagree about how long a frame was.
    Status Install(std::span<void* const> readings);

    /// Removes them. Safe to call more than once, and from any thread.
    void Remove() noexcept;

    /// Whether the required detours are live and doing their work.
    [[nodiscard]] bool installed() const noexcept {
        return live_.load(std::memory_order_acquire);
    }

    /// How many detours went on, which is what the overlay's report shows.
    [[nodiscard]] std::size_t hooked() const noexcept { return hooked_; }

    /// Switches the feature on and off. Any thread, and cheap enough to call
    /// every frame — which is how the runtime's switch reaches it.
    void SetEnabled(bool on) noexcept { enabled_.store(on, std::memory_order_relaxed); }

    [[nodiscard]] bool enabled() const noexcept {
        return enabled_.load(std::memory_order_relaxed);
    }

    /// Sets how much faster than the wall the client runs. Clamped to
    /// `[kRealTime, kMaxClientSpeed]`; anything that is not a number at all
    /// leaves the last one that was. Any thread.
    void SetSpeed(float multiple) noexcept;

    /// What the detours are multiplying by right now. {@link kRealTime} while
    /// the feature is off, so one reading answers "is anything happening" as
    /// well as "by how much".
    [[nodiscard]] float scale() const noexcept {
        return enabled_.load(std::memory_order_relaxed)
                   ? speed_.load(std::memory_order_relaxed)
                   : kRealTime;
    }

    // --- Called only by the detours in ClientClock.cpp. Public because a free
    // --- function cannot be a friend of a class it does not know about.

    /// A frame length, multiplied. Counts the call when it changed anything.
    [[nodiscard]] float ScaleDelta(float raw) noexcept;

    /// Where our clock has got to, given what the real one now says. See the
    /// file header: this only ever moves forward.
    [[nodiscard]] double Advance(double real_seconds) noexcept;

    /// The code the detour at `index` replaced, to call through to. Null when
    /// there is no such detour, which is what a stray call is checked against.
    [[nodiscard]] void* original(std::size_t index) const noexcept;

  private:
    /// One detour, so that either failing says nothing about the other.
    Status InstallOne(std::size_t index, void* target);

    /// Takes every detour out and forgets what they read. Not `Remove`, which
    /// switches the feature off first.
    void Detach() noexcept;

    /// The longest step our clock will believe. A frame that claims to have
    /// taken longer than this is the process having been suspended — a debugger,
    /// a laptop lid — and multiplying it would put the client's time a minute
    /// into the future in one go.
    static constexpr double kLongestStepSeconds = 1.0;

    std::array<hooks::Hook, kReadings> hooks_{};
    std::array<void*, kReadings> originals_{};

    /// How many detours are in. Written by the IPC thread before any is enabled
    /// — which is what publishes it, because enabling a hook suspends every
    /// other thread.
    std::size_t hooked_ = 0;

    std::atomic<bool> live_{false};
    std::atomic<bool> enabled_{false};
    std::atomic<float> speed_{kRealTime};
    std::atomic<std::uint32_t> scaled_{0};

    /// Our own clock, and the last real reading it was advanced from.
    ///
    /// **Behind a lock rather than atomic**, because advancing it is a read,
    /// an add and a write that have to happen together — two threads asking the
    /// time at once would otherwise each add their own step to the value the
    /// other started from. Taken by the two absolute readings only, a few times
    /// a frame, and never while calling into the game: the original is asked
    /// first and the lock covers arithmetic and nothing else.
    mutable std::mutex clock_;
    double virtual_seconds_ = 0.0;
    double last_real_seconds_ = 0.0;
    bool started_ = false;
};

}  // namespace brownie::game
