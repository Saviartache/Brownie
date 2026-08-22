#include "game/HealthBarTint.h"

namespace brownie::game {
namespace {

/// `void Graphic::set_color(Color value)`, as the compiler generated it.
///
/// The colour travels by pointer: sixteen bytes is past what the platform's
/// calling convention passes in a register, so the caller builds one and hands
/// over its address. That is what lets a detour substitute a colour at all —
/// and it is also why the substitution is made into a copy of our own rather
/// than into the caller's storage, which belongs to the caller.
using SetColorFn = void (*)(void* self, UiColor* value, void* method_info);

/// The one tint in this process.
///
/// File-level state, which this project otherwise refuses — justified for the
/// same reason `AimHook`'s is: a detour is a C callback with nowhere to carry a
/// `this`. `Install` refuses a second, so which one this refers to is never a
/// question.
HealthBarTint* g_tint = nullptr;

void SetColorDetour(void* self, UiColor* value, void* method_info) {
    HealthBarTint* tint = g_tint;
    if (tint == nullptr || tint->original() == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls — but the check costs a comparison and the
        // alternative is a jump through a null trampoline.
        return;
    }

    // The commonest call by far: some other element of the game's UI being
    // painted, which this must forward exactly as it arrived.
    if (!tint->Wants(self)) {
        reinterpret_cast<SetColorFn>(tint->original())(self, value, method_info);
        return;
    }

    UiColor substituted = tint->colour();
    reinterpret_cast<SetColorFn>(tint->original())(self, &substituted, method_info);
}

}  // namespace

HealthBarTint::~HealthBarTint() {
    Remove();
}

Status HealthBarTint::Install(void* set_color) {
    if (g_tint != nullptr && g_tint != this) {
        return Error{ErrorCode::kInvalidArgument, "another health bar tint is already installed"};
    }
    if (hook_.installed()) {
        return {};
    }
    if (set_color == nullptr) {
        return Error{ErrorCode::kNotReady, "set_color has not been resolved yet"};
    }

    auto created = hooks::Hook::Create(set_color, reinterpret_cast<void*>(&SetColorDetour));
    if (!created.ok()) {
        return created.error();
    }
    hook_ = std::move(created).value();

    // The trampoline and the owner are published before the detour is enabled,
    // because the game can paint an element the instant it is — and a detour
    // whose original is still null would jump into nothing.
    original_ = hook_.original<void*>();
    g_tint = this;

    if (auto enabled = hook_.Enable(); !enabled.ok()) {
        hook_ = hooks::Hook{};
        original_ = nullptr;
        g_tint = nullptr;
        return enabled.error();
    }
    return {};
}

void HealthBarTint::Remove() noexcept {
    // Forget first: a call already inside the detour must find nothing to
    // substitute rather than an object being taken apart.
    Forget();

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it is replacing, so once this returns no further
    // detour can begin.
    hook_ = hooks::Hook{};
    original_ = nullptr;
    if (g_tint == this) {
        g_tint = nullptr;
    }
}

void HealthBarTint::Paint() const {
    void* const element = target_.load(std::memory_order_acquire);
    if (element == nullptr || original_ == nullptr) {
        return;
    }
    UiColor painted = colour();
    // Through the trampoline rather than the detour: the detour would only
    // substitute the colour this already is, and calling into a hook from
    // outside it is a loop waiting for the day the two disagree.
    reinterpret_cast<SetColorFn>(original_)(element, &painted, nullptr);
}

bool HealthBarTint::Wants(const void* self) noexcept {
    if (self == nullptr || self != target_.load(std::memory_order_acquire)) {
        return false;
    }
    tinted_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

}  // namespace brownie::game
