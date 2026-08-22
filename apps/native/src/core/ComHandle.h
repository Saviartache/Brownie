// RAII for COM interface pointers.
//
// Every Direct3D object is reference counted, and every `Release` that has to be
// remembered across an early return is one that will eventually be forgotten.
// The reference implementation leaked a device and a swap chain on each of the
// four failure paths in its render setup, in a process it does not own.

#pragma once

#include <utility>

namespace brownie {

template <typename T>
class ComHandle {
  public:
    ComHandle() noexcept = default;
    explicit ComHandle(T* raw) noexcept : raw_{raw} {}

    ComHandle(const ComHandle&) = delete;
    ComHandle& operator=(const ComHandle&) = delete;

    ComHandle(ComHandle&& other) noexcept : raw_{std::exchange(other.raw_, nullptr)} {}

    ComHandle& operator=(ComHandle&& other) noexcept {
        if (this != &other) {
            reset();
            raw_ = std::exchange(other.raw_, nullptr);
        }
        return *this;
    }

    ~ComHandle() { reset(); }

    [[nodiscard]] bool valid() const noexcept { return raw_ != nullptr; }
    [[nodiscard]] T* get() const noexcept { return raw_; }
    T* operator->() const noexcept { return raw_; }

    /// For the out-parameter every COM creation function takes. Releases what
    /// was held first, so a handle reused for a second call cannot leak the
    /// first.
    [[nodiscard]] T** put() noexcept {
        reset();
        return &raw_;
    }

    void reset() noexcept {
        if (raw_ != nullptr) {
            raw_->Release();
            raw_ = nullptr;
        }
    }

  private:
    T* raw_ = nullptr;
};

}  // namespace brownie
