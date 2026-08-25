// Telling the player where to walk and where to shoot.
//
// **Two threads meet here, and that is the whole reason this is one object.**
// What the runtime asks for arrives on the IPC thread; acting on it means
// calling into managed code, which only the game's own thread may do. The
// snapshots in the middle are the boundary: the IPC side publishes a target,
// the frame reads whatever is current, and neither waits for the other.
//
// Everything the frame needs is published once and read without a lock. The
// route to the player and the runtime it belongs to settle the moment the
// offsets resolve and never change for the run, so one release-acquire pair
// makes both visible together — a frame either has both or has neither.

#pragma once

#include <atomic>
#include <cstdint>

#include "core/Snapshot.h"
#include "game/AimHook.h"
#include "game/Il2CppRuntime.h"
#include "game/PlayerMover.h"
#include "game/PlayerRoute.h"
#include "overlay/WorldRecord.h"

namespace brownie::app {

/// Where the runtime wants the player to walk, and for how long that stands.
///
/// **A target, not a command.** Walking is a sequence of small steps issued
/// every frame; one large step is a teleport, which the server takes back. So
/// this persists and the frame decides how far to carry it — see
/// `PlayerMover::StepTowards`.
///
/// It expires rather than being cancelled. The runtime plans on the server's
/// tick and says nothing when it decides to stand still, so "no fresh target"
/// has to mean "stop" on its own — otherwise the last dodge would be walked
/// towards forever.
struct MoveTarget {
    bool wanted = false;
    float x = 0.0F;
    float y = 0.0F;
    /// Tiles per second the step is allowed to cover.
    float speed = 0.0F;
    /// A tick count, stamped where it arrived.
    std::uint64_t expires_at_ms = 0;
    /// Whether {@link x} and {@link y} are an offset from the player rather
    /// than a place on the map. See `overlay::MoveCommand::from_player`.
    bool from_player = false;
    /// Whether the first frame that steps towards this spends it.
    ///
    /// The dodge's hop: one frame's worth of movement, once. See
    /// `overlay::MoveCommand::once` for why an offset that persists would carry
    /// the character further on every frame of the hold.
    bool once = false;
};

/// Where the runtime wants the player's shots to go, and for how long.
///
/// Expires like a {@link MoveTarget} and for the same reason: the runtime plans
/// on the server's tick and says nothing when it has no target, so "no fresh
/// aim" has to mean "the player's own aim is theirs again" on its own.
struct AimTarget {
    bool wanted = false;
    float x = 0.0F;
    float y = 0.0F;
    /// A tick count, stamped where it arrived.
    std::uint64_t expires_at_ms = 0;
};

/// The longest a single frame may claim to have taken.
///
/// A stall, a breakpoint or a minimised window can put a second between two
/// frames, and a second's worth of travel issued as one step is exactly the
/// teleport that stepping exists to avoid.
inline constexpr std::uint64_t kMaxFrameMs = 100;

/// The furthest one frame may be told to carry, whatever the speed says.
///
/// The second guard, and independent of the first on purpose: if the measured
/// speed is ever wrong again, this still bounds what a single command can do.
/// Roughly two frames of the fastest thing in the game.
inline constexpr float kMaxStepTiles = 0.7F;

/// Converts a record into a target, stamping when it expires.
///
/// Stamped on arrival rather than sent: the two sides do not share a clock, and
/// the only moment that matters is when it got here.
[[nodiscard]] MoveTarget MoveTargetFrom(const overlay::MoveCommand& move,
                                        std::uint64_t now_ms) noexcept;
[[nodiscard]] AimTarget AimTargetFrom(const overlay::AimCommand& aim,
                                      std::uint64_t now_ms) noexcept;

/// How far one frame may carry a walk, in tiles.
///
/// **The speed comes with the target, and nothing here measures it.** Measuring
/// it from ground covered is the obvious idea and a broken one: the ground was
/// covered because of a command this code issued, so an overestimate lengthens
/// the next step, which covers more ground, which raises the estimate. Two
/// attempts at damping that loop both ended with a character outside the map.
/// The runtime derives the speed from the stat the server sends instead — a
/// number that depends on nothing this system does, which is the only property
/// that actually fixes it.
///
/// Both guards apply and they are independent: a frame that took a second is
/// counted as `kMaxFrameMs`, and whatever the arithmetic yields, one frame
/// cannot command more than `kMaxStepTiles`.
[[nodiscard]] float StepBudget(std::uint64_t elapsed_ms, float speed) noexcept;

/// How much of that budget is left once the player's own walking is counted.
///
/// **The step is added to the game's own movement, not put in its place.** A
/// player holding a key the way the runtime is steering them therefore travels
/// at both speeds at once, which is the one thing the server does take back —
/// live report: "if the vectors agree, the speeds add up and it teleports us."
/// Cancelling the input on the runtime's side answers the ordinary case, but it
/// answers it from a position that is up to a server tick old and from a belief
/// about which keys are down. The ground that actually appeared under the
/// character is neither, and it is only knowable here.
///
/// So the limit is on the *sum*: this is the largest step along `toward` that
/// keeps the frame's whole travel — theirs plus ours — inside `budget`, which
/// is `t` where `|own + t·û| = budget`. Nought when they are already spending
/// the limit themselves, whatever direction they are spending it in, and never
/// more than `budget`, because a correction is allowed to be partial and is
/// never allowed to be a snap-back of its own.
///
/// @param own What the player covered under their own power since the last
///   frame, in tiles. Zero when there is nothing to go on.
/// @param toward Where the step points, of any length. Nought for no direction.
[[nodiscard]] float RoomToStep(float budget, float own_x, float own_y, float toward_x,
                               float toward_y) noexcept;

class PlayerControl {
  public:
    PlayerControl() noexcept = default;

