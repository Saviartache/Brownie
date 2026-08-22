// Standing in for the real `d3d11.dll`.
//
// **Which DLL is hijacked is a measured result, not a preference.** The obvious
// targets are `version.dll` and `winhttp.dll` — the second is what the reference
// implementation used. Both kill this build of Exalt about a second into
// startup, on the main thread inside `il2cpp_init`. That is not caused by
// anything in this project: **Microsoft's own** `version.dll` and `winhttp.dll`,
// copied unmodified into the game folder, do it too, and so does the reference
// implementation's own proxy rebuilt from its sources. A DLL that is merely
// present and never loaded is harmless, so it is the loading that the game
// cannot survive — for those names.
//
// `d3d11.dll` it survives, with this whole module in it. Established on a clean
// reinstall of the game, by measuring each candidate with
// `scripts/probe-module.mjs` rather than reasoning about it. Four earlier
// diagnoses — the forwarding assembly, the exported unwinder symbols, the
// loader lock, two modules sharing a base name — were each argued from the
// crash stack and each wrong.
//
// The mechanics are the ordinary ones. The game loads a DLL from its own
// directory before the one in System32, so a file with that name is picked up
// automatically — no injector, no launcher. That only works if every function
// anything in the process expects still answers, so all 51 exports are
// forwarded to the real library, which has to be loaded by absolute path out of
// System32 because a `.def` forwarder would name `d3d11` and resolve back to us.
//
// **The forwarding is x86-64 assembly and its exact shape matters.** A naked
// function has no prologue in which to materialise an operand, so extended
// inline assembly is not supported there — only basic assembly, naming one
// global per export with no arithmetic. The emitted stub is six bytes,
// `ff 25 <rel32>`, a plain indirect jump, and it was verified to be that.

#include <array>
#include <cstddef>
#include <string>

#include <Windows.h>

#include "core/WinHandle.h"

namespace {

/// The real library, loaded once and kept for the life of the module.
///
/// Deliberately not freed on detach: a forwarded call can arrive during
/// teardown from a thread that has not stopped, and answering it with a freed
/// module is worse than leaking a handle the process is about to discard.
brownie::ModuleHandle g_real_target;

/// Every export, from the one list.
#define BROWNIE_EXPORT(name, ordinal) #name,
constexpr std::array<const char*, 51> kExports{
#include "../../defs/exports.inc"
};
#undef BROWNIE_EXPORT

}  // namespace

// One global per export and one stub that jumps through it, from the same list,
// so a name cannot appear in the assembly and be missing from the table.
//
// The stub is naked because the arguments are already in the right registers
// and on the right stack: there is nothing to move and nothing to return
// through. Writing 51 typed wrappers would mean 51 signatures, several of them
// undocumented, and one wrong would corrupt a call in whichever program made it.
#define BROWNIE_EXPORT(name, ordinal)                                          \
    extern "C" FARPROC o##name;                                                \
    FARPROC o##name = nullptr;                                                 \
    extern "C" __declspec(naked) void _##name() { /* NOLINT */                 \
        __asm__("jmp *o" #name "(%rip)");                                      \
    }
#include "../../defs/exports.inc"
#undef BROWNIE_EXPORT

namespace {

/// The globals above, in the order of `kExports`, so resolution is one loop.
#define BROWNIE_EXPORT(name, ordinal) &o##name,
const std::array<FARPROC*, 51> kSlots{
#include "../../defs/exports.inc"
};
#undef BROWNIE_EXPORT

}  // namespace

namespace brownie::app {

/// Loads the real library and resolves every export.
///
/// Returns false when the library or any single export is missing: a partially
/// forwarded proxy is worse than none, because the process runs until it
/// happens to call the one function that is not there.
bool LoadRealProxyTarget() {
    if (g_real_target.valid()) {
        return true;
    }

    std::array<wchar_t, MAX_PATH> system_directory{};
    const UINT length = ::GetSystemDirectoryW(system_directory.data(),
                                              static_cast<UINT>(system_directory.size()));
    if (length == 0 || length >= system_directory.size()) {
        return false;
    }

    std::wstring path{system_directory.data(), length};
    path.append(L"\\d3d11.dll");

    brownie::ModuleHandle real{::LoadLibraryW(path.c_str())};
    if (!real.valid()) {
        return false;
    }

    for (std::size_t i = 0; i < kExports.size(); ++i) {
        FARPROC resolved = ::GetProcAddress(real.get(), kExports[i]);
        if (resolved == nullptr) {
            return false;
        }
        *kSlots[i] = resolved;
    }

    g_real_target = std::move(real);
    return true;
}

}  // namespace brownie::app
