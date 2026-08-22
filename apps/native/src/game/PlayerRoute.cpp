#include "game/PlayerRoute.h"

#include <Windows.h>

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

void* FindPlayer(const Il2CppRuntime& game, const PlayerRoute& route) noexcept {
    void* manager = game.ReadStaticReference(route.singleton);
    if (manager == nullptr) {
        return nullptr;
    }
    void* world = nullptr;
    if (!ReadField(manager, route.world_manager_at, world) || world == nullptr) {
        return nullptr;
    }
    void* player = nullptr;
    if (!ReadField(world, route.local_player_at, player)) {
        return nullptr;
    }
    return player;
}

bool ReadPosition(const void* player, const PlayerRoute& route, float& x, float& y) noexcept {
    // Both at once when they are neighbours, which in every build seen so far
    // they are: `x` at 0x3C and `y` at 0x40. One system call rather than two,
    // on a path that runs every frame for as long as a feature is acting.
    if (route.y_at == route.x_at + sizeof(float)) {
        float both[2]{};
        if (!ReadField(player, route.x_at, both)) {
            return false;
        }
        x = both[0];
        y = both[1];
        return true;
    }
    // Not neighbours in this build. Two reads, rather than an assumption about
    // a layout the game is free to change.
    return ReadField(player, route.x_at, x) && ReadField(player, route.y_at, y);
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
