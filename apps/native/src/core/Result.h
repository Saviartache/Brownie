// One way to report failure, for the whole module.
//
// The reference implementation used every mechanism at once: `bool`, `nullptr`,
// `-1`, an out-parameter, a logged message and silence, sometimes three of them
// in one call chain. A caller could not tell, from a signature, whether failure
// was possible — so most callers did not check.
//
// `Result<T>` is that signature. It cannot be ignored, it carries why, and it
// costs nothing a discriminated union would not.

#pragma once

#include <cstdint>
#include <optional>
#include <string_view>
#include <utility>
#include <variant>

namespace brownie {

/// Why something failed. Coarse on purpose: the message carries the detail, and
/// a caller that switches on fifty codes is a caller that should have been
/// handed one thing that worked.
enum class ErrorCode : std::uint8_t {
    kInvalidArgument,  ///< A caller passed something impossible.
    kNotFound,         ///< A thing that must exist does not.
    kNotReady,         ///< Correct call, too early — retry later.
    kIo,               ///< The operating system refused.
    kProtocol,         ///< The peer sent something the contract forbids.
    kUnsupported,      ///< Understood, deliberately not handled.
    kInternal,         ///< A bug here, not out there.
};

class Error {
  public:
    /// `message` must outlive the error. In practice every one is a literal,
    /// which is why this does not allocate: errors are reported on paths that
    /// may already be failing to allocate.
    constexpr Error(ErrorCode code, std::string_view message) noexcept
        : code_{code}, message_{message} {}

    /// The OS error, when there is one. Zero means "not from the OS".
    constexpr Error(ErrorCode code, std::string_view message, std::uint32_t system_error) noexcept
        : code_{code}, message_{message}, system_error_{system_error} {}

    [[nodiscard]] constexpr ErrorCode code() const noexcept { return code_; }
    [[nodiscard]] constexpr std::string_view message() const noexcept { return message_; }
    [[nodiscard]] constexpr std::uint32_t system_error() const noexcept { return system_error_; }

  private:
    ErrorCode code_;
    std::string_view message_;
    std::uint32_t system_error_ = 0;
};

/// A value or the reason there is none.
///
/// `[[nodiscard]]` is the point: a result that is thrown away is a failure
/// nobody noticed, which is the exact bug this type exists to prevent.
template <typename T>
class [[nodiscard]] Result {
  public:
    constexpr Result(T value) noexcept : storage_{std::move(value)} {}  // NOLINT(*-explicit-*)
    constexpr Result(Error error) noexcept : storage_{error} {}         // NOLINT(*-explicit-*)

    [[nodiscard]] constexpr bool ok() const noexcept {
        return std::holds_alternative<T>(storage_);
    }
    constexpr explicit operator bool() const noexcept { return ok(); }

    /// Only valid when `ok()`. Calling it otherwise is a bug in the caller, not
    /// a runtime condition to handle — hence no check and no exception.
    [[nodiscard]] constexpr const T& value() const& noexcept { return *std::get_if<T>(&storage_); }
    [[nodiscard]] constexpr T&& value() && noexcept { return std::move(*std::get_if<T>(&storage_)); }

    [[nodiscard]] constexpr const Error& error() const noexcept {
        return *std::get_if<Error>(&storage_);
    }

    /// The value, or a fallback. For the many callers that genuinely have one.
    [[nodiscard]] constexpr T value_or(T fallback) const {
        return ok() ? value() : std::move(fallback);
    }

  private:
    std::variant<T, Error> storage_;
};

/// The same, for an operation that returns nothing but can still fail.
class [[nodiscard]] Status {
  public:
    constexpr Status() noexcept = default;
    constexpr Status(Error error) noexcept : error_{error} {}  // NOLINT(*-explicit-*)

    [[nodiscard]] constexpr bool ok() const noexcept { return !error_.has_value(); }
    constexpr explicit operator bool() const noexcept { return ok(); }
    [[nodiscard]] constexpr const Error& error() const noexcept { return *error_; }

  private:
    std::optional<Error> error_;
};

}  // namespace brownie
