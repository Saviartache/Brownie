// Every export of the real DLL this module stands in for, with its ordinal.
//
// An X-macro rather than three parallel lists: the stubs, the resolution table
// and the linker's export list all come from this file, so a name cannot be
// present in one and missing from another.
//
// **The ordinals are load-bearing.** Callers import by ordinal as well as by
// name, and a proxy that answers the right name on the wrong ordinal hands them
// a different function. Generated from C:\WINDOWS\System32\d3d11.dll — regenerate with
// scripts/refresh-proxy-exports.mjs, do not edit by hand.
//
// BrownieShutdown is not here: it is ours, not winhttp's, and the build appends
// it after the last real ordinal.

BROWNIE_EXPORT(D3D11CreateDeviceForD3D12, 1)
BROWNIE_EXPORT(D3DKMTCloseAdapter, 2)
BROWNIE_EXPORT(D3DKMTDestroyAllocation, 3)
BROWNIE_EXPORT(D3DKMTDestroyContext, 4)
BROWNIE_EXPORT(D3DKMTDestroyDevice, 5)
BROWNIE_EXPORT(D3DKMTDestroySynchronizationObject, 6)
BROWNIE_EXPORT(D3DKMTPresent, 7)
BROWNIE_EXPORT(D3DKMTQueryAdapterInfo, 8)
BROWNIE_EXPORT(D3DKMTSetDisplayPrivateDriverFormat, 9)
BROWNIE_EXPORT(D3DKMTSignalSynchronizationObject, 10)
BROWNIE_EXPORT(D3DKMTUnlock, 11)
BROWNIE_EXPORT(D3DKMTWaitForSynchronizationObject, 12)
BROWNIE_EXPORT(EnableFeatureLevelUpgrade, 13)
BROWNIE_EXPORT(OpenAdapter10, 14)
BROWNIE_EXPORT(OpenAdapter10_2, 15)
BROWNIE_EXPORT(CreateDirect3D11DeviceFromDXGIDevice, 16)
BROWNIE_EXPORT(CreateDirect3D11SurfaceFromDXGISurface, 17)
BROWNIE_EXPORT(D3D11CoreCreateDevice, 18)
BROWNIE_EXPORT(D3D11CoreCreateLayeredDevice, 19)
BROWNIE_EXPORT(D3D11CoreGetLayeredDeviceSize, 20)
BROWNIE_EXPORT(D3D11CoreRegisterLayers, 21)
BROWNIE_EXPORT(D3D11CreateDevice, 22)
BROWNIE_EXPORT(D3D11CreateDeviceAndSwapChain, 23)
BROWNIE_EXPORT(D3D11On12CreateDevice, 24)
BROWNIE_EXPORT(D3DKMTCreateAllocation, 25)
BROWNIE_EXPORT(D3DKMTCreateContext, 26)
BROWNIE_EXPORT(D3DKMTCreateDevice, 27)
BROWNIE_EXPORT(D3DKMTCreateSynchronizationObject, 28)
BROWNIE_EXPORT(D3DKMTEscape, 29)
BROWNIE_EXPORT(D3DKMTGetContextSchedulingPriority, 30)
BROWNIE_EXPORT(D3DKMTGetDeviceState, 31)
BROWNIE_EXPORT(D3DKMTGetDisplayModeList, 32)
BROWNIE_EXPORT(D3DKMTGetMultisampleMethodList, 33)
BROWNIE_EXPORT(D3DKMTGetRuntimeData, 34)
BROWNIE_EXPORT(D3DKMTGetSharedPrimaryHandle, 35)
BROWNIE_EXPORT(D3DKMTLock, 36)
BROWNIE_EXPORT(D3DKMTOpenAdapterFromHdc, 37)
BROWNIE_EXPORT(D3DKMTOpenResource, 38)
BROWNIE_EXPORT(D3DKMTQueryAllocationResidency, 39)
BROWNIE_EXPORT(D3DKMTQueryResourceInfo, 40)
BROWNIE_EXPORT(D3DKMTRender, 41)
BROWNIE_EXPORT(D3DKMTSetAllocationPriority, 42)
BROWNIE_EXPORT(D3DKMTSetContextSchedulingPriority, 43)
BROWNIE_EXPORT(D3DKMTSetDisplayMode, 44)
BROWNIE_EXPORT(D3DKMTSetGammaRamp, 45)
BROWNIE_EXPORT(D3DKMTSetVidPnSourceOwner, 46)
BROWNIE_EXPORT(D3DKMTWaitForVerticalBlankEvent, 47)
BROWNIE_EXPORT(D3DPerformance_BeginEvent, 48)
BROWNIE_EXPORT(D3DPerformance_EndEvent, 49)
BROWNIE_EXPORT(D3DPerformance_GetStatus, 50)
BROWNIE_EXPORT(D3DPerformance_SetMarker, 51)
