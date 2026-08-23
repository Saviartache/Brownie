#include "ipc/PipeClient.h"

#include <array>

namespace brownie::ipc {
namespace {

Error SystemError(ErrorCode code, std::string_view message) noexcept {
    return Error{code, message, static_cast<std::uint32_t>(::GetLastError())};
}

/// Creates a manual-reset, initially unsignalled event.
Result<WinHandle> MakeEvent() {
    WinHandle event{::CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    if (!event.valid()) {
        return SystemError(ErrorCode::kIo, "could not create an event");
    }
    return event;
}

}  // namespace

std::wstring PipePath(std::wstring_view name) {
    std::wstring path{LR"(\\.\pipe\)"};
    path.append(name);
    return path;
}

Status PipeClient::Connect(std::wstring_view pipe_name) {
    Disconnect();

    auto cancel = MakeEvent();
    if (!cancel.ok()) return cancel.error();
    auto read_done = MakeEvent();
    if (!read_done.ok()) return read_done.error();
    auto write_done = MakeEvent();
    if (!write_done.ok()) return write_done.error();

    const std::wstring path = PipePath(pipe_name);
    WinHandle pipe{::CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                                 OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr)};
    if (!pipe.valid()) {
        // The runtime not listening yet is the ordinary case — the game often
        // starts first — so it is reported as "not found", not as a failure.
        const DWORD last = ::GetLastError();
        return Error{last == ERROR_FILE_NOT_FOUND ? ErrorCode::kNotFound : ErrorCode::kIo,
                     "could not open the pipe", static_cast<std::uint32_t>(last)};
    }

    pipe_ = std::move(pipe);
    cancel_ = std::move(cancel).value();
    read_done_ = std::move(read_done).value();
    write_done_ = std::move(write_done).value();
    return {};
}

void PipeClient::Cancel() noexcept {
    if (cancel_.valid()) {
        ::SetEvent(cancel_.get());
    }
    if (pipe_.valid()) {
        // Ends any overlapped operation this process started on the handle, so
        // the waiting thread returns rather than being abandoned mid-read.
        ::CancelIoEx(pipe_.get(), nullptr);
    }
}

void PipeClient::Disconnect() noexcept {
    Cancel();
    pipe_.reset();
    read_done_.reset();
    write_done_.reset();
    cancel_.reset();
}

Status PipeClient::Send(const std::byte* data, std::size_t size) {
    if (!connected()) return Error{ErrorCode::kNotReady, "the pipe is not connected"};
    if (data == nullptr || size == 0) return {};

    std::size_t written = 0;
    while (written < size) {
        OVERLAPPED overlapped{};
        ::ResetEvent(write_done_.get());
        overlapped.hEvent = write_done_.get();

        const auto chunk = static_cast<DWORD>(size - written);
        DWORD moved = 0;
        if (::WriteFile(pipe_.get(), data + written, chunk, &moved, &overlapped) == FALSE) {
            if (::GetLastError() != ERROR_IO_PENDING) {
                return SystemError(ErrorCode::kIo, "the pipe refused a write");
            }
            const std::array<HANDLE, 2> waits{write_done_.get(), cancel_.get()};
            const DWORD signalled = ::WaitForMultipleObjects(2, waits.data(), FALSE, INFINITE);
            if (signalled != WAIT_OBJECT_0) {
                ::CancelIoEx(pipe_.get(), &overlapped);
                // Drained before returning, for the reason the read gives: this
                // `OVERLAPPED` is on the stack, and a write the kernel has not
                // finished with is a write into a frame that is about to go away.
                ::GetOverlappedResult(pipe_.get(), &overlapped, &moved, TRUE);
                return Error{ErrorCode::kNotReady, "the write was cancelled"};
            }
            if (::GetOverlappedResult(pipe_.get(), &overlapped, &moved, FALSE) == FALSE) {
                return SystemError(ErrorCode::kIo, "a write did not complete");
            }
        }
        if (moved == 0) {
            return Error{ErrorCode::kIo, "the peer stopped accepting bytes"};
        }
        written += moved;
    }
    return {};
}

Result<std::size_t> PipeClient::Receive(std::byte* out, std::size_t capacity, DWORD timeout_ms) {
    if (!connected()) return Error{ErrorCode::kNotReady, "the pipe is not connected"};
    if (out == nullptr || capacity == 0) {
        return Error{ErrorCode::kInvalidArgument, "no room to receive into"};
    }

    OVERLAPPED overlapped{};
    ::ResetEvent(read_done_.get());
    overlapped.hEvent = read_done_.get();

    DWORD moved = 0;
    if (::ReadFile(pipe_.get(), out, static_cast<DWORD>(capacity), &moved, &overlapped) != FALSE) {
        return static_cast<std::size_t>(moved);
    }
    if (::GetLastError() != ERROR_IO_PENDING) {
        return SystemError(ErrorCode::kIo, "the pipe refused a read");
    }

    const std::array<HANDLE, 2> waits{read_done_.get(), cancel_.get()};
    const DWORD signalled = ::WaitForMultipleObjects(2, waits.data(), FALSE, timeout_ms);
    if (signalled != WAIT_OBJECT_0) {
        // A timeout, or cancellation. Either way the read is not left
        // outstanding against a buffer the caller may reuse — an overlapped read
        // still writing into a dead stack frame is precisely the corruption this
        // class exists to make impossible.
        ::CancelIoEx(pipe_.get(), &overlapped);
        // **A cancelled read may already have finished, and its bytes are not
        // ours to throw away.** `CancelIoEx` asks; it does not promise, and the
        // window it races with is the one where the data arrived a moment after
        // the timeout expired. Discarding what it moved takes a few hundred
        // bytes out of the *middle* of a frame stream, so the next header is
        // read from the middle of a payload — a protocol error, a disconnect,
        // and a reconnect a millisecond later with nothing in the log to say
        // why. Live report: "the connection randomly closes and comes back."
        //
        // Waiting here rather than in a separate call because that is what
        // `GetOverlappedResult` with `TRUE` is: the completion is drained either
        // way, and this way its answer is not discarded.
        if (::GetOverlappedResult(pipe_.get(), &overlapped, &moved, TRUE) != FALSE && moved > 0) {
            return static_cast<std::size_t>(moved);
        }
        return Error{ErrorCode::kNotReady,
                     signalled == WAIT_TIMEOUT ? "no data yet" : "the read was cancelled"};
    }

    if (::GetOverlappedResult(pipe_.get(), &overlapped, &moved, FALSE) == FALSE) {
        return SystemError(ErrorCode::kIo, "a read did not complete");
    }
    if (moved == 0) {
        return Error{ErrorCode::kIo, "the peer closed the pipe"};
    }
    return static_cast<std::size_t>(moved);
}

}  // namespace brownie::ipc
