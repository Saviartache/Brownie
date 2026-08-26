// The walk from a static field to the local player.
//
// Three classes need it and none of them owns it: the reader that samples the
// player's stats on the IPC thread, the mover that walks on the game's thread,
// and the aim that shoots on the same one. Writing it once means the three
// cannot come to disagree about which object "the player" is — which, when one
// of them is about to hand that pointer to the game as its own `this`, is not
// a tidiness argument.
//
// **The route is the answers about the game's *shape*, and nothing about its
// state.** Offsets and a static field handle are settled once and never change
// for the run; the pointers they lead to change constantly — the chain goes
// null between realms, on death and while a map is rebuilt — so they are walked
// afresh every time and never cached.

#pragma once

#include <cstddef>
#include <cstdint>

#include "game/Il2CppRuntime.h"

namespace brownie::game {

/// Copies `size` bytes from `address`, or reports that it could not.
///
/// **A read that cannot fault.** The pointer may already be freed, and a
/// dereference of one would take the game down with us. This returns false
/// where a dereference would crash, which is the whole reason it is a syscall
/// rather than a `memcpy`.
[[nodiscard]] bool ReadRaw(const void* address, void* out, std::size_t size) noexcept;

/// One value at an offset from a base pointer. Same guarantee as `ReadRaw`.
template <typename T>
[[nodiscard]] bool ReadField(const void* base, std::uint32_t offset, T& out) noexcept {
    if (base == nullptr) {
        return false;
    }
    return ReadRaw(static_cast<const std::byte*>(base) + offset, &out, sizeof(T));
}

/// Puts `size` bytes at `address`, or reports that it could not.
///
/// **The write counterpart of `ReadRaw`, and it is a syscall for the same
/// reason.** The pointer came out of the game's own memory and may already be
/// freed; a store through one of those corrupts whatever now lives there or
/// faults, and neither is survivable in someone else's process. This fails
/// instead.
///
/// Nothing here makes memory writable: a managed object's storage already is,
/// and a page that is not is a pointer that is not what the caller thinks.
[[nodiscard]] bool WriteRaw(void* address, const void* value, std::size_t size) noexcept;

/// One value at an offset from a base pointer. Same guarantee as `WriteRaw`.
template <typename T>
[[nodiscard]] bool WriteField(void* base, std::uint32_t offset, const T& value) noexcept {
    if (base == nullptr) {
        return false;
    }
    return WriteRaw(static_cast<std::byte*>(base) + offset, &value, sizeof(T));
}

/// Where the player is reached from, and where it keeps its position.
struct PlayerRoute {
    /// The static field holding the `ApplicationManager` singleton.
    Il2CppRuntime::StaticFieldRef singleton = nullptr;
    std::uint32_t world_manager_at = 0;
    std::uint32_t local_player_at = 0;
    /// The player's own coordinates, which every step and every angle is
    /// measured from.
    std::uint32_t x_at = 0;
    std::uint32_t y_at = 0;
};

/// The live world manager, or null when there is not one right now.
///
/// The first two hops of the walk, which is as far as anything that wants the
/// map rather than the player needs to go. See `MapObjects.h`.
[[nodiscard]] void* FindWorldManager(const Il2CppRuntime& game,
                                     const PlayerRoute& route) noexcept;

/// The live player object, or null when there is not one right now.
///
/// Between realms, at the login screen and during a map rebuild there is no
/// player, and that is ordinary rather than a failure — every caller treats a
/// null the same way it treats "nothing to do this frame".
[[nodiscard]] void* FindPlayer(const Il2CppRuntime& game, const PlayerRoute& route) noexcept;

/// The player object and where it is, which is what acting on it needs.
struct PlayerLocation {
    void* object = nullptr;
    float x = 0.0F;
    float y = 0.0F;
};

/// Finds the player and reads its position. **Four reads, and it is four for a
/// reason.**
///
/// Three are the hops, which cannot be collapsed — each address comes out of
/// the read before it. The fourth is both coordinates at once: they are
/// adjacent floats in the object, so asking for eight bytes answers both, and
/// asking twice would be one system call per frame spent on arithmetic already
/// in hand. Non-adjacent coordinates fall back to two reads rather than
/// assuming a layout, because the offsets come from the game and the game is
/// free to change them.
///
/// Everything that acts on the player in a frame goes through one of these, so
/// the walk is paid once however many features are running.
[[nodiscard]] bool LocatePlayer(const Il2CppRuntime& game, const PlayerRoute& route,
                                PlayerLocation& out) noexcept;

/// The player's position, read out of the object the caller already found.
[[nodiscard]] bool ReadPosition(const void* player, const PlayerRoute& route, float& x,
                                float& y) noexcept;

}  // namespace brownie::game
