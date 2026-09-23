// The client's own view of the fight, handed to the dodge a frame at a time.
//
// **The runtime plans from what it was told; this is what the client knows.**
// Where the player is arrives on the wire five times a second, from a `MOVE`
// the client sent about a moment already gone — while the character walks every
// frame. A planner working from that position thinks the step it commanded has
// not happened yet, commands it again, and carries the character a tile and a
// half past where it meant to stop: out of the way of one shot and into the
// next. The shots are the same story told the other way round: the runtime
// times them from the packet, the client from the frame it read the packet on,
// and a bullet that has hit a wall is still flying as far as any packet says.
//
// So while the dodge asks, every frame sends three things only this side can
// see: where the player is now, the client's frame clock, and every enemy shot
// the client made or destroyed since the last frame — see `game/ClientShots.h`.
//
// **Threads, as everywhere in the module.** The runtime's claim arrives on the
// IPC thread and is a lease; the reading is taken on the render thread, which is
// the game's; the sending happens on the IPC thread, which is the only one that
// may write to the pipe. Between the last two is one buffer of packed frames
// that the render thread appends to and the IPC thread swaps out, under a lock
// that is only ever held for a swap.

#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

#include "core/Snapshot.h"
#include "game/ClientShots.h"
#include "game/Il2CppRuntime.h"
#include "game/MapObjects.h"
#include "game/PlayerRoute.h"
#include "ipc/Frame.h"
#include "ipc/Session.h"

namespace brownie::app {

/// Everything the render thread needs to take a reading, published together so
/// a frame never has one without the others.
struct DodgeTelemetryBinding {
    const game::Il2CppRuntime* game = nullptr;
    game::ClientShotRoute shots;
};

/// Bit 0 of a frame's flags: the player's position is in it.
inline constexpr std::uint8_t kClientFramePlayer = 1U << 0U;
/// Bit 1: the client's frame clock was read, and the frame carries it.
inline constexpr std::uint8_t kClientFrameClock = 1U << 1U;
/// Bit 2: the shots were scanned against that clock, so the two lists are the
/// whole of this frame's news rather than an absence of it.
///
/// Its own bit rather than implied by the clock's, because the clock resolves
/// the moment a realm is built and the projectile class only once something has
/// shot — a frame in between has a clock worth using and no scan behind it.
inline constexpr std::uint8_t kClientFrameScanned = 1U << 2U;

/// The fixed part of a frame: flags, two counts, the frame clock, the player.
inline constexpr std::size_t kClientFrameHeaderBytes = 20;
/// One shot the client made.
inline constexpr std::size_t kClientFrameShotBytes = 36;
/// One shot the client destroyed.
inline constexpr std::size_t kClientFrameGoneBytes = 8;

/// The most shots made that one frame carries — twice what a scan can find.
inline constexpr std::size_t kClientFrameMaxBorn = 2 * game::ClientShotScanner::kMaxClassifiedPerScan;
/// The most shots destroyed that one frame carries: every object a scan could
/// have been tracking, so a realm emptying at once is still said in full.
inline constexpr std::size_t kClientFrameMaxGone = game::kMaxMapObjects;

static_assert(kClientFrameHeaderBytes + kClientFrameMaxBorn * kClientFrameShotBytes +
                      kClientFrameMaxGone * kClientFrameGoneBytes <=
                  ipc::kMaxPayloadBytes,
              "the fullest frame has to fit in one message");

/// What one frame says, before it is packed.
struct ClientFrameView {
    bool player_known = false;
    float player_x = 0.0F;
    float player_y = 0.0F;
    bool clock_known = false;
    std::int32_t frame_time_ms = 0;
    /// Both set when the shots were scanned, and both null when they were not.
    const std::vector<game::ClientShot>* born = nullptr;
    const std::vector<game::GoneShot>* gone = nullptr;
};

/// Packs one frame onto the end of `out`, and says how long it was.
///
/// The layout is `docs/ipc.md`'s, and `packages/ipc` decodes it. A list longer
/// than its ceiling carries the first that many — which the ceilings above make
/// a thing a scan cannot produce.
std::size_t AppendClientFrame(const ClientFrameView& frame, std::vector<std::byte>& out);

class DodgeTelemetry {
  public:
    /// How long the runtime's claim is good for without being restated — three
    /// of the second the runtime restates it on, like every other claim here.
    static constexpr std::uint64_t kLeaseMs = 3000;

    /// How much packed telemetry may wait for the IPC thread before it is
    /// dropped. A runtime that has stopped reading is not helped by a backlog,
    /// and a frame is only worth sending while it is recent.
    static constexpr std::size_t kMaxPendingBytes = 256u * 1024u;

    DodgeTelemetry() = default;
    DodgeTelemetry(const DodgeTelemetry&) = delete;
    DodgeTelemetry& operator=(const DodgeTelemetry&) = delete;

    /// The runtime's claim, restated while it wants telemetry. **IPC thread.**
    void Claim(bool on, std::uint64_t now_ms) noexcept {
        until_ms_.store(on ? now_ms + kLeaseMs : 0, std::memory_order_relaxed);
    }

    /// Whether the claim is live. Any thread.
    [[nodiscard]] bool Wanted(std::uint64_t now_ms) const noexcept {
        return now_ms < until_ms_.load(std::memory_order_relaxed);
    }

    /// Hands over where to read from. **IPC thread.**
    void Bind(const DodgeTelemetryBinding& binding) { binding_.Publish(binding); }

    /// Asks the render thread to forget what it was tracking, so the next frame
    /// reports every shot as new — which a runtime that has just connected has
    /// never heard of. **Any thread.**
    void RequestReset() noexcept { reset_.store(true, std::memory_order_relaxed); }

    /// Takes this frame's reading, when the claim is live. **Render thread.**
    ///
    /// @param player Where the player is this frame, or null when there is none.
    /// @returns whether a frame was packed, which is when the IPC thread is
    ///   worth waking.
    bool Capture(const game::PlayerLocation* player, std::uint64_t now_ms);

    /// Sends everything packed since the last call, a frame per message.
    /// **IPC thread.** A frame that fails to send is dropped: the next one is
    /// more recent anyway, and a link that is down drops them all.
    void Flush(ipc::Session& session);

  private:
    std::atomic<std::uint64_t> until_ms_{0};
    std::atomic<bool> reset_{false};
    Snapshot<DodgeTelemetryBinding> binding_;

    // The render thread's own.
    DodgeTelemetryBinding frame_binding_;
    std::uint64_t frame_binding_version_ = 0;
    game::ClientShotScanner scanner_;
    game::ShotScan scan_;
    /// Whether the scanner is tracking anything, so a lapsed claim resets it
    /// once rather than on every frame nobody wants.
    bool scanning_ = false;

    /// Packed frames, each preceded by its length. Filled by the render thread,
    /// swapped out by the IPC thread; the swap keeps both buffers' capacity, so
    /// neither allocates once it has grown.
    std::mutex pending_mutex_;
    std::vector<std::byte> pending_;
    /// The render thread's scratch for one frame, and the IPC thread's for a
    /// batch — each only ever touched by its own thread.
    std::vector<std::byte> frame_bytes_;
    std::vector<std::byte> sending_;
};

}  // namespace brownie::app
