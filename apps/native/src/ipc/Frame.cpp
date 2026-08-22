#include "ipc/Frame.h"

#include <cstring>

namespace brownie::ipc {
namespace {

/// Little-endian reads and writes, spelled out.
///
/// `std::memcpy` of a `std::uint32_t` would be correct on every platform this
/// module runs on and wrong the day it is read on a big-endian one. Byte-at-a
/// time compiles to the same single instruction on x86-64 and cannot be wrong.
void WriteU16(std::byte* target, std::uint16_t value) noexcept {
    target[0] = static_cast<std::byte>(value & 0xFFu);
    target[1] = static_cast<std::byte>((value >> 8) & 0xFFu);
}

void WriteU32(std::byte* target, std::uint32_t value) noexcept {
    target[0] = static_cast<std::byte>(value & 0xFFu);
    target[1] = static_cast<std::byte>((value >> 8) & 0xFFu);
    target[2] = static_cast<std::byte>((value >> 16) & 0xFFu);
    target[3] = static_cast<std::byte>((value >> 24) & 0xFFu);
}

[[nodiscard]] std::uint16_t ReadU16(const std::byte* source) noexcept {
    return static_cast<std::uint16_t>(static_cast<std::uint16_t>(source[0]) |
                                      (static_cast<std::uint16_t>(source[1]) << 8));
}

[[nodiscard]] std::uint32_t ReadU32(const std::byte* source) noexcept {
    return static_cast<std::uint32_t>(source[0]) | (static_cast<std::uint32_t>(source[1]) << 8) |
           (static_cast<std::uint32_t>(source[2]) << 16) |
           (static_cast<std::uint32_t>(source[3]) << 24);
}

}  // namespace

Status WriteHeader(std::byte* target, std::size_t capacity, const FrameHeader& header) noexcept {
    if (target == nullptr || capacity < kHeaderBytes) {
        return Error{ErrorCode::kInvalidArgument, "frame header does not fit"};
    }
    WriteU32(target + 0, kMagic);
    WriteU16(target + 4, header.version);
    WriteU16(target + 6, header.type);
    WriteU16(target + 8, header.flags);
    WriteU16(target + 10, 0);
    WriteU32(target + 12, header.seq);
    WriteU32(target + 16, header.length);
    return {};
}

Result<FrameHeader> ReadHeader(const std::byte* source, std::size_t size) noexcept {
    if (source == nullptr || size < kHeaderBytes) {
        return Error{ErrorCode::kNotReady, "not enough bytes for a frame header"};
    }
    if (ReadU32(source) != kMagic) {
        return Error{ErrorCode::kProtocol, "bad frame magic — the peer is not speaking this protocol"};
    }

    FrameHeader header{};
    header.version = ReadU16(source + 4);
    if (header.version != kVersion) {
        return Error{ErrorCode::kProtocol, "peer speaks a different IPC version"};
    }
    // Checked rather than ignored: it is the only way a future version can add
    // a header field and know that older builds refused the frame instead of
    // silently misreading it.
    if (ReadU16(source + 10) != 0) {
        return Error{ErrorCode::kProtocol, "reserved header field is not zero"};
    }

    header.type = ReadU16(source + 6);
    header.flags = ReadU16(source + 8);
    header.seq = ReadU32(source + 12);
    header.length = ReadU32(source + 16);
    if (header.length > kMaxPayloadBytes) {
        return Error{ErrorCode::kProtocol, "payload exceeds the frame cap"};
    }
    return header;
}

Status SequenceGuard::Accept(std::uint32_t seq) noexcept {
    const std::uint32_t expected = NextSeq(last_);
    if (seq != expected) {
        return Error{ErrorCode::kProtocol, "sequence gap — frames were lost or replayed"};
    }
    last_ = seq;
    return {};
}

}  // namespace brownie::ipc
