// Window messages, handed from the thread that receives them to the thread that
// may act on them.
//
// **ImGui has no thread safety and this is where that is dealt with.** A window
// procedure runs on whichever thread owns the window; `Present` runs on
// whichever thread draws. In Unity those are the same thread only when
// multithreaded rendering is off, and "usually the same" is not a threading
// model. Feeding ImGui from the window procedure while the render thread is
// inside `NewFrame` is a data race on the whole input state — the kind that
// shows up as a corrupted `ImGuiIO` days later.
//
// So the rule is: **only the render thread touches ImGui.** The window procedure
// copies each message here and returns; the render thread drains them just
// before it builds a frame. Input is delivered one frame late, which nobody can
// perceive, and there is exactly one thread inside ImGui at any moment.
//
// The decision the window procedure *does* have to make synchronously — whether
// to swallow a message — is read from atomics the render thread publishes. That
// answer is one frame stale, which at worst passes one click to the game on the
// frame a window opens under the cursor.

#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>

#include <Windows.h>

namespace brownie::overlay {

struct InputMessage {
    UINT message = 0;
    WPARAM wparam = 0;
    LPARAM lparam = 0;
};

/// A bounded queue of pending messages.
///
/// Bounded because it is filled by an external source: a window flooded with
/// mouse moves while the render thread is stalled must not be able to grow this
/// without limit inside someone else's process. The cap is far above what a
/// frame's worth of input needs, and overflow is counted rather than hidden —
/// dropped input that nobody can see is a bug report nobody can act on.
class InputQueue {
  public:
    /// One frame of input at 60 Hz is a few dozen messages even while dragging.
    static constexpr std::size_t kCapacity = 512;

    /// Returns false when the queue was full and the message was dropped.
    bool Push(const InputMessage& message) noexcept {
        const std::lock_guard<std::mutex> guard{mutex_};
        if (count_ == kCapacity) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        messages_[(head_ + count_) % kCapacity] = message;
        ++count_;
        return true;
    }

    /// Moves everything pending into `out`, oldest first, and returns how many.
    ///
    /// A drain rather than a per-message pop: the lock is taken once per frame
    /// instead of once per message, and the render thread never holds it while
    /// it is inside ImGui.
    std::size_t Drain(std::array<InputMessage, kCapacity>& out) noexcept {
        const std::lock_guard<std::mutex> guard{mutex_};
        for (std::size_t i = 0; i < count_; ++i) {
            out[i] = messages_[(head_ + i) % kCapacity];
        }
        const std::size_t drained = count_;
        head_ = 0;
        count_ = 0;
        return drained;
    }

    /// Messages lost to a full queue since the last time this was asked, and
    /// zeroed by asking. Reported upward rather than logged from here: this
    /// runs on both threads and must not do anything that can block.
    ///
    /// Counted atomically rather than under the queue's lock, because every
    /// frame asks and almost every answer is zero — taking the lock the window
    /// procedure fills the queue through would put a frame behind a flood of
    /// mouse moves to be told nothing was lost.
    std::uint32_t TakeDropped() noexcept {
        return dropped_.exchange(0U, std::memory_order_relaxed);
    }

    [[nodiscard]] std::size_t size() noexcept {
        const std::lock_guard<std::mutex> guard{mutex_};
        return count_;
    }

  private:
    std::mutex mutex_;
    std::array<InputMessage, kCapacity> messages_{};
    std::size_t head_ = 0;
    std::size_t count_ = 0;
    /// Outside the lock on purpose — see `TakeDropped`.
    std::atomic<std::uint32_t> dropped_{0};
};

}  // namespace brownie::overlay
