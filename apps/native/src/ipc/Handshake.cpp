#include "ipc/Handshake.h"

#include <algorithm>
#include <cstring>

#include <Windows.h>
#include <bcrypt.h>

namespace brownie::ipc {
namespace {

/// A BCrypt algorithm handle that closes itself.
class AlgorithmHandle {
  public:
    AlgorithmHandle() = default;
    AlgorithmHandle(const AlgorithmHandle&) = delete;
    AlgorithmHandle& operator=(const AlgorithmHandle&) = delete;
    ~AlgorithmHandle() {
        if (handle_ != nullptr) {
            ::BCryptCloseAlgorithmProvider(handle_, 0);
        }
    }

    BCRYPT_ALG_HANDLE* address() noexcept { return &handle_; }
    [[nodiscard]] BCRYPT_ALG_HANDLE get() const noexcept { return handle_; }

  private:
    BCRYPT_ALG_HANDLE handle_ = nullptr;
};

/// Closes a BCrypt hash on every path out of the function that made it.
class HashCloser {
  public:
    explicit HashCloser(BCRYPT_HASH_HANDLE handle) noexcept : handle_{handle} {}
    HashCloser(const HashCloser&) = delete;
    HashCloser& operator=(const HashCloser&) = delete;
    ~HashCloser() {
        if (handle_ != nullptr) ::BCryptDestroyHash(handle_);
    }

  private:
    BCRYPT_HASH_HANDLE handle_ = nullptr;
};

constexpr char kHexDigits[] = "0123456789abcdef";

std::string ToHex(const std::uint8_t* data, std::size_t size) {
    std::string hex;
    hex.resize(size * 2);
    for (std::size_t i = 0; i < size; ++i) {
        hex[i * 2] = kHexDigits[(data[i] >> 4) & 0x0F];
        hex[i * 2 + 1] = kHexDigits[data[i] & 0x0F];
    }
    return hex;
}

}  // namespace

Result<Secret> RandomBytes() {
    Secret bytes{};
    const NTSTATUS status =
        ::BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                          BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if (status < 0) {
        // No fallback: a predictable challenge is the same as no challenge, so
        // failing to get randomness has to fail the handshake.
        return Error{ErrorCode::kIo, "the system refused to provide random bytes"};
    }
    return bytes;
}

Result<std::string> CreateNonce() {
    auto bytes = RandomBytes();
    if (!bytes.ok()) return bytes.error();
    return ToHex(bytes.value().data(), bytes.value().size());
}

bool IsNonce(std::string_view value) noexcept {
    if (value.size() != kHexLength) return false;
    return std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

Result<std::string> Sign(const Secret& secret, std::initializer_list<std::string_view> fields) {
    // Joined with a literal '|' so the signed string is unambiguous: without a
    // separator, ("ab","c") and ("a","bc") would sign identically.
    std::string message;
    for (const auto& field : fields) {
        if (!message.empty()) message.push_back('|');
        message.append(field);
    }

    AlgorithmHandle algorithm;
    if (::BCryptOpenAlgorithmProvider(algorithm.address(), BCRYPT_SHA256_ALGORITHM, nullptr,
                                      BCRYPT_ALG_HANDLE_HMAC_FLAG) < 0) {
        return Error{ErrorCode::kIo, "could not open the HMAC provider"};
    }

    // The classic four-call sequence rather than the one-shot `BCryptHash`:
    // that one is not in the mingw headers this toolchain ships, and reaching
    // past them would tie the build to a particular SDK for no gain.
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (::BCryptCreateHash(algorithm.get(), &hash, nullptr, 0, const_cast<PUCHAR>(secret.data()),
                           static_cast<ULONG>(secret.size()), 0) < 0) {
        return Error{ErrorCode::kIo, "could not create the HMAC"};
    }
    // Closed on every path out of here, including the failures below.
    const HashCloser closer{hash};

    std::array<std::uint8_t, 32> digest{};
    if (::BCryptHashData(hash, reinterpret_cast<PUCHAR>(message.data()),
                         static_cast<ULONG>(message.size()), 0) < 0) {
        return Error{ErrorCode::kIo, "the HMAC failed"};
    }
    if (::BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
        return Error{ErrorCode::kIo, "the HMAC did not finish"};
    }
    return ToHex(digest.data(), digest.size());
}

bool MacEquals(std::string_view a, std::string_view b) noexcept {
    // Constant time over the whole length, and only after both are known to be
    // well formed — an early return on a length mismatch would be a timing
    // signal of its own.
    if (!IsNonce(a) || !IsNonce(b)) return false;
    unsigned char difference = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        difference |= static_cast<unsigned char>(a[i] ^ b[i]);
    }
    return difference == 0;
}

std::string NormaliseUserId(std::string_view raw) {
    const auto first = raw.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) return "anonymous";
    const auto last = raw.find_last_not_of(" \t\r\n");

    std::string safe;
    safe.reserve(last - first + 1);
    for (std::size_t i = first; i <= last; ++i) {
        const char c = raw[i];
        const bool allowed = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                             (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
        safe.push_back(allowed ? c : '_');
    }
    if (safe.size() > 96) safe.resize(96);
    return safe.empty() ? "anonymous" : safe;
}

Result<std::string> NativeHandshake::Begin() {
    if (complete_) return Error{ErrorCode::kProtocol, "the handshake already completed"};
    auto nonce = CreateNonce();
    if (!nonce.ok()) return nonce.error();
    challenge_ = nonce.value();
    return challenge_;
}

Result<std::string> NativeHandshake::Finish(std::string_view runtime_response,
                                            std::string_view runtime_challenge,
                                            std::string_view user_id, std::uint32_t runtime_pid) {
    if (complete_) return Error{ErrorCode::kProtocol, "the handshake already completed"};
    if (challenge_.empty()) return Error{ErrorCode::kProtocol, "no challenge was sent"};
    if (!IsNonce(runtime_challenge)) {
        return Error{ErrorCode::kProtocol, "the runtime sent a malformed challenge"};
    }

    const std::string normalised = NormaliseUserId(user_id);
    const std::string runtime_pid_text = std::to_string(runtime_pid);

    auto expected = Sign(secret_, {challenge_, normalised, runtime_pid_text});
    if (!expected.ok()) return expected.error();
    if (!MacEquals(runtime_response, expected.value())) {
        // Deliberately unspecific: a peer that cannot sign correctly learns
        // nothing further from us.
        return Error{ErrorCode::kProtocol, "the runtime failed to prove it holds the shared secret"};
    }

    auto response = Sign(secret_, {runtime_challenge, normalised, std::to_string(pid_)});
    if (!response.ok()) return response.error();

    // The challenge has been answered; keeping it would be keeping a nonce past
    // its one use.
    challenge_.clear();
    complete_ = true;
    return response.value();
}

Result<std::string> NativeHandshake::AnswerPing(std::string_view nonce) const {
    if (!IsNonce(nonce)) return Error{ErrorCode::kProtocol, "the ping carries a malformed nonce"};
    return Sign(secret_, {nonce});
}

}  // namespace brownie::ipc
