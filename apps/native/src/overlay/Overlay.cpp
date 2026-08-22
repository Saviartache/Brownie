#include "overlay/Overlay.h"

#include <utility>

#include <d3d11.h>

#include <imgui.h>
#include <imgui_impl_dx11.h>
#include <imgui_impl_win32.h>

#include "core/ComHandle.h"
#include "hooks/SwapChain.h"

// The Win32 backend deliberately leaves this out of its header — it is inside an
// `#if 0` there — so that the header does not drag `<Windows.h>` in. Copying the
// declaration is what upstream tells callers to do.
extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hwnd, UINT message,
                                                             WPARAM wparam, LPARAM lparam);

namespace brownie::overlay {

struct Overlay::Renderer {
    ComHandle<ID3D11Device> device;
    ComHandle<ID3D11DeviceContext> context;
};

namespace {

using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);

/// The one overlay in this process.
///
/// File-level state, which this project otherwise refuses — justified because
/// `Present` and a window procedure are C callbacks with nowhere to carry a
/// `this`. The alternative is a thunk assembled at runtime, which is more
/// machinery than one process-wide instance is worth. `Install` refuses a
/// second overlay, so which one this refers to is never a question.
Overlay* g_overlay = nullptr;
PresentFn g_original_present = nullptr;
WNDPROC g_original_wndproc = nullptr;

/// How many times to try bringing ImGui up before giving up for good.
///
/// A device we could not obtain on the first frame we will probably not obtain
/// on the thousandth, and retrying forever is a per-frame cost in someone
/// else's process. A few attempts cover a genuinely half-initialised swap chain.
constexpr unsigned kMaxBeginAttempts = 3;

/// How long teardown waits for an in-flight frame, before proceeding anyway.
///
/// Bounded because at process exit the render thread may already have been
/// terminated mid-frame, leaving a count that will never fall. Hanging the
/// process to protect memory it is about to discard is the worse trade.
constexpr DWORD kDrainTimeoutMs = 100;

[[nodiscard]] bool IsMouseMessage(UINT message) noexcept {
    return (message >= WM_MOUSEFIRST && message <= WM_MOUSELAST) || message == WM_MOUSEHOVER ||
           message == WM_MOUSELEAVE || message == WM_NCMOUSEMOVE;
}

[[nodiscard]] bool IsKeyboardMessage(UINT message) noexcept {
    return (message >= WM_KEYFIRST && message <= WM_KEYLAST) || message == WM_SETFOCUS ||
           message == WM_KILLFOCUS;
}

HRESULT STDMETHODCALLTYPE PresentDetour(IDXGISwapChain* swap_chain, UINT sync, UINT flags) {
    if (g_overlay != nullptr) {
        g_overlay->OnPresent(swap_chain);
    }
    return g_original_present(swap_chain, sync, flags);
}

LRESULT CALLBACK WndProcDetour(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (g_overlay != nullptr && g_overlay->OnWindowMessage(message, wparam, lparam)) {
        // Swallowed: the overlay is visible and wants this input. Returning
        // without calling on is what stops a click on a button from also
        // firing the player's weapon.
        return TRUE;
    }
    return ::CallWindowProcW(g_original_wndproc, window, message, wparam, lparam);
}

}  // namespace

Overlay::Overlay() noexcept = default;

Overlay::~Overlay() { Shutdown(); }

Status Overlay::Install(DrawFn draw) {
    if (g_overlay != nullptr) {
        return Error{ErrorCode::kInvalidArgument, "an overlay is already installed"};
    }

    auto present = hooks::FindPresent();
    if (!present.ok()) {
        return present.error();
    }

    auto hook = hooks::Hook::Create(present.value(), reinterpret_cast<void*>(&PresentDetour));
    if (!hook.ok()) {
        return hook.error();
    }

    // A previous `Shutdown` left the stop flag raised, and it is what every
    // frame checks first. Without this an engine that was stopped and started
    // again would install successfully and then never draw — the worst shape of
    // bug, because nothing reports a failure.
    shutting_down_.store(false, std::memory_order_release);
    started_ = false;
    begin_attempts_ = 0;

    draw_ = std::move(draw);
    present_ = std::move(hook).value();
    g_original_present = present_.original<PresentFn>();

    // Published before enabling, not after: the first frame can arrive on
    // another thread the instant the detour goes live.
    g_overlay = this;

    if (auto enabled = present_.Enable(); !enabled.ok()) {
        g_overlay = nullptr;
        present_ = hooks::Hook{};
        return enabled.error();
    }
    return {};
}

