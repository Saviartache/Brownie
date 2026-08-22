// A value published by one thread and read by another.
//
// The overlay draws on the render thread; everything it shows is known on the
// IPC thread. The obvious answers are both wrong here: sharing the value under a
// lock the render thread takes every frame puts the game's frame rate at the
// mercy of whatever else holds it, and sharing it without one is a data race on
// a `std::string` and a `std::vector`.
//
// So the reader keeps its own copy and refreshes it only when there is something
// newer. The common case — nothing changed since the last frame — is one atomic
// load and no lock at all.

#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <utility>

namespace brownie {

template <typename T>
class Snapshot {
  public:
    /// Replaces the published value. Callable from any thread.
    void Publish(T value) {
        const std::lock_guard<std::mutex> guard{mutex_};
        value_ = std::move(value);
        // Released after the value is in place, so a reader that sees the new
        // version sees the value that goes with it.
        version_.fetch_add(1, std::memory_order_release);
    }

    /// Copies into `local` if `seen` is behind. Returns whether it changed.
    ///
    /// `seen` is the caller's, not ours: two readers at different rates each
    /// track their own position without either affecting the other.
    bool Refresh(T& local, std::uint64_t& seen) {
        if (version_.load(std::memory_order_acquire) == seen) {
            return false;
        }
        const std::lock_guard<std::mutex> guard{mutex_};
        local = value_;
        seen = version_.load(std::memory_order_relaxed);
        return true;
    }

    /// Whether anything has ever been published.
    [[nodiscard]] bool published() const noexcept {
        return version_.load(std::memory_order_acquire) != 0;
    }

  private:
    mutable std::mutex mutex_;
    T value_{};
    std::atomic<std::uint64_t> version_{0};
};

}  // namespace brownie
