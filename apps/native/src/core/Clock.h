// The module's own clock.
//
// **`GetTickCount64` is not one, and the walk is what proved it.** Its
// resolution is the system timer interrupt — 15.6 ms unless somebody in the
// process has asked for better — so on a frame shorter than that, two
// consecutive reads return the same number. A step is a distance over a time,
// and a time of nought is no step: at a hundred and forty frames a second the
// character stood still for two frames out of three and then lurched, which is
// not what a walking speed of eight tiles a second is meant to look like.
//
// `steady_clock` is a performance counter on Windows, so consecutive frames get
// consecutive milliseconds and the step is the distance actually owed.
//
// **Milliseconds since an arbitrary moment**, exactly as the tick count was, so
// every deadline and every cadence built on it means the same thing. Monotonic
// and consistent across threads, which matters because a target is stamped on
// the IPC thread and read on the game's.

#pragma once

#include <chrono>
#include <cstdint>

namespace brownie {

/// Milliseconds on a monotonic clock. Only differences are meaningful.
[[nodiscard]] inline std::uint64_t NowMs() noexcept {
    const auto since = std::chrono::steady_clock::now().time_since_epoch();
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(since).count());
}

}  // namespace brownie
