// The overlay: ImGui, drawn inside the game's own frame.
//
// Drawing happens in the `IDXGISwapChain::Present` detour, because that is the
// one moment per frame when the game's device, context and back buffer are all
// valid and nothing else is using them.
//
// **Threading, stated once.** Everything ImGui is touched from the render
// thread and nowhere else — see `InputQueue.h` for why and for how the window
// procedure hands input over. Anything another thread wants shown reaches the
// overlay as a snapshot it publishes; the overlay never reaches back.
//
// **Styling: stock ImGui, deliberately.** No theme is applied, no colour is set,
// no font is loaded. A custom widget, when one is needed, draws with colours
// from `ImGui::GetStyleColorVec4` and metrics from `ImGui::GetStyle` so that it
// inherits whatever theme is active instead of drifting from everything around
// it. Layout — padding, spacing, widths, window flags — is fair game; colour is
// not.

#pragma once

#include <array>
#include <atomic>
#include <functional>
#include <memory>

#include <Windows.h>

#include "core/Result.h"
#include "hooks/Hook.h"
#include "overlay/InputQueue.h"

namespace brownie::overlay {

/// Called once per frame on the render thread, between `NewFrame` and `Render`.
using DrawFn = std::function<void()>;

class Overlay {
  public:
    /// Declared here, defined in the translation unit that knows what
    /// `Renderer` is — a defaulted constructor in the header would have to be
    /// able to destroy an incomplete type.
    Overlay() noexcept;

    Overlay(const Overlay&) = delete;
    Overlay& operator=(const Overlay&) = delete;
    Overlay(Overlay&&) = delete;
    Overlay& operator=(Overlay&&) = delete;

    /// Removes everything it installed. An unload arrives at a moment the
    /// module does not choose, so teardown is a scope exit rather than a step
    /// somebody has to remember.
    ~Overlay();

    /// Installs the `Present` detour.
    ///
    /// ImGui itself is not created here: it needs the device, and the device
    /// comes from the swap chain the game passes to `Present`. So the first
    /// frame does the rest, on the thread that is allowed to.
    ///
    /// Only one overlay may exist per process — the detour is a C callback with
    /// nowhere to carry a `this` — and a second `Install` is refused rather
    /// than quietly replacing the first.
    Status Install(DrawFn draw);

    /// Removes the detour, the window subclass and ImGui, in that order.
    ///
    /// Safe to call more than once and from any thread. Ordering is the point:
    /// the detour goes first, so no frame can start while the rest is being
    /// taken apart.
    void Shutdown() noexcept;

    /// Whether the overlay accepts input.
    ///
    /// When false the game sees every message. When true, ImGui gets first
    /// refusal and anything it wants is swallowed.
    void SetVisible(bool visible) noexcept {
        visible_.store(visible, std::memory_order_release);
    }

    [[nodiscard]] bool visible() const noexcept {
        return visible_.load(std::memory_order_acquire);
    }

    /// The key that shows and hides the overlay, as a virtual-key code.
    ///
    /// Policy that lives here rather than in the caller because it is about the
    /// overlay's own visibility, and because the press must be swallowed — a
    /// key that both opens a window and does whatever the game bound it to is a
    /// key nobody wants to press.
    void SetToggleKey(int virtual_key) noexcept {
        toggle_key_.store(virtual_key, std::memory_order_release);
    }

    /// True once a frame has been drawn — that is, once the device was found
    /// and ImGui came up. Until then the overlay is installed but blind.
    [[nodiscard]] bool ready() const noexcept { return ready_.load(std::memory_order_acquire); }

    /// How many pixels the game renders, which is not always how many the
    /// window is wide: a resolution setting, a scaled presentation or a
    /// high-density display puts the two apart. Zero before the first frame.
    ///
    /// **Read off the back buffer every frame**, because it changes with the
    /// window and nothing here hooks `ResizeBuffers`. **Render thread**, like
    /// the window below it.
    [[nodiscard]] std::uint32_t render_width() const noexcept { return render_width_; }
    [[nodiscard]] std::uint32_t render_height() const noexcept { return render_height_; }

    /// The window the game draws into, or null before the first frame.
    ///
    /// Handed out because the overlay is what found it — it comes off the swap
    /// chain — and because anything measuring the mouse has to measure it
    /// against the same window. **Render thread**: it is written by the frame
    /// that brings ImGui up and read by the frames after it.
    [[nodiscard]] HWND window() const noexcept { return window_; }

    /// Input messages lost to a full queue since this was last asked. Nonzero
    /// means the render thread stalled for long enough to matter.
    [[nodiscard]] std::uint32_t TakeDroppedInput() noexcept { return input_.TakeDropped(); }

    // --- Called only by the detours in Overlay.cpp. Public because a free
    // --- function cannot be a friend of a class it does not know about.

    void OnPresent(void* swap_chain) noexcept;
    [[nodiscard]] bool OnWindowMessage(UINT message, WPARAM wparam, LPARAM lparam) noexcept;

  private:
    struct Renderer;

    Status Begin(void* swap_chain) noexcept;
    void DrainInput() noexcept;

    DrawFn draw_;
    hooks::Hook present_;

    /// Device and immediate context, held only while a frame can happen.
    /// Behind a pointer so the header does not drag Direct3D into everything
    /// that merely wants to start an overlay.
    std::unique_ptr<Renderer> renderer_;

    /// The back buffer's size as of the last frame drawn. Render thread only.
    std::uint32_t render_width_ = 0;
    std::uint32_t render_height_ = 0;

    /// Replaced window procedure, restored on teardown.
    HWND window_ = nullptr;
    WNDPROC original_wndproc_ = nullptr;

    InputQueue input_;
    /// Scratch for the drain, owned rather than static so there is nothing
    /// process-wide to reason about.
    std::array<InputMessage, InputQueue::kCapacity> drained_{};

    /// Published by the render thread, read by the window thread. One frame
    /// stale by construction — see `InputQueue.h`.
    std::atomic<int> toggle_key_{VK_INSERT};
    std::atomic<bool> visible_{false};
    std::atomic<bool> wants_mouse_{false};
    std::atomic<bool> wants_keyboard_{false};
    std::atomic<bool> ready_{false};

    /// Guards teardown against a frame that is already running.
    ///
    /// Removing the detour stops new frames — MinHook suspends threads and
    /// fixes up their instruction pointers, so nobody is left executing the
    /// code being removed — but a frame that got past the check is still inside
    /// *this object*. Teardown waits for the count to fall to zero before it
    /// takes anything apart.
    std::atomic<bool> shutting_down_{false};
    std::atomic<std::uint32_t> frames_in_flight_{0};

    /// Touched only by the render thread.
    bool started_ = false;
    unsigned begin_attempts_ = 0;
};

}  // namespace brownie::overlay
