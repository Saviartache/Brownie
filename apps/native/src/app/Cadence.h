// Something a loop does again every so often, rather than every time round.
//
// Two loops need this and neither owns it: the IPC thread's, where waking is a
// rate the peer chooses — a burst of overlay records used to mean a burst of
// memory reads and model rebuilds with it — and the game's frame, where waking
// is sixty times a second and almost nothing wants to happen that often.
//
// Each job carries its own interval instead, so the work costs the same
// whatever the thing driving the loop happens to be doing.

#pragma once

#include <cstdint>

namespace brownie::app {

class Cadence {
  public:
    explicit constexpr Cadence(std::uint32_t interval_ms) noexcept
        : interval_ms_{interval_ms} {}

    /// Whether the job is due, and if so books the next turn.
    [[nodiscard]] bool Due(std::uint64_t now_ms) noexcept {
        if (now_ms < next_at_ms_) {
            return false;
        }
        next_at_ms_ = now_ms + interval_ms_;
        return true;
    }

    /// Makes the job due at the next check, whatever its interval says.
    ///
    /// For work that is ordinarily polled for but that something can *ask* for:
    /// waiting out the rest of an interval to answer a request that has already
    /// arrived is latency with nothing behind it.
    void Trigger() noexcept { next_at_ms_ = 0; }

    /// How long until it is due again. Zero when it already is.
    [[nodiscard]] std::uint64_t Remaining(std::uint64_t now_ms) const noexcept {
        return next_at_ms_ <= now_ms ? 0 : next_at_ms_ - now_ms;
    }

  private:
    std::uint64_t next_at_ms_ = 0;
    std::uint32_t interval_ms_;
};

}  // namespace brownie::app
