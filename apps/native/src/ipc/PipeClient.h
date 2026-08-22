// The named pipe to the Node runtime.
//
// **Cancellable, which the reference implementation was not.** That version
// read with a blocking `ReadFile` on a dedicated thread, so shutdown could not
// proceed until the peer happened to send something or close first — and an
// injected module that cannot be torn down on demand is one that takes the game
// down with it. Here every wait is on both the I/O and a cancellation event, so
// `Cancel()` returns the thread promptly whatever the peer is doing.
//
// The transport only moves bytes. Framing is `FrameReader`, the conversation is
// `Session`; keeping them apart is what lets each be reasoned about alone.

#pragma once

#include <cstddef>
#include <string>

#include <Windows.h>

#include "core/Result.h"
#include "core/WinHandle.h"

namespace brownie::ipc {

/// `\\.\pipe\<name>` — the only form a Windows named pipe takes.
[[nodiscard]] std::wstring PipePath(std::wstring_view name);

class PipeClient {
  public:
    PipeClient() = default;

    PipeClient(const PipeClient&) = delete;
    PipeClient& operator=(const PipeClient&) = delete;
    PipeClient(PipeClient&&) noexcept = default;
    PipeClient& operator=(PipeClient&&) noexcept = default;
    ~PipeClient() = default;

    /// Opens the pipe.
    ///
    /// Returns `kNotFound` when the runtime is not listening — the ordinary
    /// case when the game starts first, and a reason to retry rather than to
    /// give up.
    Status Connect(std::wstring_view pipe_name);

    /// Closes the pipe. Safe to call more than once, and from any thread.
    void Disconnect() noexcept;

    [[nodiscard]] bool connected() const noexcept { return pipe_.valid(); }

    /// Writes all of `size` bytes, or fails.
    ///
    /// A partial write would desynchronise the frame stream, so there is no
    /// "wrote some" outcome to report: either the whole frame went or the
    /// connection is finished.
    Status Send(const std::byte* data, std::size_t size);

    /// Reads whatever has arrived, waiting up to `timeout_ms`.
    ///
    /// Returns the byte count, `kNotReady` on a timeout — which is the normal
    /// idle case — or an error when the pipe is gone.
    Result<std::size_t> Receive(std::byte* out, std::size_t capacity, DWORD timeout_ms);

    /// Wakes any thread waiting in `Send` or `Receive` and keeps it woken.
    ///
    /// Separate from `Disconnect` so a shutdown can stop the I/O thread before
    /// tearing the handle down underneath it — closing a handle a thread is
    /// blocked on is how a teardown turns into a crash.
    void Cancel() noexcept;

  private:
    WinHandle pipe_;
    /// Manual-reset: once cancellation is asked for it stays asked for, so a
    /// wait entered after the request does not block forever.
    WinHandle cancel_;
    WinHandle read_done_;
    WinHandle write_done_;
};

}  // namespace brownie::ipc
