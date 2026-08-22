// A stand-in for the game, so the link can be tested without one.
//
// `Session` and `Engine` are the two pieces with no unit test, and deliberately
// so: their contract is a live peer, and a test with a fake peer would only
// prove that the fake agrees with the code under test. What proves anything is
// the real module, loaded into a real process, talking to the real runtime.
//
// This host is that process. It does what the game does and nothing else: load
// `version.dll` from beside itself, wait, unload it. Everything interesting
// happens inside the module — reading the session key, connecting, the mutual
// handshake — and the evidence appears in the runtime's log.
//
// It is not a substitute for running against the game. The overlay needs a swap
// chain somebody presents, and the IL2CPP layer needs a game to bind to; neither
// exists here. What this covers is the link, which is the part that has to work
// before either of those matters.

#include <cstdio>
#include <cstdlib>
#include <string>

#include <Windows.h>

int main(int argc, char** argv) {
    const unsigned seconds = argc > 1 ? static_cast<unsigned>(std::atoi(argv[1])) : 5;

    // By absolute path, so this loads the module that was just built rather
    // than whichever `version.dll` happens to be findable.
    wchar_t directory[MAX_PATH]{};
    const DWORD length = ::GetModuleFileNameW(nullptr, directory, MAX_PATH);
    if (length == 0 || length >= MAX_PATH) {
        std::printf("could not find my own path\n");
        return 1;
    }
    for (DWORD i = length; i > 0; --i) {
        if (directory[i - 1] == L'\\') {
            directory[i] = L'\0';
            break;
        }
    }

    std::wstring path{directory};
    path.append(L"d3d11.dll");
    std::printf("host: loading %ls\n", path.c_str());

    const HMODULE module = ::LoadLibraryW(path.c_str());
    if (module == nullptr) {
        std::printf("host: LoadLibrary failed with %lu\n", ::GetLastError());
        return 1;
    }
    std::printf("host: loaded, waiting %u second(s)\n", seconds);

    // The module's own thread does the work. Waiting is the whole job.
    ::Sleep(seconds * 1000);

    // The interesting half, and the ordering is the point. Teardown happens
    // *before* `FreeLibrary`, on this ordinary thread, because it joins a
    // thread and removes hooks — and both deadlock against the loader lock that
    // `DllMain` holds. A module that cleans up only in `DllMain` hangs here
    // forever, which is exactly what this host caught.
    using ShutdownFn = void (*)();
    auto* proc = ::GetProcAddress(module, "BrownieShutdown");
    if (proc == nullptr) {
        std::printf("host: the module exports no BrownieShutdown\n");
        return 1;
    }
    std::printf("host: shutting the module down\n");
    reinterpret_cast<ShutdownFn>(reinterpret_cast<void*>(proc))();

    std::printf("host: unloading\n");
    ::FreeLibrary(module);
    std::printf("host: unloaded cleanly\n");
    return 0;
}