    PlayerControl(const PlayerControl&) = delete;
    PlayerControl& operator=(const PlayerControl&) = delete;

    /// Hands the frame everything it needs to reach the player. IPC thread,
    /// once: after this the game's thread can walk to the player without
    /// touching anything the loop is still working on.
    void Bind(const game::Il2CppRuntime& game, const game::PlayerRoute& route) noexcept;

    /// Whether {@link Bind} has happened. Callable from either thread.
    [[nodiscard]] bool bound() const noexcept { return ready_.load(std::memory_order_acquire); }

    /// Binds the method that walks. IPC thread.
    void BindMover(void* move_to) noexcept { mover_.Bind(move_to); }
    [[nodiscard]] bool mover_bound() const noexcept { return mover_.bound(); }

    /// Puts the aim detours in place. IPC thread. A no-op for one already live,
    /// so it can be called again until both are: IL2CPP builds the two classes
    /// whenever it gets round to them, rarely on the same turn.
    void InstallAim(void* compute_shoot_angle, void* shoot_with_angle);

    [[nodiscard]] bool aim_complete() const noexcept { return aim_.complete(); }

    /// Whether the runtime has ever asked to aim, which is the only reason to
    /// write a detour into the game's code.
    [[nodiscard]] bool aim_wanted() const noexcept { return aim_wanted_; }

    /// Where the player is right now. **Game thread only**, and false when
    /// there is no player — between realms, at the login screen, during a map
    /// rebuild.
    ///
    /// Here rather than in the caller because the route is here: the walk from
    /// the static field to the player object is the one thing this class knows
    /// that nobody else does, and a second copy of it is a second thing to keep
    /// in step. Walked afresh, never cached, for the reason `Apply` gives.
    [[nodiscard]] bool Locate(game::PlayerLocation& out) const;

    /// Publishes a target for the frame to act on. IPC thread.
    void MoveTo(const MoveTarget& target) { move_target_.Publish(target); }
    void AimAt(const AimTarget& target);

