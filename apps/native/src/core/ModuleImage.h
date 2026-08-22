// The executable extent of a loaded module.
//
// Exists to answer one question — "is this address real code inside this
// module?" That check is what turns a pointer read out of someone else's data
// structure, or a hook target recovered from metadata, into something safe to
// jump to. Reading a pointer at an assumed offset and calling it unchecked is
// how a stale layout becomes a crash with no evidence of where it came from,
// which is precisely the failure the reference implementation shipped.

#pragma once

#include <array>
#include <cstddef>

#include <Windows.h>

#include "core/Result.h"

namespace brownie {

class ModuleImage {
  public:
    /// Reads the module's section table. Fails on anything that is not a
    /// well-formed PE image, rather than guessing at a layout.
    static Result<ModuleImage> Of(HMODULE module) noexcept;

    /// The module `address` belongs to, if any.
    ///
    /// For checking a pointer whose owner is not known in advance — a vtable
    /// slot, say, where the implementation could live in any of several system
    /// libraries. An address in no loaded module fails, which is the answer
    /// that matters.
    static Result<ModuleImage> Containing(const void* address) noexcept;

    /// True when `address` lies inside a section marked executable.
    [[nodiscard]] bool ContainsCode(const void* address) const noexcept;

    /// True when `address` lies anywhere in the mapped image.
    [[nodiscard]] bool Contains(const void* address) const noexcept;

  private:
    struct Range {
        const std::byte* begin;
        const std::byte* end;
    };

    /// More than any real image needs; a PE with more executable sections than
    /// this is not something to accommodate quietly.
    static constexpr std::size_t kMaxCodeRanges = 8;

    const std::byte* base_ = nullptr;
    std::size_t size_ = 0;
    std::array<Range, kMaxCodeRanges> code_{};
    std::size_t code_count_ = 0;
};

}  // namespace brownie
