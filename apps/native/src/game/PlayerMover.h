// Asking the game to walk somewhere.
//
// **The first thing this module calls rather than reads, and the difference
// matters.** A read of stale memory returns nonsense; a *call* into managed
// code from a thread the runtime does not expect corrupts the runtime. So the
// rule is in the types here rather than in a comment somewhere: `Bind` is the
// IPC thread's, `StepTowards` is the game's own thread's, and nothing else is.
//
// `StepTowards` therefore runs from inside the `Present` detour, which is the
// game's render thread — already attached to the garbage collector, already the
// thread the game itself calls this method on.
//
// **Why a call and not a write.** Movement could be applied by writing a
// position into the object, and the reference implementation tried exactly that
// and recorded the result: "the old raw-write teleport caused anti-cheat
// issues; this doesn't." A position the client never agreed to is one the
// server sees appear from nowhere. Going through the game's own method means
// the client walks, renders and reports itself as it would have anyway — and
// the game clamps the step to the speed it allows, so nothing here can move
// faster than the character could.
//
// **Why not a packet.** The client sends its own `MOVE` every tick from its own
// idea of where it is. An injected one is contradicted by the next; rewriting
// every outgoing one puts the client and the server in different places, which
// is worse than not moving at all.
//
// **It does not find the player.** The caller does, once per frame, and hands
// the result to everything that acts — see `LocatePlayer`. Walking the chain
// here as well would be a second set of system calls for an answer already in
// hand, and a second chance for two features to act on two different objects.

#pragma once

#include <atomic>

#include "game/PlayerRoute.h"

namespace brownie::game {

class PlayerMover {
  public:
    /// Publishes the game's `bool MoveTo(float, float)`. **IPC thread.**
    ///
    /// Write-once: the pointer is written before the flag that makes it
    /// visible, and never written again. That is what lets the render thread
    /// read it without a lock — and a lock is exactly what must not be taken
    /// inside a frame.
    void Bind(void* move_to) noexcept;

    [[nodiscard]] bool bound() const noexcept { return ready_.load(std::memory_order_acquire); }

    /// Walks one frame's worth towards a target. **Game thread only.**
    ///
    /// **The step is clamped to what the player could actually travel**, and
    /// that is the whole of why this is not a single call with the destination.
    /// The reference implementation states the consequence outright:
    /// "never command farther than the player can actually travel this frame —
    /// commanding past reach is what the server snaps back." Handing the game a
    /// point several tiles away does not make the player walk there; it makes
    /// them appear there, and then not.
    ///
    /// Called every frame while a target stands, because a walk is a sequence
    /// of small steps and one large one is a teleport wearing its clothes.
    ///
    /// @param player Where the player is and what it is, found once this frame.
    /// @param maxDistance How far this frame may carry, in tiles — the speed
    ///   the runtime derived from the character's stat, times the time since
    ///   the last frame.
    /// @returns whether a step was issued. False when nothing is bound, and
    ///   when the target is already reached.
    [[nodiscard]] bool StepTowards(const PlayerLocation& player, float targetX, float targetY,
                                   float maxDistance) const;

  private:
    void* move_to_ = nullptr;
    std::atomic<bool> ready_{false};
};

}  // namespace brownie::game
