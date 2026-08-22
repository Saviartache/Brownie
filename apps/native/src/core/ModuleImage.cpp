#include "core/ModuleImage.h"

namespace brownie {

Result<ModuleImage> ModuleImage::Of(HMODULE module) noexcept {
    if (module == nullptr) {
        return Error{ErrorCode::kInvalidArgument, "no module"};
    }

    const auto* base = reinterpret_cast<const std::byte*>(module);
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
        return Error{ErrorCode::kProtocol, "not a PE image"};
    }

    const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
        return Error{ErrorCode::kProtocol, "not a 64-bit PE image"};
    }

    ModuleImage image;
    image.base_ = base;
    image.size_ = nt->OptionalHeader.SizeOfImage;

    const auto* section = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++section) {
        if ((section->Characteristics & IMAGE_SCN_MEM_EXECUTE) == 0) {
            continue;
        }
        if (image.code_count_ == kMaxCodeRanges) {
            // Silently ignoring the rest would make a later address check
            // wrong in the one direction that matters — rejecting real code.
            return Error{ErrorCode::kUnsupported, "more executable sections than expected"};
        }
        const auto* begin = base + section->VirtualAddress;
        image.code_[image.code_count_] = Range{begin, begin + section->Misc.VirtualSize};
        ++image.code_count_;
    }

    if (image.code_count_ == 0) {
        return Error{ErrorCode::kProtocol, "image has no executable section"};
    }
    return image;
}

Result<ModuleImage> ModuleImage::Containing(const void* address) noexcept {
    if (address == nullptr) {
        return Error{ErrorCode::kInvalidArgument, "no address"};
    }
    HMODULE module = nullptr;
    // `UNCHANGED_REFCOUNT` because we only want to look: taking a reference here
    // would pin a library the process may be finished with, and releasing it
    // would be one more lifetime to get right for no benefit.
    if (::GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                 GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                             static_cast<LPCWSTR>(address), &module) == FALSE) {
        return Error{ErrorCode::kNotFound, "the address is in no loaded module", ::GetLastError()};
    }
    return Of(module);
}

bool ModuleImage::ContainsCode(const void* address) const noexcept {
    const auto* at = reinterpret_cast<const std::byte*>(address);
    for (std::size_t i = 0; i < code_count_; ++i) {
        if (at >= code_[i].begin && at < code_[i].end) {
            return true;
        }
    }
    return false;
}

bool ModuleImage::Contains(const void* address) const noexcept {
    const auto* at = reinterpret_cast<const std::byte*>(address);
    return base_ != nullptr && at >= base_ && at < base_ + size_;
}

}  // namespace brownie