void Overlay::Shutdown() noexcept {
    if (shutting_down_.exchange(true, std::memory_order_acq_rel)) {
        return;
    }

    // Detour first. MinHook suspends every other thread and fixes up any
    // instruction pointer inside the code it is removing, so once this returns
    // no new frame can begin.
    present_ = hooks::Hook{};
    g_original_present = nullptr;
    g_overlay = nullptr;

    // A frame that got past the check before the detour went away is still
    // inside this object. Wait for it, but not forever.
    const DWORD deadline = ::GetTickCount() + kDrainTimeoutMs;
    while (frames_in_flight_.load(std::memory_order_acquire) != 0 &&
           ::GetTickCount() < deadline) {
        ::Sleep(1);
    }

    if (window_ != nullptr && original_wndproc_ != nullptr) {
        ::SetWindowLongPtrW(window_, GWLP_WNDPROC,
                            reinterpret_cast<LONG_PTR>(original_wndproc_));
        window_ = nullptr;
        original_wndproc_ = nullptr;
        g_original_wndproc = nullptr;
    }

    if (started_ && ready_.load(std::memory_order_acquire)) {
        ImGui_ImplDX11_Shutdown();
        ImGui_ImplWin32_Shutdown();
        ImGui::DestroyContext();
    }
    ready_.store(false, std::memory_order_release);
    renderer_.reset();
    draw_ = nullptr;
}

Status Overlay::Begin(void* swap_chain_raw) noexcept {
    auto* swap_chain = static_cast<IDXGISwapChain*>(swap_chain_raw);

    ComHandle<ID3D11Device> device;
    if (FAILED(swap_chain->GetDevice(__uuidof(ID3D11Device),
                                     reinterpret_cast<void**>(device.put()))) ||
        !device.valid()) {
        return Error{ErrorCode::kUnsupported, "the swap chain is not backed by a D3D11 device"};
    }

    ComHandle<ID3D11DeviceContext> context;
    device->GetImmediateContext(context.put());
    if (!context.valid()) {
        return Error{ErrorCode::kInternal, "the device has no immediate context"};
    }

    DXGI_SWAP_CHAIN_DESC description{};
    if (FAILED(swap_chain->GetDesc(&description)) || description.OutputWindow == nullptr) {
        return Error{ErrorCode::kInternal, "the swap chain has no output window"};
    }

    IMGUI_CHECKVERSION();
    if (ImGui::CreateContext() == nullptr) {
        return Error{ErrorCode::kInternal, "ImGui refused to create a context"};
    }

    ImGuiIO& io = ImGui::GetIO();
    // No ini file. The working directory belongs to the game, and writing a
    // layout file into it is a side effect nobody asked for.
    io.IniFilename = nullptr;
    io.LogFilename = nullptr;

    // Nothing else. **Stock ImGui, deliberately** — no theme call, no colour,
    // no font. See the header for the rule and what it does allow.

    if (!ImGui_ImplWin32_Init(description.OutputWindow)) {
        ImGui::DestroyContext();
        return Error{ErrorCode::kInternal, "the Win32 backend refused to start"};
    }
    if (!ImGui_ImplDX11_Init(device.get(), context.get())) {
        ImGui_ImplWin32_Shutdown();
        ImGui::DestroyContext();
        return Error{ErrorCode::kInternal, "the D3D11 backend refused to start"};
    }

    // Subclassed last. A message arriving before the backends exist would be
    // queued for an ImGui that cannot yet be told about it.
    window_ = description.OutputWindow;
    original_wndproc_ = reinterpret_cast<WNDPROC>(
        ::SetWindowLongPtrW(window_, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&WndProcDetour)));
    if (original_wndproc_ == nullptr) {
        ImGui_ImplDX11_Shutdown();
        ImGui_ImplWin32_Shutdown();
        ImGui::DestroyContext();
        window_ = nullptr;
        return Error{ErrorCode::kIo, "the window procedure could not be replaced",
                     ::GetLastError()};
    }
    g_original_wndproc = original_wndproc_;

    renderer_ = std::make_unique<Renderer>();
    renderer_->device = std::move(device);
    renderer_->context = std::move(context);
    return {};
}

void Overlay::DrainInput() noexcept {
    const std::size_t count = input_.Drain(drained_);
    for (std::size_t i = 0; i < count; ++i) {
        const InputMessage& message = drained_[i];
        // The window procedure's work, done here instead — on the only thread
        // allowed inside ImGui.
        ImGui_ImplWin32_WndProcHandler(window_, message.message, message.wparam, message.lparam);
    }
}

