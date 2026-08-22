// Mutual authentication, once per connection.
//
// The C++ half of the handshake in `docs/ipc.md`. That document is the
// specification — the Node side implements it independently, and when the two
// disagree the document decides, not whichever was written first.
//
//   native  → runtime   hello         { pid, challenge }
//   runtime → native    authChallenge { userId, pid, response, challenge }
//   native  → runtime   authResult    { ok, response }
//
// Both `response` values are HMAC-SHA256 over the fields joined with a literal
// `|`: the peer's challenge, the normalised user id, and the *sender's* decimal
// process id. The separator makes the signed string unambiguous — no
// combination of values can collide with a different combination — and the pid
// binds the exchange to a process, so a captured transcript cannot authenticate
// a different one.
//
// After this exchange the connection is trusted for its lifetime. The reference
// implementation instead signed every message with a derived session key, at a
// hash per frame including per-frame telemetry; `docs/ipc.md` records why that
// defended against nobody reachable and what replaced it.

#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

#include "core/Result.h"

namespace brownie::ipc {

inline constexpr std::size_t kNonceBytes = 32;
/// A nonce or MAC as lower-case hex, plus the terminator callers expect.
inline constexpr std::size_t kHexLength = kNonceBytes * 2;

using Secret = std::array<std::uint8_t, kNonceBytes>;

/// Cryptographically random bytes. Fails rather than falling back to anything
/// weaker: a predictable challenge is the same as no challenge at all.
Result<Secret> RandomBytes();

/// A fresh challenge, as lower-case hex.
Result<std::string> CreateNonce();

/// Whether a string is exactly a 32-byte lower-case hex value.
[[nodiscard]] bool IsNonce(std::string_view value) noexcept;

/// HMAC-SHA256 over the fields joined with `|`, returned as lower-case hex.
Result<std::string> Sign(const Secret& secret, std::initializer_list<std::string_view> fields);

/// Compares two hex MACs without leaking where they first differ.
///
/// A malformed input compares false rather than throwing: a peer must not be
/// able to tell "wrong shape" from "wrong value" by which answer it gets.
[[nodiscard]] bool MacEquals(std::string_view a, std::string_view b) noexcept;

/// Normalises the identity that gets signed.
///
/// Both sides sign this string, so both must derive it identically from the
/// same input: trim, empty becomes the literal `anonymous` — "no user" is a
/// real state and must not be indistinguishable from a missing field — anything
/// outside `[A-Za-z0-9._-]` becomes `_`, and the result is capped at 96
/// characters.
[[nodiscard]] std::string NormaliseUserId(std::string_view raw);

/// The native side of the exchange.
///
/// Holds only what the protocol needs it to hold, and forgets the challenge the
/// moment it has been answered — a nonce kept past its use is a nonce that can
/// be reused.
class NativeHandshake {
  public:
    explicit NativeHandshake(const Secret& secret, std::uint32_t pid) noexcept
        : secret_{secret}, pid_{pid} {}

    /// The challenge to greet the runtime with. Called once.
    Result<std::string> Begin();

    /// Verifies the runtime's answer and produces ours.
    ///
    /// Fails when the runtime cannot sign correctly, when the exchange is out of
    /// order, or when either field is malformed — all of which mean the same
    /// thing: this is not the peer we are here to talk to.
    Result<std::string> Finish(std::string_view runtime_response,
                               std::string_view runtime_challenge, std::string_view user_id,
                               std::uint32_t runtime_pid);

    [[nodiscard]] bool complete() const noexcept { return complete_; }

    /// Answers a liveness challenge: `HMAC(secret, nonce)`.
    Result<std::string> AnswerPing(std::string_view nonce) const;

  private:
    Secret secret_{};
    std::uint32_t pid_ = 0;
    std::string challenge_;
    bool complete_ = false;
};

}  // namespace brownie::ipc
