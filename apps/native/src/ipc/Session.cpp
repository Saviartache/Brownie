#include "ipc/Session.h"

#include <array>
#include <cstring>

#include "ipc/Json.h"

namespace brownie::ipc {
namespace {

/// How much one pipe read may take at once.
///
/// **Matched to what the runtime writes in one go**, which is what makes a burst
/// one read rather than a dozen. Anything left over waits for the next turn of
/// the loop, so a reader smaller than the writer's batch turns a steady stream
/// into a growing lag: the dodge picture — fifty shot paths and sixty circles,
/// twenty times a second — arrived late enough to be stale and blinked out. Sixty
/// four kilobytes is the runtime's own batch ceiling and an unremarkable resident
/// allocation in someone else's game.
constexpr std::size_t kReceiveBytes = 64u * 1024u;

/// Telemetry, packed. Binary because it goes out on every game frame.
constexpr std::size_t kTelemetryBytes = 24;
constexpr std::uint8_t kAlive = 1U << 0U;
constexpr std::uint8_t kDefenseKnown = 1U << 1U;

void PutU16(std::byte* at, std::uint16_t value) noexcept {
    at[0] = static_cast<std::byte>(value & 0xFFU);
    at[1] = static_cast<std::byte>((value >> 8U) & 0xFFU);
}

void PutU32(std::byte* at, std::uint32_t value) noexcept {
    at[0] = static_cast<std::byte>(value & 0xFFU);
    at[1] = static_cast<std::byte>((value >> 8U) & 0xFFU);
    at[2] = static_cast<std::byte>((value >> 16U) & 0xFFU);
    at[3] = static_cast<std::byte>((value >> 24U) & 0xFFU);
}

}  // namespace

Status Session::Connect(std::wstring_view pipe_name, const Secret& secret) {
    Disconnect();

    if (auto opened = pipe_.Connect(pipe_name); !opened.ok()) {
        return opened.error();
    }

    secret_ = secret;
    reader_.Reset();
    inbound_.Reset();
    handshake_ = NativeHandshake{secret_, pid_};
    {
        const std::lock_guard<std::mutex> guard{send_mutex_};
        outbound_.Reset();
    }
    if (receive_buffer_.size() != kReceiveBytes) {
        receive_buffer_.resize(kReceiveBytes);
    }

    auto challenge = handshake_.Begin();
    if (!challenge.ok()) {
        Disconnect();
        return challenge.error();
    }

    json::Writer writer;
    const std::string hello =
        writer.Int("pid", pid_).Str("challenge", challenge.value()).Finish();

    // The greeting is the one thing that may travel before authentication, so
    // the state is set first — `Send` refuses anything else until we are ready.
    state_.store(SessionState::kAuthenticating, std::memory_order_release);
    if (auto sent = Send(MessageType::kHello, hello, false); !sent.ok()) {
        Disconnect();
        return sent.error();
    }
    return {};
}

void Session::Disconnect() noexcept {
    // Cancelled before the lock is taken, not after. A send blocked on a peer
    // that has stopped reading holds the lock, and cancelling is what returns
    // that thread — waiting for the lock first would be waiting for the very
    // write this call exists to abandon.
    pipe_.Cancel();

    const std::lock_guard<std::mutex> guard{send_mutex_};
    pipe_.Disconnect();
    reader_.Reset();
    state_.store(SessionState::kDisconnected, std::memory_order_release);
}

Status Session::Send(MessageType type, std::string_view payload, bool binary) {
    if (payload.size() > kMaxPayloadBytes) {
        return Error{ErrorCode::kInvalidArgument, "payload exceeds the frame cap"};
    }

    const std::lock_guard<std::mutex> guard{send_mutex_};

    // Read under the lock rather than before it: the link can drop between a
    // caller deciding to send and this, and a sequence number handed out on a
    // connection that has gone is a gap the next one would be blamed for.
    const SessionState state = state_.load(std::memory_order_acquire);
    if (state == SessionState::kDisconnected) {
        return Error{ErrorCode::kNotReady, "the session is not connected"};
    }
    if (state != SessionState::kReady && type != MessageType::kHello &&
        type != MessageType::kAuthResult) {
        // Refused rather than queued: the runtime would reject it anyway, and
        // sending it would advance the sequence past what the peer expects.
        return Error{ErrorCode::kNotReady, "the session has not authenticated yet"};
    }

    const std::size_t total = kHeaderBytes + payload.size();
    if (send_buffer_.size() < total) {
        send_buffer_.resize(total);
    }

    const FrameHeader header{
        kVersion,
        static_cast<std::uint16_t>(type),
        static_cast<std::uint16_t>(binary ? FrameFlags::kBinary : FrameFlags::kNone),
        outbound_.Take(),
        static_cast<std::uint32_t>(payload.size()),
    };
    if (auto written = WriteHeader(send_buffer_.data(), send_buffer_.size(), header);
        !written.ok()) {
        return written.error();
    }
    if (!payload.empty()) {
        std::memcpy(send_buffer_.data() + kHeaderBytes, payload.data(), payload.size());
    }
    return pipe_.Send(send_buffer_.data(), total);
}

Status Session::Poll(std::uint32_t timeout_ms) {
    if (state_.load(std::memory_order_acquire) == SessionState::kDisconnected) {
        return Error{ErrorCode::kNotReady, "the session is not connected"};
    }

    auto received = pipe_.Receive(receive_buffer_.data(), receive_buffer_.size(), timeout_ms);
    if (!received.ok()) {
        // A timeout is the idle case and leaves the session alone; anything
        // else means the pipe is gone.
        if (received.error().code() == ErrorCode::kNotReady) {
            return received.error();
        }
        Disconnect();
        return received.error();
    }
    reader_.Push(receive_buffer_.data(), received.value());

    for (;;) {
        auto frame = reader_.Next();
        if (!frame.ok()) {
            if (frame.error().code() == ErrorCode::kNotReady) {
                return {};  // waiting for more bytes, which is not a problem
            }
            Disconnect();
            return frame.error();
        }
        if (auto accepted = inbound_.Accept(frame.value().header.seq); !accepted.ok()) {
            Disconnect();
            return accepted.error();
        }
        if (auto handled = Dispatch(frame.value()); !handled.ok()) {
            Disconnect();
            return handled.error();
        }
    }
}

Status Session::Dispatch(const Frame& frame) {
    const std::string_view payload{reinterpret_cast<const char*>(frame.payload),
                                   frame.payload_size};

    switch (static_cast<MessageType>(frame.header.type)) {
        case MessageType::kAuthChallenge:
            return HandleAuthChallenge(payload);

        case MessageType::kPing:
            return HandlePing(payload);

        case MessageType::kSetFeature: {
            if (!ready()) return Error{ErrorCode::kProtocol, "data before authentication"};
            auto key = json::String(payload, "key");
            if (!key.ok()) return key.error();
            // The value is read as text whatever it is: this side stores it and
            // the feature that consumes it knows its own type. Deciding here
            // would mean this file learning every feature's shape.
            auto value = json::Value(payload, "value");
            if (handlers_.on_feature) {
                handlers_.on_feature(key.value(), value.ok() ? value.value() : std::string_view{});
            }
            return {};
        }

        case MessageType::kControlRecord: {
            if (!ready()) return Error{ErrorCode::kProtocol, "data before authentication"};
            auto record = json::String(payload, "record");
            if (!record.ok()) return record.error();
            if (handlers_.on_record) handlers_.on_record(record.value());
            return {};
        }

        default:
            // A newer runtime may send types this build predates. Ignoring one
            // is the contract; failing on it would put the two sides in
            // lockstep, which is the thing the version field exists to avoid.
            return {};
    }
}

Status Session::HandleAuthChallenge(std::string_view payload) {
    if (state_.load(std::memory_order_acquire) != SessionState::kAuthenticating) {
        return Error{ErrorCode::kProtocol, "an unexpected authentication challenge"};
    }

    auto user_id = json::String(payload, "userId");
    if (!user_id.ok()) return user_id.error();
    auto response = json::String(payload, "response");
    if (!response.ok()) return response.error();
    auto challenge = json::String(payload, "challenge");
    if (!challenge.ok()) return challenge.error();
    auto runtime_pid = json::Integer(payload, "pid");
    if (!runtime_pid.ok()) return runtime_pid.error();

    auto answer = handshake_.Finish(response.value(), challenge.value(), user_id.value(),
                                    static_cast<std::uint32_t>(runtime_pid.value()));
    if (!answer.ok()) {
        // The runtime could not prove it holds the shared secret. Saying so and
        // hanging up is the whole of the response: there is nothing to retry.
        return answer.error();
    }

    json::Writer writer;
    const std::string result = writer.Bool("ok", true).Str("response", answer.value()).Finish();
    if (auto sent = Send(MessageType::kAuthResult, result, false); !sent.ok()) {
        return sent.error();
    }
    state_.store(SessionState::kReady, std::memory_order_release);
    return {};
}

Status Session::HandlePing(std::string_view payload) {
    auto nonce = json::String(payload, "nonce");
    if (!nonce.ok()) return nonce.error();
    auto response = handshake_.AnswerPing(nonce.value());
    if (!response.ok()) return response.error();

    json::Writer writer;
    return Send(MessageType::kPong, writer.Str("response", response.value()).Finish(), false);
}

Status Session::SendControlAction(std::string_view action) {
    json::Writer writer;
    return Send(MessageType::kControlAction, writer.Str("action", action).Finish(), false);
}

Status Session::SendHotkey(std::string_view plugin_id, std::string_view action, bool value) {
    json::Writer writer;
    const std::string payload =
        writer.Str("pluginId", plugin_id).Str("action", action).Bool("value", value).Finish();
    return Send(MessageType::kHotkeyEvent, payload, false);
}

Status Session::SendServerTarget(std::string_view host, std::uint16_t port) {
    json::Writer writer;
    const std::string payload = writer.Str("host", host).Int("port", port).Finish();
    return Send(MessageType::kServerTarget, payload, false);
}

Status Session::SendTelemetry(bool alive, float x, float y, std::int32_t hp, std::int32_t max_hp,
                              std::int32_t defense, bool defense_known,
                              std::uint32_t uptime_ms) {
    std::array<std::byte, kTelemetryBytes> packed{};
    std::uint8_t flags = 0;
    if (alive) flags |= kAlive;
    // A separate bit, so "unknown" stays distinguishable from "zero": the
    // runtime's survival logic must not read a failed memory read as no armour.
    if (defense_known) flags |= kDefenseKnown;

    packed[0] = static_cast<std::byte>(flags);
    packed[1] = std::byte{0};
    PutU16(packed.data() + 2, static_cast<std::uint16_t>(static_cast<std::int16_t>(defense)));

    std::uint32_t bits = 0;
    std::memcpy(&bits, &x, sizeof(bits));
    PutU32(packed.data() + 4, bits);
    std::memcpy(&bits, &y, sizeof(bits));
    PutU32(packed.data() + 8, bits);

    PutU32(packed.data() + 12, static_cast<std::uint32_t>(hp));
    PutU32(packed.data() + 16, static_cast<std::uint32_t>(max_hp));
    PutU32(packed.data() + 20, uptime_ms);

    return Send(MessageType::kPlayerTelemetry,
                std::string_view{reinterpret_cast<const char*>(packed.data()), packed.size()}, true);
}

}  // namespace brownie::ipc
