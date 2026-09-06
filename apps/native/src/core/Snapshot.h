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
//
// **And the uncommon case never waits either.** A reader that finds something
// newer takes the lock *if it is free* and gives up if it is not, because the
// one thing the render thread must not do is block on a lock some other thread
// holds. Giving up costs a frame of staleness and nothing else: the value is
// still there, `seen` has not moved, and the next frame asks again.
//
// **That is a real trade rather than a free one, and it is the right way
// round.** The publisher holds the lock only for a copy, so a reader losing the
// race twice running is already unlikely and losing it forever is not a thing
// that happens; against that, a render thread stalled inside a frame is a
// visible hitch in somebody's game. Every reader here tolerates a stale frame
// by construction — the overlay redraws, and a movement target is republished
// fifty times a second.
//
// The publisher does wait, and should: it is the IPC thread, it is not inside
// anybody's frame, and a publish that gave up would be a value lost rather than
// a value late.

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

    /// Copies into `local` if `seen` is behind and the value is free to read.
    ///
    /// `seen` is the caller's, not ours: two readers at different rates each
    /// track their own position without either affecting the other.
    ///
    /// **False does not mean "nothing changed", it means "not this time".** The
    /// reader never waits — see the file note — so a publish in flight leaves
    /// the caller with what it already had, which is the previous value in full
    /// rather than half of the new one. `seen` moves only when the copy actually
    /// happened, so the next call tries again and nothing is skipped.
    ///
    /// Callers therefore have to be able to live with a stale frame. Every one
    /// of them can: a frame late is what this class exists to trade for a frame
    /// that never stalls.
    bool Refresh(T& local, std::uint64_t& seen) {
        if (version_.load(std::memory_order_acquire) == seen) {
            return false;
        }
        const std::unique_lock<std::mutex> guard{mutex_, std::try_to_lock};
        if (!guard.owns_lock()) {
            return false;
        }
        local = value_;
        // Read under the lock, so the version and the value are the same
        // publish. Taken after the copy rather than before it for the same
        // reason: a version taken first would be claimed by a copy that had not
        // been made yet if the two were ever reordered.
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
