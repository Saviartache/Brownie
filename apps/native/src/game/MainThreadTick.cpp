#include "game/MainThreadTick.h"

#include <utility>

namespace brownie::game {
namespace {

/// `void InputManager.Update()`, as the compiler generated it: the instance and
/// IL2CPP's trailing `MethodInfo*`.
using UpdateFn = void (*)(void* self, void* method_info);

/// The one main-thread tick in this process. See the note in `AimHook.cpp`
/// about why a detour's owner is file-level state.
MainThreadTick* g_tick = nullptr;

void InputUpdateDetour(void* self, void* method_info) {
    MainThreadTick* tick = g_tick;
    if (tick == nullptr || tick->original() == nullptr) {
        // Unreachable on any path `Remove` controls; the game's own input for
        // the frame is lost rather than jumped into nothing.
        return;
    }
    // Ours first — see the header for why the order matters.
    tick->Tick();
    reinterpret_cast<UpdateFn>(tick->original())(self, method_info);
}

}  // namespace

MainThreadTick::~MainThreadTick() {
    Remove();
}

Status MainThreadTick::Install(void* input_update, TickFn tick) {
    if (hook_.installed()) {
        return {};
    }
    if (g_tick != nullptr && g_tick != this) {
        return Error{ErrorCode::kInvalidArgument, "another main-thread tick is already installed"};
    }
    if (input_update == nullptr) {
        return Error{ErrorCode::kNotReady, "InputManager.Update has not been resolved yet"};
    }
    if (!tick) {
        return Error{ErrorCode::kInvalidArgument, "a tick needs something to do"};
    }

    auto created = hooks::Hook::Create(input_update, reinterpret_cast<void*>(&InputUpdateDetour));
    if (!created.ok()) {
        return created.error();
    }
    hook_ = std::move(created).value();

    // Everything the detour reads is in place before it is enabled: the game's
    // main thread can be inside it the instant it is.
    tick_ = std::move(tick);
    original_ = hook_.original<void*>();
    g_tick = this;

    if (auto enabled = hook_.Enable(); !enabled.ok()) {
        hook_ = hooks::Hook{};
        original_ = nullptr;
        g_tick = nullptr;
        tick_ = nullptr;
        return enabled.error();
    }
    return {};
}

void MainThreadTick::Remove() noexcept {
    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it replaced, so once this returns no further
    // detour can begin.
    hook_ = hooks::Hook{};
    original_ = nullptr;
    if (g_tick == this) {
        g_tick = nullptr;
    }
}

}  // namespace brownie::game
