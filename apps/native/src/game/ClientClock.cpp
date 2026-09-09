#include "game/ClientClock.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace brownie::game {
namespace {

/// Unity's clock readings, as the compiler generated them.
///
/// All five are static properties, so IL2CPP's trailing `MethodInfo*` is the
/// only argument any of them takes. A detour forwards whatever it was handed.
using DeltaFn = float (*)(void* method_info);
using RealtimeFn = float (*)(void* method_info);
using RealtimeDoubleFn = double (*)(void* method_info);

/// The one client clock in this process. See `AimHook.cpp` for why a detour has
/// nowhere else to keep this.
ClientClock* g_clock = nullptr;

/// The frame length one reading answers with, scaled.
///
/// Three of these rather than one templated on the index, because three is the
/// whole list and a table of one-line functions is easier to read than the
/// machinery that would generate it.
template <ClockReading Reading>
float DeltaDetour(void* method_info) {
    ClientClock* clock = g_clock;
    if (clock == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls — but the check costs a comparison and the
        // alternative is a jump through a null trampoline. Zero is the honest
        // answer for "how long was that frame" when there is nobody to ask: a
        // frame of no length moves nothing.
        return 0.0F;
    }
    void* const original = clock->original(static_cast<std::size_t>(Reading));
    if (original == nullptr) {
        return 0.0F;
    }
    return clock->ScaleDelta(reinterpret_cast<DeltaFn>(original)(method_info));
}

float RealtimeDetour(void* method_info) {
    constexpr auto kIndex = static_cast<std::size_t>(ClockReading::kRealtimeSinceStartup);
    ClientClock* clock = g_clock;
    if (clock == nullptr) {
        return 0.0F;
    }
    void* const original = clock->original(kIndex);
    if (original == nullptr) {
        return 0.0F;
    }
    // The game's own first and outside the clock's lock, so nothing holds it
    // while a call into managed code is outstanding.
    const float real = reinterpret_cast<RealtimeFn>(original)(method_info);
    return static_cast<float>(clock->Advance(static_cast<double>(real)));
}

double RealtimeDoubleDetour(void* method_info) {
    constexpr auto kIndex = static_cast<std::size_t>(ClockReading::kRealtimeSinceStartupAsDouble);
    ClientClock* clock = g_clock;
    if (clock == nullptr) {
        return 0.0;
    }
    void* const original = clock->original(kIndex);
    if (original == nullptr) {
        return 0.0;
    }
    const double real = reinterpret_cast<RealtimeDoubleFn>(original)(method_info);
    return clock->Advance(real);
}

/// The detours, in the order `ClockReading` numbers them. A table rather than a
/// switch: the address of each is what MinHook is given.
const std::array<void*, ClientClock::kReadings> kDetours{
    reinterpret_cast<void*>(&DeltaDetour<ClockReading::kDeltaTime>),
    reinterpret_cast<void*>(&DeltaDetour<ClockReading::kFixedDeltaTime>),
    reinterpret_cast<void*>(&DeltaDetour<ClockReading::kUnscaledDeltaTime>),
    reinterpret_cast<void*>(&RealtimeDetour),
    reinterpret_cast<void*>(&RealtimeDoubleDetour),
};

}  // namespace

ClientClock::~ClientClock() {
    Remove();
}

Status ClientClock::InstallOne(std::size_t index, void* target) {
    if (target == nullptr) {
        return Error{ErrorCode::kNotReady, "that clock reading has not been resolved yet"};
    }

    auto created = hooks::Hook::Create(target, kDetours[index]);
    if (!created.ok()) {
        return created.error();
    }
    hooks_[index] = std::move(created).value();

    // The trampoline and the owner are published before the detour is enabled,
    // because Unity can ask the instant it is — and a detour whose original is
    // still null answers zero to a question the whole client is measured by.
    originals_[index] = hooks_[index].original<void*>();
    g_clock = this;

    if (auto enabled = hooks_[index].Enable(); !enabled.ok()) {
        hooks_[index] = hooks::Hook{};
        originals_[index] = nullptr;
        return enabled.error();
    }
    return {};
}

