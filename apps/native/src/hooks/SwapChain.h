// Finding the game's frame boundary.
//
// The overlay draws inside `IDXGISwapChain::Present`, because that is the one
// moment per frame when the game's device, context and back buffer are all
// valid and nothing else is using them. Finding its address means finding a
// swap chain's vtable — and rather than reach into the game's, this creates a
// throwaway one of its own.
//
// **Why a throwaway device rather than the game's.** The vtable of a COM
// interface is a property of the interface, not of the object: every
// `IDXGISwapChain` in the process shares the implementation that `dxgi.dll`
// provides. So a swap chain we create ourselves, on a window nobody sees,
// yields the same function pointer as the one the game is rendering into — and
// getting it does not require waiting for the game to finish initialising, nor
// walking its objects to find one.
//
// The alternative the reference implementation used was a byte-pattern scan of
// `dxgi.dll`, which had to be revised whenever Windows updated it.

#pragma once

#include "core/Result.h"

namespace brownie::hooks {

/// The address of `IDXGISwapChain::Present` in this process.
///
/// Verified before it is returned: the resolved pointer must lie in an
/// executable section of whichever module owns it. A wrong vtable index would
/// otherwise yield a data pointer that hooks "successfully" and corrupts the
/// first thing it is written over.
///
/// `kUnsupported` when Direct3D 11 is unavailable — a machine with no usable
/// adapter is a machine the overlay stays away from, not one to fail on.
Result<void*> FindPresent();

}  // namespace brownie::hooks