    /// Where this frame walked to, if it walked anywhere.
    ///
    /// **The place `Apply` actually stepped towards**, so it says what the
    /// character is being sent at rather than what the runtime last published —
    /// the two differ for a frame, and something drawing the difference would be
    /// drawing a lie. A heading is only a place once the player has been found,
    /// which is the other reason this is the resolved answer and not the record.
    /// Valid once `Apply` has run this frame. **Game thread.**
    [[nodiscard]] bool WalkTarget(float& x, float& y) const noexcept {
        if (!frame_walking_) {
            return false;
        }
        x = frame_walk_x_;
        y = frame_walk_y_;
        return true;
    }

    /// Where this frame is pointing the player's shots, if it is pointing them
    /// anywhere. The frame's own copy, and valid after `Apply`, for the reason
    /// {@link WalkTarget} gives. **Game thread.**
    [[nodiscard]] bool AimTargetNow(std::uint64_t now_ms, float& x, float& y) const noexcept {
        if (!frame_aim_.wanted || now_ms >= frame_aim_.expires_at_ms) {
            return false;
        }
        x = frame_aim_.x;
        y = frame_aim_.y;
        return true;
    }

    /// How many shots the detours have pointed somewhere else. Any thread.
    [[nodiscard]] std::uint32_t redirected() const noexcept { return aim_.redirected(); }

    /// Whether either detour is in place. Any thread.
    ///
    /// Worth telling apart from an aim that is live: a target published with no
    /// detour behind it is a feature that looks switched on, draws a crosshair,
    /// and changes nothing about where the shots go.
    [[nodiscard]] bool aim_installed() const noexcept { return aim_.installed(); }

    /// Performs whatever the runtime asked for this frame — a step, a shot, or
    /// both. **Game thread only**: it calls into managed code, which no other
    /// thread may do.
    ///
    /// The two are one method because they share the expensive part. Finding
    /// the player is three pointer reads and a position read, none of which can
    /// be cached across frames — the chain goes null between realms — and doing
    /// it once per *action* rather than once per frame doubled it for no answer
    /// that differed.
    void Apply(std::uint64_t now_ms);

  private:
    /// Published by the IPC thread, read by the frame that walks towards it.
    Snapshot<MoveTarget> move_target_;
    Snapshot<AimTarget> aim_target_;

    /// Asks the game to walk. Bound on the IPC thread, called on the game's.
    game::PlayerMover mover_;
    /// Points the player's own shots. Installed on the IPC thread, told where
    /// to aim by the frame, and called by the game inside its own shot path.
    ///
    /// Whoever owns this must be destroyed before MinHook is torn down, which
    /// declaration order in that owner is what guarantees.
    game::AimHook aim_;
    /// Set by a record on the IPC thread, read by the same thread's loop.
    bool aim_wanted_ = false;

    /// The walk to the player, and the runtime it belongs to. Written once
    /// before `ready_` is released, and read by every frame after.
    const game::Il2CppRuntime* game_ = nullptr;
    game::PlayerRoute route_{};
    std::atomic<bool> ready_{false};

    /// The frame's own copies, and how far it has caught up. Render thread
    /// only, so they need no protection of their own.
    MoveTarget frame_target_;
    std::uint64_t frame_target_version_ = 0;
    /// Where this frame actually stepped towards, once the offset — if it was
    /// one — has been measured from the player. See {@link WalkTarget}.
    bool frame_walking_ = false;
    float frame_walk_x_ = 0.0F;
    float frame_walk_y_ = 0.0F;
    AimTarget frame_aim_;
    std::uint64_t frame_aim_version_ = 0;
    /// Where the player was when the last frame acted, and what this module
    /// asked the game to add to it — the two together are what the next frame
    /// subtracts to be left with the walking they did themselves. False
    /// whenever the position was not read, because a delta measured across
    /// frames nobody looked at is not one frame's worth of anything.
    bool player_seen_ = false;
    float last_player_x_ = 0.0F;
    float last_player_y_ = 0.0F;
    float last_step_x_ = 0.0F;
    float last_step_y_ = 0.0F;
    /// When the last frame ran, for sizing this one's step. Zero until the
    /// first, which therefore issues nothing — a step needs two frames.
    std::uint64_t last_frame_at_ms_ = 0;
};

}  // namespace brownie::app
