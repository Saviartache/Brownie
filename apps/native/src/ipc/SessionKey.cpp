#include "ipc/SessionKey.h"

#include <array>
#include <vector>

#include <Windows.h>

#include "core/WinHandle.h"

namespace brownie::ipc {
namespace {

/// Generous next to a 65-byte file, small enough that a wrong path cannot cost
/// anything. A key file larger than this is not a key file.
constexpr std::size_t kMaxKeyFileBytes = 256;

[[nodiscard]] bool IsAlphanumeric(wchar_t character) noexcept {
    return (character >= L'a' && character <= L'z') || (character >= L'A' && character <= L'Z') ||
           (character >= L'0' && character <= L'9');
}

[[nodiscard]] bool IsSafeNameCharacter(wchar_t character) noexcept {
    return IsAlphanumeric(character) || character == L'-' || character == L'_' || character == L'.';
}

/// One hex digit's value, or -1.
[[nodiscard]] int HexValue(char character) noexcept {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
}

}  // namespace

Result<std::wstring> SessionKeyPath(std::wstring_view pipe_name) {
    if (pipe_name.empty() || pipe_name.size() > 64 || !IsAlphanumeric(pipe_name.front())) {
        // Requiring the first character to be alphanumeric is what rules out
        // `.` and `..`, which pass a plain character-set check and name a
        // directory rather than a file.
        return Error{ErrorCode::kInvalidArgument, "the pipe name is not a usable file name"};
    }
    for (const wchar_t character : pipe_name) {
        if (!IsSafeNameCharacter(character)) {
            // A separator or a dot-dot here would turn this function into a way
            // to read an arbitrary file, so the check is on the character set
            // rather than on a list of things to forbid.
            return Error{ErrorCode::kInvalidArgument, "the pipe name contains an unusable character"};
        }
    }

    // Two-call form: the first asks how much room the value needs.
    const DWORD needed = ::GetEnvironmentVariableW(L"LOCALAPPDATA", nullptr, 0);
    if (needed == 0) {
        return Error{ErrorCode::kNotFound, "LOCALAPPDATA is not set", ::GetLastError()};
    }
    std::vector<wchar_t> buffer(needed);
    const DWORD written = ::GetEnvironmentVariableW(L"LOCALAPPDATA", buffer.data(), needed);
    if (written == 0 || written >= needed) {
        return Error{ErrorCode::kIo, "LOCALAPPDATA could not be read", ::GetLastError()};
    }

    std::wstring path{buffer.data(), written};
    path.append(L"\\Brownie\\").append(pipe_name).append(L".key");
    return path;
}

Result<Secret> ParseSessionKey(std::string_view contents) {
    // Trailing whitespace is tolerated because a text file often ends with a
    // newline; nothing else is, because every other difference means the file
    // is not what we think it is.
    while (!contents.empty() && (contents.back() == '\n' || contents.back() == '\r' ||
                                 contents.back() == ' ' || contents.back() == '\t')) {
        contents.remove_suffix(1);
    }

    if (contents.size() != kNonceBytes * 2) {
        return Error{ErrorCode::kProtocol, "the session key is not 32 bytes of hex"};
    }

    Secret secret{};
    for (std::size_t i = 0; i < kNonceBytes; ++i) {
        const int high = HexValue(contents[i * 2]);
        const int low = HexValue(contents[i * 2 + 1]);
        if (high < 0 || low < 0) {
            return Error{ErrorCode::kProtocol, "the session key contains a non-hex character"};
        }
        secret[i] = static_cast<std::uint8_t>((high << 4) | low);
    }
    return secret;
}

Result<Secret> ReadSessionKey(std::wstring_view pipe_name) {
    const auto path = SessionKeyPath(pipe_name);
    if (!path.ok()) {
        return path.error();
    }

    // Shared for reading *and* writing: the runtime may be rewriting the file at
    // this moment, and refusing to open it then would turn a restart into a
    // failure to reconnect. A partial read fails the length check below, which
    // is a retry, not a wrong key.
    const WinHandle file{::CreateFileW(path.value().c_str(), GENERIC_READ,
                                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                       nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    if (!file.valid()) {
        const DWORD error = ::GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
            return Error{ErrorCode::kNotReady, "the runtime has not published a session key",
                         error};
        }
        return Error{ErrorCode::kIo, "the session key could not be opened", error};
    }

    std::array<char, kMaxKeyFileBytes> buffer{};
    DWORD read = 0;
    if (::ReadFile(file.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) ==
        FALSE) {
        return Error{ErrorCode::kIo, "the session key could not be read", ::GetLastError()};
    }
    return ParseSessionKey(std::string_view{buffer.data(), read});
}

}  // namespace brownie::ipc
