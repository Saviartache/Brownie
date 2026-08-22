#include "game/PlayerNoclip.h"

#include <utility>

namespace brownie::game {
namespace {

/// A walkability predicate, as the compiler generated it.
///
/// IL2CPP gives every managed method a trailing `MethodInfo*`; an instance
/// method reached through its entry point does not use it, and a detour forwards
/// whatever it was handed. The calling convention is the platform default on
/// x64, where the two floats travel in registers of their own.
using WalkableFn = bool (*)(void* self, float x, float y, void* method_info);

/// The one player noclip in this process. See `AimHook.cpp` for why a detour
/// has nowhere else to keep this.
PlayerNoclip* g_noclip = nullptr;

/// One detour per index, because a detour is a bare C function and the index is
/// the only thing that tells it which predicate it is standing in front of.
template <std::size_t Index>
bool WalkableDetour(void* self, float x, float y, void* method_info) {
    PlayerNoclip* hook = g_noclip;
    if (hook == nullptr) {
        // The detour outlived its owner, which `Remove` makes impossible on any
        // path it controls — but the check costs a comparison and the
        // alternative is a jump through a null trampoline.
        return false;
    }
    void* const original = hook->original(Index);
    if (original == nullptr) {
        return false;
    }
    if (hook->Override()) {
        return true;
    }
    return reinterpret_cast<WalkableFn>(original)(self, x, y, method_info);
}

template <std::size_t... Index>
constexpr std::array<void*, PlayerNoclip::kMaxGates> MakeDetours(
    std::index_sequence<Index...> /*indices*/) {
    return {reinterpret_cast<void*>(&WalkableDetour<Index>)...};
}

/// The detours, one per slot, built at compile time. A table rather than a
/// switch: the address of each is what MinHook is given.
const std::array<void*, PlayerNoclip::kMaxGates> kDetours =
    MakeDetours(std::make_index_sequence<PlayerNoclip::kMaxGates>{});

}  // namespace

PlayerNoclip::~PlayerNoclip() {
    Remove();
}

Status PlayerNoclip::InstallOne(std::size_t index, void* target) {
    if (target == nullptr) {
        return Error{ErrorCode::kNotReady, "that predicate has not been resolved yet"};
    }

    auto created = hooks::Hook::Create(target, kDetours[index]);
    if (!created.ok()) {
        return created.error();
    }
    hooks_[index] = std::move(created).value();

    // The trampoline and the owner are published before the detour is enabled,
    // because the client can ask the instant it is — and a detour whose original
    // is still null answers "no" to every question the game has.
    originals_[index] = hooks_[index].original<void*>();
    g_noclip = this;

    if (auto enabled = hooks_[index].Enable(); !enabled.ok()) {
        hooks_[index] = hooks::Hook{};
        originals_[index] = nullptr;
        return enabled.error();
    }
    return {};
}

Status PlayerNoclip::Install(std::span<const WalkabilityPredicate> predicates) {
    if (g_noclip != nullptr && g_noclip != this) {
        return Error{ErrorCode::kInvalidArgument, "another player noclip is already installed"};
    }
    if (hooked_ != 0) {
        // Already in. Asking again is the loop retrying, not a second set.
        return {};
    }
    if (predicates.empty()) {
        return Error{ErrorCode::kNotReady, "no walkability predicate has resolved yet"};
    }
    if (predicates.size() > kMaxGates) {
        return Error{ErrorCode::kInvalidArgument, "more predicates than there are detours"};
    }

    // Each is attempted whatever the others did, and none is a promise about
    // another: there is no state shared between them to leave half-written.
    std::size_t installed = 0;
    for (std::size_t index = 0; index < predicates.size(); ++index) {
        if (InstallOne(index, predicates[index].address).ok()) {
            ++installed;
        }
    }

    if (installed == 0) {
        return Error{ErrorCode::kNotReady, "no predicate could be detoured"};
    }
    // Last, and it is what the detours' index bound is read against — every
    // slot below it is written before this is.
    hooked_ = predicates.size();
    return {};
}

void PlayerNoclip::Remove() noexcept {
    // Switched off first: a call already inside a detour must find a feature
    // that wants nothing rather than an object being taken apart.
    enabled_.store(false, std::memory_order_relaxed);

    // Removing a hook suspends every other thread and fixes up any instruction
    // pointer inside the code it is replacing, so once these return no further
    // detour can begin.
    for (std::size_t index = 0; index < kMaxGates; ++index) {
        hooks_[index] = hooks::Hook{};
        originals_[index] = nullptr;
    }
    hooked_ = 0;
    if (g_noclip == this) {
        g_noclip = nullptr;
    }
}

void* PlayerNoclip::original(std::size_t index) const noexcept {
    return index < kMaxGates ? originals_[index] : nullptr;
}

bool PlayerNoclip::Override() noexcept {
    if (!enabled_.load(std::memory_order_relaxed)) {
        return false;
    }
    allowed_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

}  // namespace brownie::game
