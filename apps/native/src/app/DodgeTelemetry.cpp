#include "app/DodgeTelemetry.h"

#include <algorithm>
#include <bit>
#include <cstring>
#include <span>
#include <utility>

namespace brownie::app {
namespace {

static_assert(std::endian::native == std::endian::little,
              "the wire is little-endian and fields are copied as they sit in memory");

template <typename T>
void Put(std::byte* at, T value) noexcept {
    std::memcpy(at, &value, sizeof(T));
}

}  // namespace

std::size_t AppendClientFrame(const ClientFrameView& frame, std::vector<std::byte>& out) {
    const bool scanned = frame.clock_known && frame.born != nullptr && frame.gone != nullptr;
    const std::size_t born = scanned ? std::min(frame.born->size(), kClientFrameMaxBorn) : 0;
    const std::size_t gone = scanned ? std::min(frame.gone->size(), kClientFrameMaxGone) : 0;
    const std::size_t size =
        kClientFrameHeaderBytes + born * kClientFrameShotBytes + gone * kClientFrameGoneBytes;

    const std::size_t start = out.size();
    out.resize(start + size);
    std::byte* at = out.data() + start;

    std::uint8_t flags = 0;
    if (frame.player_known) flags |= kClientFramePlayer;
    if (frame.clock_known) flags |= kClientFrameClock;
    if (scanned) flags |= kClientFrameScanned;
    Put<std::uint8_t>(at, flags);
    Put<std::uint8_t>(at + 1, 0);
    Put<std::uint16_t>(at + 2, static_cast<std::uint16_t>(born));
    Put<std::uint16_t>(at + 4, static_cast<std::uint16_t>(gone));
    Put<std::uint16_t>(at + 6, 0);
    Put<std::int32_t>(at + 8, frame.clock_known ? frame.frame_time_ms : 0);
    Put<float>(at + 12, frame.player_known ? frame.player_x : 0.0F);
    Put<float>(at + 16, frame.player_known ? frame.player_y : 0.0F);
    at += kClientFrameHeaderBytes;

    for (std::size_t index = 0; index < born; ++index) {
        const game::ClientShot& shot = (*frame.born)[index];
        Put<std::int32_t>(at, shot.owner_id);
        Put<std::uint16_t>(at + 4, shot.bullet_id);
        Put<std::uint16_t>(at + 6, 0);
        Put<std::int32_t>(at + 8, shot.age_ms);
        Put<float>(at + 12, shot.start_x);
        Put<float>(at + 16, shot.start_y);
        Put<float>(at + 20, shot.angle);
        Put<float>(at + 24, shot.speed_multiplier);
        Put<float>(at + 28, shot.lifetime_ms);
        Put<float>(at + 32, shot.half_tiles);
        at += kClientFrameShotBytes;
    }
    for (std::size_t index = 0; index < gone; ++index) {
        const game::GoneShot& shot = (*frame.gone)[index];
        Put<std::int32_t>(at, shot.owner_id);
        Put<std::uint16_t>(at + 4, shot.bullet_id);
        Put<std::uint16_t>(at + 6, 0);
        at += kClientFrameGoneBytes;
    }
    return size;
}

bool DodgeTelemetry::Capture(const game::PlayerLocation* player, std::uint64_t now_ms) {
    if (reset_.exchange(false, std::memory_order_relaxed)) {
        scanner_.Reset();
    }
    if (!Wanted(now_ms)) {
        // The claim lapsed: whatever was being tracked will be stale by the time
        // anybody asks again, and a fresh claim should hear about every shot.
        if (scanning_) {
            scanner_.Reset();
            scanning_ = false;
        }
        return false;
    }
    (void)binding_.Refresh(frame_binding_, frame_binding_version_);

    ClientFrameView view;
    if (player != nullptr) {
        view.player_known = true;
        view.player_x = player->x;
        view.player_y = player->y;
    }

    const game::ClientShotRoute& route = frame_binding_.shots;
    if (frame_binding_.game != nullptr && route.objects.usable() && route.frame_time_at != 0) {
        void* world = game::FindWorldManager(*frame_binding_.game, route.objects.world);
        std::int32_t frame_time = 0;
        if (world != nullptr && game::ReadField(world, route.frame_time_at, frame_time)) {
            view.clock_known = true;
            view.frame_time_ms = frame_time;
            if (route.usable() && scanner_.Scan(world, frame_time, route, scan_)) {
                view.born = &scan_.born;
                view.gone = &scan_.gone;
                scanning_ = true;
            }
        }
    }
    if (!view.player_known && !view.clock_known) {
        return false;
    }

    frame_bytes_.clear();
    const std::size_t size = AppendClientFrame(view, frame_bytes_);
    const auto length = static_cast<std::uint32_t>(size);
    {
        const std::lock_guard<std::mutex> guard{pending_mutex_};
        // A runtime that has stopped reading is not helped by a backlog: what it
        // needs when it comes back is the next frame. What the dropped frames
        // said about shots is lost with them, so the scan starts again and the
        // next frame carries every shot as new.
        if (pending_.size() + sizeof(length) + size > kMaxPendingBytes) {
            pending_.clear();
            reset_.store(true, std::memory_order_relaxed);
        }
        const std::size_t at = pending_.size();
        pending_.resize(at + sizeof(length) + size);
        std::memcpy(pending_.data() + at, &length, sizeof(length));
        std::memcpy(pending_.data() + at + sizeof(length), frame_bytes_.data(), size);
    }
    return true;
}

void DodgeTelemetry::Flush(ipc::Session& session) {
    {
        const std::lock_guard<std::mutex> guard{pending_mutex_};
        std::swap(pending_, sending_);
    }
    if (sending_.empty()) {
        return;
    }
    if (session.ready()) {
        std::size_t at = 0;
        while (at + sizeof(std::uint32_t) <= sending_.size()) {
            std::uint32_t length = 0;
            std::memcpy(&length, sending_.data() + at, sizeof(length));
            at += sizeof(length);
            if (length > sending_.size() - at) {
                break;
            }
            (void)session.SendClientFrame(std::span<const std::byte>{sending_.data() + at, length});
            at += length;
        }
    }
    sending_.clear();
}

}  // namespace brownie::app
