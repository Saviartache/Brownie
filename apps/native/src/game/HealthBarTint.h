// The health bar's fill, held at one colour.
//
// **A sign that the module is running, drawn where the operator is already
// looking.** The bar the game draws for the local player changes colour with
// what is left of it; this holds one node of it at a colour the operator picks,
// so a glance at the top-left says whether the module is attached and acting
// without opening the overlay. HPBarMod did exactly this and hard-coded its
// cyan; here that colour is only the default. Nothing else about the bar is
// touched — not its length, not what it reads, not what the server is told.
//
// **The hook is what makes it stick.** Setting the colour once lasts until the
// next time the game sets it, which is the next time the player's health
// changes. So the module detours the setter every coloured UI element goes
// through and substitutes the colour for *one* object — the fill it found — and
// leaves every other element in the game alone.
//
// That is the whole of the mechanism, and it is deliberately the least
// invasive one available: no draw call is intercepted, no material is replaced,
// and if the detour never goes in the bar simply looks the way it always did.

#pragma once

#include <atomic>
#include <cstdint>

#include "core/Result.h"
#include "game/UnityColor.h"
#include "hooks/Hook.h"

namespace brownie::game {

class HealthBarTint {
  public:
    /// The colour until somebody chooses another: HPBarMod's own cyan, which
    /// nothing in this game's palette is near, so a tinted bar is unmistakable.
    static constexpr UiColor kDefaultColour{0.0F, 0.722F, 0.886F, 1.0F};

    HealthBarTint() noexcept = default;

    HealthBarTint(const HealthBarTint&) = delete;
    HealthBarTint& operator=(const HealthBarTint&) = delete;
    HealthBarTint(HealthBarTint&&) = delete;
    HealthBarTint& operator=(HealthBarTint&&) = delete;

    /// Removes the detour. An unload arrives at a moment the module does not
    /// choose, so teardown is a scope exit rather than a step to remember.
    ~HealthBarTint();

    /// Detours `UnityEngine.UI.Graphic::set_color`. **IPC thread.**
    ///
    /// Only one may exist per process: a detour is a C callback with nowhere to
    /// carry a `this`, so which object it belongs to is file-level state and a
    /// second one would make that a question.
    ///
    /// Installing does nothing on its own — with no object watched, the detour
    /// forwards every call unchanged.
    Status Install(void* set_color);

    /// Removes it. Safe to call more than once, and from any thread.
    void Remove() noexcept;

    [[nodiscard]] bool installed() const noexcept { return hook_.installed(); }

    /// The colour to hold the watched element at. Any thread.
    ///
    /// Takes effect on the next call the game makes for that element; `Paint`
    /// is how it is made to appear now.
    void SetColour(const UiColor& colour) noexcept {
        colour_.store(PackColour(colour), std::memory_order_relaxed);
    }

    [[nodiscard]] UiColor colour() const noexcept {
        return UnpackColour(colour_.load(std::memory_order_relaxed));
    }

    /// The element to hold at {@link colour}, or null for none. Any thread.
    ///
    /// One object, not a set: the module is looking for one node of one bar,
    /// and a detour that searched a list would be doing that search inside
    /// somebody else's frame.
    void Watch(void* element) noexcept { target_.store(element, std::memory_order_release); }

    /// Stops substituting. The element goes back to whatever the game next
    /// paints it.
    void Forget() noexcept { target_.store(nullptr, std::memory_order_release); }

    [[nodiscard]] void* watched() const noexcept { return target_.load(std::memory_order_acquire); }

    /// Paints the watched element now, through the code the detour replaced.
    /// **Game thread only.**
    ///
    /// Without this the colour would not appear until the game next set it,
    /// which is the next time the player's health changes — so a bar found
    /// while standing still would stay untinted for as long as nothing
    /// happened.
    void Paint() const;

    /// How many calls have been substituted, for the overlay to show. Written
    /// by the game's thread, read by any.
    [[nodiscard]] std::uint32_t tinted() const noexcept {
        return tinted_.load(std::memory_order_relaxed);
    }

    // --- Called only by the detour in HealthBarTint.cpp. Public because a free
    // --- function cannot be a friend of a class it does not know about.

    /// Whether this call is for the watched element, counted if it is.
    [[nodiscard]] bool Wants(const void* self) noexcept;

    /// The code the detour replaced. Null until installed, which a detour that
    /// is not installed cannot observe.
    [[nodiscard]] void* original() const noexcept { return original_; }

  private:
    hooks::Hook hook_;
    void* original_ = nullptr;
    std::atomic<void*> target_{nullptr};
    std::atomic<std::uint32_t> colour_{PackColour(kDefaultColour)};
    std::atomic<std::uint32_t> tinted_{0};
};

}  // namespace brownie::game
