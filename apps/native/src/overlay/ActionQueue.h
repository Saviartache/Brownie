// Overlay interactions, handed from the thread that draws to the thread that
// may send them.
//
// The mirror image of `InputQueue.h`, and for the same reason: a frame is not a
// place to wait. Sending goes through the pipe and advances a sequence number
// that only the IPC thread may touch — two threads writing frames would
// interleave sequences and the runtime would hang up on the result. So a click
// is queued here and the IPC loop drains it on its next turn, which is within
// its poll timeout.
//
// The delay that costs is imperceptible for a settings change, and it is the
// price of having exactly one writer on the pipe.

#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace brownie::overlay {

class ActionQueue {
  public:
    /// Far above what interacting with a window can produce between two drains.
    /// Reaching it means the link is down, not that the user is fast.
    static constexpr std::size_t kCapacity = 64;

    /// Queues one action, dropping the *oldest* if the queue is full.
    ///
    /// Oldest rather than newest, because these are a person's intentions and
    /// the newest is the one they still hold. Nothing is lost that matters: a
    /// queue this full means the runtime is not reading, and a reconnecting
    /// runtime republishes everything anyway.
    void Push(std::string action) {
        const std::lock_guard<std::mutex> guard{mutex_};
        if (actions_.size() == kCapacity) {
            actions_.erase(actions_.begin());
            dropped_.fetch_add(1, std::memory_order_relaxed);
        }
        actions_.push_back(std::move(action));
    }

    /// Takes everything pending, oldest first. The lock is never held while the
    /// caller sends, which can block on the pipe.
    [[nodiscard]] std::vector<std::string> Drain() {
        const std::lock_guard<std::mutex> guard{mutex_};
        return std::exchange(actions_, {});
    }

    /// Actions lost to a full queue since this was last asked, and zeroed by
    /// asking.
    ///
    /// Counted atomically rather than under the queue's lock: every frame asks
    /// and almost every answer is zero, and the lock it would otherwise take is
    /// the one the IPC thread holds while it drains.
    [[nodiscard]] std::uint32_t TakeDropped() noexcept {
        return dropped_.exchange(0U, std::memory_order_relaxed);
    }

  private:
    std::mutex mutex_;
    std::vector<std::string> actions_;
    /// Outside the lock on purpose — see `TakeDropped`.
    std::atomic<std::uint32_t> dropped_{0};
};

}  // namespace brownie::overlay
