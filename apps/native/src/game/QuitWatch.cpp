#include "game/QuitWatch.h"

namespace brownie::game {
namespace {

/// `void Application::Quit()`, as the compiler generated it. Static, so the
/// trailing `MethodInfo*` is its only argument.
using QuitFn = void (*)(void* method_info);

/// The one quit watch in this process. See the note in `AimHook.cpp` about why
/// a detour's owner is file-level state.
QuitWatch* g_watch = nullptr;

void QuitDetour(void* method_info) {
    QuitWatch* watch = g_watch;
    if (watch == nullptr || watch->original() == nullptr) {
        return;
    }
    // The flag first. Whatever the original does — Unity's own `Quit` may not
    // return at all on some platforms — the module has already been told.
    watch->Notice();
    reinterpret_cast<QuitFn>(watch->original())(method_info);
}

}  // namespace

QuitWatch::~QuitWatch() {
    Remove();
}

Status QuitWatch::Install(void* quit) {
    if (g_watch != nullptr && g_watch != this) {
        return Error{ErrorCode::kInvalidArgument, "another quit watch is already installed"};
    }
    if (hook_.installed()) {
        return {};
    }
    if (quit == nullptr) {
        return Error{ErrorCode::kNotReady, "Application.Quit has not been resolved yet"};
    }

    auto created = hooks::Hook::Create(quit, reinterpret_cast<void*>(&QuitDetour));
    if (!created.ok()) {
        return created.error();
    }
    hook_ = std::move(created).value();

    original_ = hook_.original<void*>();
    g_watch = this;

    if (auto enabled = hook_.Enable(); !enabled.ok()) {
        hook_ = hooks::Hook{};
        original_ = nullptr;
        g_watch = nullptr;
        return enabled.error();
    }
    return {};
}

void QuitWatch::Remove() noexcept {
    hook_ = hooks::Hook{};
    original_ = nullptr;
    if (g_watch == this) {
        g_watch = nullptr;
    }
    // `quitting_` is deliberately left set. The game asked, and taking the
    // detour out does not unask it.
}

}  // namespace brownie::game
