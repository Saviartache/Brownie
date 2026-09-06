#include "game/PlayerRoute.h"

#include <Windows.h>

#include <cmath>

namespace brownie::game {

bool ReadRaw(const void* address, void* out, std::size_t size) noexcept {
    SIZE_T read = 0;
    if (::ReadProcessMemory(::GetCurrentProcess(), address, out, size, &read) == 0) {
        return false;
    }
    return read == size;
}

bool WriteRaw(void* address, const void* value, std::size_t size) noexcept {
    SIZE_T written = 0;
    if (::WriteProcessMemory(::GetCurrentProcess(), address, value, size, &written) == 0) {
        return false;
    }
    return written == size;
}

void* FindWorldManager(const Il2CppRuntime& game, const PlayerRoute& route) noexcept {
    void* manager = game.ReadStaticReference(route.singleton);
    if (manager == nullptr) {
        return nullptr;
    }
    void* world = nullptr;
    if (!ReadField(manager, route.world_manager_at, world)) {
        return nullptr;
    }
    return world;
}

void* FindPlayer(const Il2CppRuntime& game, const PlayerRoute& route) noexcept {
    void* world = FindWorldManager(game, route);
    if (world == nullptr) {
        return nullptr;
    }
    void* player = nullptr;
    if (!ReadField(world, route.local_player_at, player)) {
        return nullptr;
    }
    return player;
}

bool ReadPosition(const void* player, const PlayerRoute& route, float& x, float& y) noexcept {
    float read_x = 0.0F;
    float read_y = 0.0F;
    // Both at once when they are neighbours, which in every build seen so far
    // they are: `x` at 0x3C and `y` at 0x40. One system call rather than two,
    // on a path that runs every frame for as long as a feature is acting.
    if (route.y_at == route.x_at + sizeof(float)) {
        float both[2]{};
        if (!ReadField(player, route.x_at, both)) {
            return false;
        }
        read_x = both[0];
        read_y = both[1];
    } else if (!ReadField(player, route.x_at, read_x) ||
               // Not neighbours in this build. Two reads, rather than an
               // assumption about a layout the game is free to change.
               !ReadField(player, route.y_at, read_y)) {
        return false;
    }

    // **A read that succeeded is not the same as a position.** An offset that
    // has moved, an object the collector has given back, a player half-built
    // during a realm change: every one of those reads *something*, and the
    // something is as likely to be a pattern of bytes that is not a number as
    // anything else. Everything downstream acts on this — one caller hands it
    // to the game as the place to walk to, another takes an angle from it — and
    // a coordinate that is not a number is not a smaller mistake there than a
    // wrong one, it is a shot fired at nowhere and a step commanded to it.
    if (!std::isfinite(read_x) || !std::isfinite(read_y)) {
        return false;
    }
    x = read_x;
    y = read_y;
    return true;
}

bool LocatePlayer(const Il2CppRuntime& game, const PlayerRoute& route,
                  PlayerLocation& out) noexcept {
    void* player = FindPlayer(game, route);
    if (player == nullptr) {
        return false;
    }
    float x = 0.0F;
    float y = 0.0F;
    if (!ReadPosition(player, route, x, y)) {
        return false;
    }
    // Assigned only once all of it succeeded: half a location is a location
    // somewhere else, and both of this file's callers are about to act on it.
    out.object = player;
    out.x = x;
    out.y = y;
    return true;
}

}  // namespace brownie::game
