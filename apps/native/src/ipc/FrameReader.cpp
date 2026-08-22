#include "ipc/FrameReader.h"

#include <algorithm>
#include <cstring>

namespace brownie::ipc {
namespace {

}  // namespace

void FrameReader::Push(const std::byte* data, std::size_t size) {
    if (data == nullptr || size == 0) {
        return;
    }
    if (end_ + size > buffer_.size()) {
        // Compacting first often makes room without growing at all, which
        // matters here: this runs for the life of the process and a buffer that
        // only ever grows is a leak with a slow fuse.
        Compact();
        if (end_ + size > buffer_.size()) {
            buffer_.resize(std::max(buffer_.size() * 2, end_ + size));
        }
    }
    std::memcpy(buffer_.data() + end_, data, size);
    end_ += size;
}

Result<Frame> FrameReader::Next() {
    const std::size_t available = end_ - start_;
    if (available < kHeaderBytes) {
        return Error{ErrorCode::kNotReady, "waiting for a frame header"};
    }

    auto header = ReadHeader(buffer_.data() + start_, available);
    if (!header.ok()) {
        return header.error();
    }

    const std::size_t total = kHeaderBytes + header.value().length;
    if (available < total) {
        return Error{ErrorCode::kNotReady, "waiting for the rest of a frame"};
    }

    Frame frame{};
    frame.header = header.value();
    frame.payload = buffer_.data() + start_ + kHeaderBytes;
    frame.payload_size = header.value().length;
    start_ += total;

    // Nothing here may move the buffer: `frame.payload` points into it, and
    // compacting after computing that pointer would hand the caller a
    // dangling one. Reclaiming the dead prefix happens in `Push`, which is
    // before any payload has been handed out.
    if (start_ == end_) {
        start_ = 0;
        end_ = 0;
    }
    return frame;
}

void FrameReader::Compact() noexcept {
    if (start_ == 0) {
        return;
    }
    const std::size_t live = end_ - start_;
    if (live > 0) {
        std::memmove(buffer_.data(), buffer_.data() + start_, live);
    }
    start_ = 0;
    end_ = live;
}

}  // namespace brownie::ipc
