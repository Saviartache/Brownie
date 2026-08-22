// Sending the game to the proxy instead of the server.
//
// The game gets its server list over HTTPS, which a MITM proxy never sees, so
// it dials an address the proxy has no way to learn. This detours Winsock's
// `connect`: when the game dials a game-server port, the address is rewritten
// to the local proxy and the *original* is reported, which is the only way
// `AllowlistTargets` ever finds out where the session was meant to go.
//
// **Report, do not decide.** The hook says where the game was heading; the
// allowlist on the Node side decides whether we follow. Nothing here may turn
// the proxy into an open relay.
//
// Only IPv4 on the game port is touched, and only the address is rewritten —
// the port is kept, so the proxy answers where the game already expected a
// server. Everything else — the HTTPS calls, the launcher's traffic, anything
// on another port — passes through untouched, because a redirect nobody asked
// for is a bug even when it happens to work.
//
// The destination is always loopback and is not configurable. A proxy that can
// be pointed anywhere is an open relay, and the one thing this must not become
// is a way to send someone's game traffic to an arbitrary address.

#pragma once

#include <cstdint>
#include <functional>
#include <string>

#include "core/Result.h"
#include "hooks/Hook.h"

namespace brownie::net {

/// Told about an interception: where the game was going, before the rewrite.
using TargetReporter = std::function<void(const std::string& host, std::uint16_t port)>;

struct ConnectHookOptions {
    /// The port the game dials to reach a game server. Anything else is left
    /// alone, and the redirect keeps it — only the address changes, so the
    /// proxy listens on the same port the game already expected.
    std::uint16_t game_port = 2050;
};

/// Detours `connect` in `ws2_32.dll` for the life of this object.
///
/// One per process, like every other detour here — the hook is a C callback
/// with nowhere to carry a `this`.
class ConnectHook {
  public:
    ConnectHook() = default;

    ConnectHook(const ConnectHook&) = delete;
    ConnectHook& operator=(const ConnectHook&) = delete;
    ConnectHook(ConnectHook&&) = delete;
    ConnectHook& operator=(ConnectHook&&) = delete;

    /// Removes the detour. A redirect that outlives its owner would send the
    /// game to a proxy that is no longer listening.
    ~ConnectHook();

    /// Installs and enables the detour.
    ///
    /// `report` is called from whichever thread the game connects on, before
    /// the connection is made. It must not block: a slow reporter is a slow
    /// connect, and the game notices.
    Status Install(ConnectHookOptions options, TargetReporter report);

    void Remove() noexcept;

    /// How many connections have been redirected.
    [[nodiscard]] std::uint32_t redirected() const noexcept;

    /// How many IPv4 connections the hook has seen at all, and the port of the
    /// most recent one it did **not** redirect.
    ///
    /// Without these, "0 redirected" has three explanations and no way to tell
    /// them apart: the game has not dialled yet, it dialled a port we do not
    /// watch, or it reached the network by a route this hook does not cover.
    /// Seeing that it saw four connections, all to 443, answers that in one
    /// run instead of three.
    [[nodiscard]] std::uint32_t seen() const noexcept;
    [[nodiscard]] std::uint16_t last_other_port() const noexcept;

  private:
    hooks::Hook hook_;
};

}  // namespace brownie::net
