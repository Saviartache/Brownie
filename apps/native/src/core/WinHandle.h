// RAII for the Win32 handles this module owns.
//
// The reference implementation paired `create()` with `cleanup()` by hand
// across hooks, the pipe, the swap chain and the D3D11 device, and every early
// return between them was a leak waiting to be written. A handle that closes
// itself removes the whole category — including the one that matters most here,
// where an injected module can be unloaded at any moment and must not leave a
// pipe or an event behind in the game's process.

#pragma once

#include <utility>

#include <Windows.h>

namespace brownie {

/// A `HANDLE` that closes itself.
///
/// Move-only, because a handle has exactly one owner; copying it is how a
/// double-close happens. `INVALID_HANDLE_VALUE` and `nullptr` are both treated
/// as "nothing to close" — Win32 uses each in different places for the same
/// idea, and the caller should not have to remember which.
class WinHandle {
  public:
    constexpr WinHandle() noexcept = default;
    constexpr explicit WinHandle(HANDLE handle) noexcept : handle_{handle} {}

    WinHandle(const WinHandle&) = delete;
    WinHandle& operator=(const WinHandle&) = delete;

    WinHandle(WinHandle&& other) noexcept : handle_{other.release()} {}

    WinHandle& operator=(WinHandle&& other) noexcept {
        if (this != &other) {
            reset(other.release());
        }
        return *this;
    }

    ~WinHandle() { reset(); }

    [[nodiscard]] bool valid() const noexcept {
        return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
    }
    explicit operator bool() const noexcept { return valid(); }

    [[nodiscard]] HANDLE get() const noexcept { return handle_; }

    /// Gives up ownership without closing. For handing a handle to an API that
    /// takes it over.
    [[nodiscard]] HANDLE release() noexcept { return std::exchange(handle_, nullptr); }

    void reset(HANDLE handle = nullptr) noexcept {
        if (valid()) {
            ::CloseHandle(handle_);
        }
        handle_ = handle;
    }

  private:
    HANDLE handle_ = nullptr;
};

/// A module reference that frees itself.
///
/// Separate from `WinHandle` because an `HMODULE` is freed with a different
/// call — a distinction Win32 draws and a single "handle" type would erase.
class ModuleHandle {
  public:
    constexpr ModuleHandle() noexcept = default;
    constexpr explicit ModuleHandle(HMODULE module) noexcept : module_{module} {}

    ModuleHandle(const ModuleHandle&) = delete;
    ModuleHandle& operator=(const ModuleHandle&) = delete;

    ModuleHandle(ModuleHandle&& other) noexcept : module_{std::exchange(other.module_, nullptr)} {}

    ModuleHandle& operator=(ModuleHandle&& other) noexcept {
        if (this != &other) {
            reset(std::exchange(other.module_, nullptr));
        }
        return *this;
    }

    ~ModuleHandle() { reset(); }

    [[nodiscard]] bool valid() const noexcept { return module_ != nullptr; }
    explicit operator bool() const noexcept { return valid(); }
    [[nodiscard]] HMODULE get() const noexcept { return module_; }

    void reset(HMODULE module = nullptr) noexcept {
        if (module_ != nullptr) {
            ::FreeLibrary(module_);
        }
        module_ = module;
    }

  private:
    HMODULE module_ = nullptr;
};

}  // namespace brownie