Status ClientClock::Install(std::span<void* const> readings) {
    if (installed()) {
        // Already in. Asking again is the loop retrying, not a second set.
        return {};
    }
    if (g_clock != nullptr && g_clock != this) {
        return Error{ErrorCode::kInvalidArgument, "another client clock is already installed"};
    }
    if (readings.size() != kReadings) {
        return Error{ErrorCode::kInvalidArgument, "the clock takes one address per reading"};
    }

    // The three that have to work first. Either of the other two failing leaves
    // a client that runs fast and keeps real time, which is worth having; one
    // of these failing leaves a client whose parts disagree about how long a
    // frame was, which is not.
    for (std::size_t index = 0; index < kRequiredReadings; ++index) {
        if (!InstallOne(index, readings[index]).ok()) {
            Detach();
            return Error{ErrorCode::kNotReady, "a frame-length reading could not be detoured"};
        }
    }
    std::size_t installed_count = kRequiredReadings;
    for (std::size_t index = kRequiredReadings; index < kReadings; ++index) {
        if (InstallOne(index, readings[index]).ok()) {
            ++installed_count;
        }
    }

    hooked_ = installed_count;
    // Last, and it is what everything above is read against — every slot is
    // written before this is.
    live_.store(true, std::memory_order_release);
    return {};
}

void ClientClock::Remove() noexcept {
    // Switched off first: a call already inside a detour must find a feature
    // that wants nothing rather than an object being taken apart.
    SetEnabled(false);
    Detach();
}

void ClientClock::Detach() noexcept {
    live_.store(false, std::memory_order_release);

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it is replacing, so once these return no further
    // detour can begin and what they read can be cleared.
    for (std::size_t index = 0; index < kReadings; ++index) {
        hooks_[index] = hooks::Hook{};
        originals_[index] = nullptr;
    }
    hooked_ = 0;
    if (g_clock == this) {
        g_clock = nullptr;
    }

    // The clock starts again from whatever the game says next time, rather than
    // from a reading taken before a set of detours went out.
    const std::lock_guard<std::mutex> lock{clock_};
    started_ = false;
}

void ClientClock::SetSpeed(float multiple) noexcept {
    if (!std::isfinite(multiple)) {
        // Neither clamped nor stored: a frame length multiplied by a NaN is a
        // client that stops moving, and the last number the operator chose is a
        // better answer than one nobody did.
        return;
    }
    speed_.store(std::clamp(multiple, kRealTime, kMaxClientSpeed), std::memory_order_relaxed);
}

float ClientClock::ScaleDelta(float raw) noexcept {
    const float multiple = scale();
    if (multiple <= kRealTime) {
        return raw;
    }
    scaled_.fetch_add(1, std::memory_order_relaxed);
    return raw * multiple;
}

double ClientClock::Advance(double real_seconds) noexcept {
    const double multiple = static_cast<double>(scale());

    const std::lock_guard<std::mutex> lock{clock_};
    if (!started_) {
        started_ = true;
        virtual_seconds_ = real_seconds;
        last_real_seconds_ = real_seconds;
        return virtual_seconds_;
    }

    double step = real_seconds - last_real_seconds_;
    if (!std::isfinite(step) || step < 0.0 || step > kLongestStepSeconds) {
        // A step nobody can have taken: the process was suspended, or the game
        // handed back something that is not a time. Our clock stands still for
        // it rather than leaping, and picks up from the new reading.
        step = 0.0;
    }
    last_real_seconds_ = real_seconds;
    virtual_seconds_ += step * multiple;
    return virtual_seconds_;
}

void* ClientClock::original(std::size_t index) const noexcept {
    return index < kReadings ? originals_[index] : nullptr;
}

}  // namespace brownie::game
