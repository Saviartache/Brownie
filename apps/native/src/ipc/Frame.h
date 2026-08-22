// The IPC frame header.
//
// This is the C++ half of `docs/ipc.md`. That document, not either
// implementation, is the specification: when the two disagree, the document
// decides. Every field width, order and rule below is stated there.
//
//   0   u32  magic      'BRWN'
//   4   u16  version
//   6   u16  type
//   8   u16  flags      bit 0 = binary payload, otherwise UTF-8 JSON
//  10   u16  reserved   must be zero
//  12   u32  seq        monotonic per direction, starts at 1
//  16   u32  length     payload byte count
//
// Little-endian throughout, which on x86-64 means the bytes are already in the
// right order and this is a copy rather than a conversion.

#pragma once

#include <cstddef>
#include <cstdint>

#include "core/Result.h"

namespace brownie::ipc {

/// `BRWN` read as a little-endian u32.
inline constexpr std::uint32_t kMagic = 0x4E57'5242u;

inline constexpr std::uint16_t kVersion = 1;

inline constexpr std::size_t kHeaderBytes = 20;

/// Payload cap. Overlay sprite chunks are the largest legitimate payload.
inline constexpr std::uint32_t kMaxPayloadBytes = 256u * 1024u;

enum class FrameFlags : std::uint16_t {
    kNone = 0,
    /// Payload is opaque bytes rather than UTF-8 JSON.
    kBinary = 1u << 0,
};

/// Message types. The numbering is grouped so a raw code is readable in a log:
/// `0x00xx` handshake, `0x01xx` liveness, `0x02xx` control, `0x03xx` events,
/// `0x04xx` telemetry.
enum class MessageType : std::uint16_t {
    kHello = 0x0001,
    kAuthChallenge = 0x0002,
    kAuthResult = 0x0003,

    kPing = 0x0100,
    kPong = 0x0101,

    kSetFeature = 0x0200,
    kControlRecord = 0x0201,
    kControlAction = 0x0202,

    kHotkeyEvent = 0x0300,
    kOffsetHealth = 0x0301,
    kServerTarget = 0x0302,

    kPlayerTelemetry = 0x0400,
};

struct FrameHeader {
    std::uint16_t version = kVersion;
    std::uint16_t type = 0;
    std::uint16_t flags = 0;
    std::uint32_t seq = 0;
    std::uint32_t length = 0;
};

/// Writes a header into at least `kHeaderBytes` of storage.
Status WriteHeader(std::byte* target, std::size_t capacity, const FrameHeader& header) noexcept;

/// Reads and validates a header.
///
/// Every rejection here means the same thing — close the connection — because
/// none of them is recoverable: a bad magic says the peer is not ours, an
/// unknown version says we cannot parse what follows, a non-zero reserved field
/// says a newer build is speaking, and an oversized length says the stream is
/// no longer aligned.
Result<FrameHeader> ReadHeader(const std::byte* source, std::size_t size) noexcept;

/// Sequence numbers start at 1 and wrap back to 1, never to 0 — so "no frames
/// yet" stays distinguishable from "the counter came round".
[[nodiscard]] constexpr std::uint32_t NextSeq(std::uint32_t previous) noexcept {
    return previous >= 0xFFFF'FFFFu ? 1u : previous + 1u;
}

/// Detects a dropped or replayed frame.
///
/// This is what replaced the reference implementation's per-message HMAC. On a
/// point-to-point pipe that has already completed a mutual challenge, no third
/// party can insert a frame; what the MAC actually detected was loss and
/// reordering, and a counter does that for nothing. See `docs/ipc.md`.
class SequenceGuard {
  public:
    /// Fails on a gap or a replay.
    Status Accept(std::uint32_t seq) noexcept;
    void Reset() noexcept { last_ = 0; }

  private:
    std::uint32_t last_ = 0;
};

/// Hands out the next sequence number for one direction.
class SequenceSource {
  public:
    [[nodiscard]] std::uint32_t Take() noexcept { return last_ = NextSeq(last_); }
    void Reset() noexcept { last_ = 0; }

  private:
    std::uint32_t last_ = 0;
};

}  // namespace brownie::ipc
