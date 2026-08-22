// Where the shared secret comes from.
//
// **It cannot be a constant in this binary.** A secret compiled into a shipped
// DLL is a secret anybody with the DLL has, which makes the handshake in
// `Handshake.h` an expensive way to authenticate nobody. It cannot come from a
// config file next to the module either, for the same reason with an extra step.
//
// So the runtime mints one per run and writes it where the module can read it:
//
//     %LOCALAPPDATA%\Brownie\<pipe name>.key
//
// Both sides derive that path from the same two inputs, so neither has to be
// told it. `%LOCALAPPDATA%` is readable by this user, SYSTEM and Administrators
// and nobody else, which is **the same audience that can already open the named
// pipe** — the file adds no exposure the transport did not have. What it buys is
// that the secret is fresh every run and lives nowhere durable.
//
// Read on every connection attempt, never cached: the runtime can be restarted
// under a running game, and it mints a new key when it is.

#pragma once

#include <string>
#include <string_view>

#include "core/Result.h"
#include "ipc/Handshake.h"

namespace brownie::ipc {

/// The agreed path for `pipe_name`.
///
/// Fails when `%LOCALAPPDATA%` is unset, or when the pipe name is not something
/// that can safely be a file name — a name carrying a separator or a `..` would
/// make this function a way to read an arbitrary file.
Result<std::wstring> SessionKeyPath(std::wstring_view pipe_name);

/// Reads the secret the runtime published.
///
/// `kNotReady` when the file is absent: the runtime has not started yet, which
/// is the ordinary case at injection time and a reason to retry rather than to
/// give up. `kProtocol` when it is there but is not exactly a 32-byte hex value
/// — a truncated or half-written key must not be silently padded into a
/// different secret.
Result<Secret> ReadSessionKey(std::wstring_view pipe_name);

/// Parses the file's contents. Separated so the format has a test that needs no
/// filesystem, and so the rules are stated in one place.
Result<Secret> ParseSessionKey(std::string_view contents);

}  // namespace brownie::ipc
