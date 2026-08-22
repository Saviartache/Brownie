// Turns the pipe's byte stream into whole frames.
//
// A pipe read is not a message boundary: it can return half a header, six
// frames, or the tail of one and the head of the next. Framing is therefore its
// own object with its own checks, exactly as on the Node side — and for the
// same reason, since the two have to agree byte for byte.
//
// Bytes land in one buffer between a read and a write cursor. The cursors are
// advanced, never re-allocated; the dead prefix is reclaimed by a single move
// once it is large enough to be worth reclaiming.

#pragma once

#include <cstddef>
#include <vector>

#include "core/Result.h"
#include "ipc/Frame.h"

namespace brownie::ipc {

/// One complete frame.
///
/// `payload` points into the reader's buffer and is valid until the next call
/// to `Push` — which is the only thing that may move it. The caller consumes it
/// or copies it. Stated here rather than left to be discovered, because a
/// dangling payload is the one mistake this class can cause.
struct Frame {
    FrameHeader header;
    const std::byte* payload = nullptr;
    std::size_t payload_size = 0;
};

class FrameReader {
  public:
    /// Appends received bytes. Does not parse; call `Next` to drain.
    void Push(const std::byte* data, std::size_t size);

    /// The next complete frame.
    ///
    /// Returns `kNotReady` when more bytes are needed — the ordinary case, not
    /// an error — and `kProtocol` when the header is not one of ours, which is
    /// unrecoverable and must close the connection.
    Result<Frame> Next();

    void Reset() noexcept {
        start_ = 0;
        end_ = 0;
    }

    [[nodiscard]] std::size_t buffered() const noexcept { return end_ - start_; }

  private:
    void Compact() noexcept;

    std::vector<std::byte> buffer_;
    std::size_t start_ = 0;
    std::size_t end_ = 0;
};

}  // namespace brownie::ipc