void Overlay::OnPresent(void* swap_chain) noexcept {
    if (shutting_down_.load(std::memory_order_acquire)) {
        return;
    }
    frames_in_flight_.fetch_add(1, std::memory_order_acq_rel);
    if (shutting_down_.load(std::memory_order_acquire)) {
        // Teardown started between the two checks. Nothing has been touched
        // yet, so leaving is free.
        frames_in_flight_.fetch_sub(1, std::memory_order_acq_rel);
        return;
    }

    if (!started_) {
        if (auto begun = Begin(swap_chain); begun.ok()) {
            started_ = true;
            ready_.store(true, std::memory_order_release);
        } else if (++begin_attempts_ >= kMaxBeginAttempts) {
            // Installed but blind, for the rest of the process. Reported by
            // `ready()` remaining false rather than by trying forever.
            started_ = true;
        }
    }

    if (ready_.load(std::memory_order_acquire)) {
        // The render target is acquired *before* the frame begins. Failing
        // after `NewFrame` would leave ImGui inside a frame it never ends, and
        // the next one would assert.
        auto* chain = static_cast<IDXGISwapChain*>(swap_chain);
        ComHandle<ID3D11Texture2D> back_buffer;
        ComHandle<ID3D11RenderTargetView> target;

        // A view per frame, rather than a cached one plus a `ResizeBuffers`
        // hook to invalidate it. More allocation, fewer moving parts — and no
        // way for a stale view to survive into the frame after a resize, which
        // is the case a missed invalidation crashes on.
        const bool have_target =
            SUCCEEDED(chain->GetBuffer(0, __uuidof(ID3D11Texture2D),
                                       reinterpret_cast<void**>(back_buffer.put()))) &&
            back_buffer.valid() &&
            SUCCEEDED(renderer_->device->CreateRenderTargetView(back_buffer.get(), nullptr,
                                                                target.put())) &&
            target.valid();

        if (have_target) {
            // What the game actually renders into, taken from the buffer that
            // is about to be drawn on rather than from a description cached at
            // startup: it changes with the window and with any resolution
            // setting, and this is the one place it cannot be stale. Anything
            // converting between the game's pixels and the window's needs it —
            // see `Overlay::render_width`.
            D3D11_TEXTURE2D_DESC description{};
            back_buffer->GetDesc(&description);
            render_width_ = description.Width;
            render_height_ = description.Height;

            DrainInput();

            ImGui_ImplDX11_NewFrame();
            ImGui_ImplWin32_NewFrame();
            ImGui::NewFrame();
            if (draw_) {
                draw_();
            }
            ImGui::Render();

            ID3D11RenderTargetView* views[] = {target.get()};
            renderer_->context->OMSetRenderTargets(1, views, nullptr);
            ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());

            // Published for the window thread, which has to decide whether to
            // swallow a message without being able to ask ImGui.
            const ImGuiIO& io = ImGui::GetIO();
            wants_mouse_.store(io.WantCaptureMouse, std::memory_order_release);
            wants_keyboard_.store(io.WantCaptureKeyboard, std::memory_order_release);
        }
    }

    frames_in_flight_.fetch_sub(1, std::memory_order_acq_rel);
}

bool Overlay::OnWindowMessage(UINT message, WPARAM wparam, LPARAM lparam) noexcept {
    if (!ready_.load(std::memory_order_acquire)) {
        return false;
    }

    // The toggle is handled before anything else and never forwarded — neither
    // to the game, which would act on it, nor to ImGui, which would see a key
    // going down that never comes up.
    const int toggle = toggle_key_.load(std::memory_order_acquire);
    if (toggle != 0 && static_cast<int>(wparam) == toggle &&
        (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)) {
        SetVisible(!visible());
        return true;
    }
    if (toggle != 0 && static_cast<int>(wparam) == toggle &&
        (message == WM_KEYUP || message == WM_SYSKEYUP)) {
        return true;
    }

    input_.Push(InputMessage{message, wparam, lparam});

    if (!visible_.load(std::memory_order_acquire)) {
        // Hidden: the queue still receives everything, so focus and modifier
        // state stay correct for the moment it opens, but nothing is taken
        // from the game.
        return false;
    }
    if (IsMouseMessage(message) && wants_mouse_.load(std::memory_order_acquire)) {
        return true;
    }
    if (IsKeyboardMessage(message) && wants_keyboard_.load(std::memory_order_acquire)) {
        return true;
    }
    return false;
}

}  // namespace brownie::overlay
