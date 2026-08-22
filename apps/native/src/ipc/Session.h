// The conversation with the Node runtime.
//
// Ties the four pieces that were deliberately kept apart — transport, framing,
// handshake and payloads — into the exchange `docs/ipc.md` describes. Each of
// them is testable alone precisely because none of them knows about the others;
// this is the one place that does.
//
// **Receiving runs on the IPC thread.** A handler may only *store* what it was
// told. Anything that has to end in a call into the game raises a flag that the
// render thread consumes on its next tick — the game's runtime is not safe to
// touch from here, and the reference implementation's rule about this is one of
// the few that carried over unchanged.
//
// **Sending is callable from any thread**, and is serialised here. The connect
// redirect reports from whichever thread the game dialled on, with the game's
// `connect` blocked behind it, so it is not a thread this class may choose. Two
// senders without a lock would interleave their bytes on the pipe *and* hand
// out the same sequence number twice, either of which ends the conversation.

#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "core/Result.h"
#include "ipc/Frame.h"
#include "ipc/FrameReader.h"
#include "ipc/Handshake.h"
#include "ipc/PipeClient.h"

namespace brownie::ipc {

enum class SessionState : std::uint8_t {
    kDisconnected,
    /// Connected, greeting sent, waiting for the runtime to prove itself.
    kAuthenticating,
    /// Authenticated. Only now may anything but the handshake be sent.
    kReady,
};

/// What the runtime asks of us. Both are stored, never acted on here.
struct SessionHandlers {
    /// One gameplay setting. Unknown keys are accepted and ignored, so a newer
    /// plugin never breaks an older module.
    std::function<void(std::string_view key, std::string_view value)> on_feature;
    /// One overlay record to mirror.
    std::function<void(std::string_view record)> on_record;
};

class Session {
  public:
    explicit Session(std::uint32_t pid) noexcept : pid_{pid} {}

    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    void SetHandlers(SessionHandlers handlers) { handlers_ = std::move(handlers); }

    /// Opens the pipe and sends the greeting.
    ///
    /// The secret is a parameter rather than a member set once, because it
    /// belongs to the connection and not to the session: the runtime mints a
    /// fresh one per run, so a reconnect after the runtime restarted uses a
    /// different key than the connection before it. See `SessionKey.h`.
    ///
    /// `kNotFound` means the runtime is not listening — the ordinary case when
    /// the game starts first, and a reason to retry rather than to give up.
    Status Connect(std::wstring_view pipe_name, const Secret& secret);

    /// Ends the conversation and forgets everything about the peer.
    ///
    /// Safe from any thread and more than once: this is what a teardown calls,
    /// and a teardown that has to be sequenced correctly is a teardown that will
    /// eventually be sequenced wrongly.
    void Disconnect() noexcept;

    [[nodiscard]] SessionState state() const noexcept {
        return state_.load(std::memory_order_acquire);
    }
    [[nodiscard]] bool ready() const noexcept { return state() == SessionState::kReady; }

    /// Reads what has arrived and acts on it, waiting up to `timeout_ms`.
    ///
    /// A timeout is not an error — it is the idle case, and the caller loops.
    /// Anything else has already disconnected by the time it returns: every
    /// failure this can report means the conversation is over.
    Status Poll(std::uint32_t timeout_ms);

    /// One overlay interaction, travelling back.
    Status SendControlAction(std::string_view action);

    /// An edge-triggered key press the module detected.
    Status SendHotkey(std::string_view plugin_id, std::string_view action, bool value);

    /// Where the game was heading before it was redirected to the proxy.
    ///
    /// Sent from the thread the game connects on, so it must not wait: the
    /// game's `connect` is blocked behind it.
    Status SendServerTarget(std::string_view host, std::uint16_t port);

    /// Per-frame player state, packed. See `docs/ipc.md` for the layout.
    Status SendTelemetry(bool alive, float x, float y, std::int32_t hp, std::int32_t max_hp,
                         std::int32_t defense, bool defense_known, std::uint32_t uptime_ms);

  private:
    Status Send(MessageType type, std::string_view payload, bool binary);
    Status Dispatch(const Frame& frame);
    Status HandleAuthChallenge(std::string_view payload);
    Status HandlePing(std::string_view payload);

    Secret secret_{};
    std::uint32_t pid_ = 0;

    PipeClient pipe_;
    FrameReader reader_;
    NativeHandshake handshake_{secret_, pid_};
    SequenceGuard inbound_;
    SessionHandlers handlers_;
    /// Read from any thread, written on the IPC thread.
    std::atomic<SessionState> state_{SessionState::kDisconnected};

    /// Guards everything one send touches: the counter, the buffer and the
    /// pipe. Held across the write, so a frame reaches the peer whole.
    std::mutex send_mutex_;
    SequenceSource outbound_;
    /// One frame's bytes, reused. Grown to the largest frame this run has sent
    /// and never shrunk: a send is otherwise an allocation per message, on a
    /// path a burst of overlay records walks a hundred times.
    std::vector<std::byte> send_buffer_;

    /// Where a pipe read lands. A member so the loop does not put — and
    /// zero — kilobytes on the stack every time it polls an idle link.
    std::vector<std::byte> receive_buffer_;
};

}  // namespace brownie::ipc
