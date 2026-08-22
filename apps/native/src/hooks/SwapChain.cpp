#include "hooks/SwapChain.h"

#include <array>
#include <cstddef>

#include <Windows.h>
#include <d3d11.h>

#include "core/ComHandle.h"
#include "core/ModuleImage.h"

namespace brownie::hooks {
namespace {

/// `Present` is the ninth entry of the `IDXGISwapChain` vtable. Counted rather
/// than remembered:
///
///     IUnknown              QueryInterface, AddRef, Release        0..2
///     IDXGIObject           SetPrivateData, SetPrivateDataInterface,
///                           GetPrivateData, GetParent              3..6
///     IDXGIDeviceSubObject  GetDevice                              7
///     IDXGISwapChain        Present                                8
///
/// The number is fixed by the interface definition and cannot change without
/// breaking every program that uses DXGI — but it is also exactly the kind of
/// constant that is wrong in a way nothing notices, which is why the address it
/// yields is verified below rather than trusted.
constexpr std::size_t kPresentSlot = 8;

constexpr wchar_t kWindowClassName[] = L"BrownieSwapChainProbe";

/// A registered window class and one window, both undone on the way out.
///
/// The window is never shown. DXGI needs a real `HWND` to create a swap chain
/// against; it does not need anyone to see it.
class ProbeWindow {
  public:
    ProbeWindow(const ProbeWindow&) = delete;
    ProbeWindow& operator=(const ProbeWindow&) = delete;
    ProbeWindow(ProbeWindow&&) = delete;
    ProbeWindow& operator=(ProbeWindow&&) = delete;

    ProbeWindow() noexcept {
        instance_ = ::GetModuleHandleW(nullptr);

        WNDCLASSEXW description{};
        description.cbSize = sizeof(description);
        description.lpfnWndProc = ::DefWindowProcW;
        description.hInstance = instance_;
        description.lpszClassName = kWindowClassName;

        atom_ = ::RegisterClassExW(&description);
        if (atom_ == 0) {
            return;
        }
        window_ = ::CreateWindowExW(0, kWindowClassName, kWindowClassName, WS_OVERLAPPEDWINDOW, 0,
                                    0, 64, 64, nullptr, nullptr, instance_, nullptr);
    }

    ~ProbeWindow() {
        if (window_ != nullptr) {
            ::DestroyWindow(window_);
        }
        if (atom_ != 0) {
            // Registered per module, so leaving it behind would make a second
            // probe in the same process fail with "class already exists".
            ::UnregisterClassW(kWindowClassName, instance_);
        }
    }

    [[nodiscard]] HWND get() const noexcept { return window_; }

  private:
    HINSTANCE instance_ = nullptr;
    ATOM atom_ = 0;
    HWND window_ = nullptr;
};

}  // namespace

Result<void*> FindPresent() {
    const ProbeWindow window;
    if (window.get() == nullptr) {
        return Error{ErrorCode::kIo, "could not create a window to probe with", ::GetLastError()};
    }

    DXGI_SWAP_CHAIN_DESC description{};
    description.BufferCount = 1;
    description.BufferDesc.Width = 64;
    description.BufferDesc.Height = 64;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.OutputWindow = window.get();
    description.SampleDesc.Count = 1;
    description.Windowed = TRUE;
    description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    ComHandle<IDXGISwapChain> swap_chain;
    ComHandle<ID3D11Device> device;
    ComHandle<ID3D11DeviceContext> context;

    // Hardware first, then WARP. The vtable is the same either way — the
    // implementation lives in `dxgi.dll` regardless of which adapter backs it —
    // so the fallback exists only so that a machine without a usable GPU can
    // still resolve the address.
    constexpr std::array<D3D_DRIVER_TYPE, 2> kDrivers{D3D_DRIVER_TYPE_HARDWARE,
                                                      D3D_DRIVER_TYPE_WARP};
    HRESULT created = E_FAIL;
    for (const D3D_DRIVER_TYPE driver : kDrivers) {
        created = ::D3D11CreateDeviceAndSwapChain(
            nullptr, driver, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &description,
            swap_chain.put(), device.put(), nullptr, context.put());
        if (SUCCEEDED(created)) {
            break;
        }
    }
    if (FAILED(created) || !swap_chain.valid()) {
        return Error{ErrorCode::kUnsupported, "Direct3D 11 is not available in this process",
                     static_cast<std::uint32_t>(created)};
    }

    // The vtable pointer is the first word of a COM object. This is the one
    // layout the COM ABI *defines*, rather than one that happens to hold.
    const auto* const* vtable = *reinterpret_cast<void* const* const*>(swap_chain.get());
    void* present = const_cast<void*>(vtable[kPresentSlot]);

    const auto image = ModuleImage::Containing(present);
    if (!image.ok()) {
        return image.error();
    }
    if (!image.value().ContainsCode(present)) {
        // A wrong slot index yields a pointer into data that would hook
        // "successfully" and corrupt whatever it was written over.
        return Error{ErrorCode::kProtocol, "the resolved Present is not executable code"};
    }
    return present;
}

}  // namespace brownie::hooks
