## General

* Treat the existing project as a behavioral reference, not an architectural template.
* Prefer clean rewrites over preserving legacy structure.
* Keep code simple, explicit, modular, and maintainable.
* Do not introduce abstractions without a concrete need.
* Remove dead, duplicated, deprecated, and unused code instead of carrying it forward.
* Prefer correctness and stability over cleverness.

## Architecture

* Keep responsibilities clearly separated.
* Avoid god classes, god modules, huge files, and global mutable state.
* One module should have one clear responsibility.
* Keep public APIs minimal.
* Avoid circular dependencies.
* Dependencies should flow in one predictable direction.
* Do not mix networking, parsing, state management, plugins, configuration, and platform-specific code in the same component.

## C++

Priorities:

1. Correctness
2. Memory safety
3. Runtime stability
4. Clear ownership and lifetime
5. Maintainability
6. Performance

Rules:

* Use modern C++ and RAII.
* Prefer value semantics and `std::unique_ptr`.
* Use `std::shared_ptr` only when ownership is genuinely shared.
* Raw pointers and references are non-owning.
* Avoid manual `new/delete`, `malloc/free` unless implementing a contained low-level abstraction.
* Every resource must have deterministic ownership and cleanup.
* Never rely on unclear object lifetime assumptions.
* Carefully consider iterator/reference invalidation.
* Validate all offsets, lengths, indexes, packet sizes, and external input.
* Avoid unnecessary copies and heap allocations, especially in hot paths.
* Prefer `std::span` and `std::string_view` when lifetime is guaranteed.
* Minimize shared mutable state.
* Define a clear threading model instead of creating threads ad hoc.
* Never invoke unknown/external callbacks while holding locks unless explicitly required.
* Shutdown must be deterministic and free from use-after-free and race conditions.
* Do not suppress compiler/static-analysis warnings instead of fixing the cause.

Before completing C++ code, verify:

* Who owns this object?
* Who can destroy it?
* Can another thread access it?
* Can a callback outlive its owner?
* Can a reference/pointer become invalid?
* Can malformed input cause out-of-bounds access?
* Is there unnecessary allocation/copying?
* What happens during failure and shutdown?

## Performance

* Do not optimize based on assumptions.
* Use: `Measure -> Identify hot path -> Optimize -> Measure again`.
* Avoid unnecessary:

  * allocations;
  * copies;
  * string formatting;
  * serialization;
  * locking;
  * context switches;
  * syscalls;
  * pointer indirection.
* Keep hot paths small and predictable.
* Prefer cache-friendly contiguous data structures where appropriate.
* Never trade substantial readability or safety for an unmeasured micro-optimization.

## Node.js / TypeScript

* Use strict TypeScript.
* Avoid `any`, `@ts-ignore`, unsafe assertions, and disabled lint rules unless there is a documented reason.
* Keep the event loop non-blocking.
* Handle promise rejections and asynchronous errors explicitly.
* Clean up listeners, timers, sockets, and other resources during shutdown.
* Plugin failures must not crash the entire runtime.
* Avoid uncontrolled `EventEmitter` usage when direct interfaces are clearer.

## Networking

* TCP is a byte stream. Never assume one `data` event equals one packet.
* Correctly handle:

  * partial packets;
  * multiple packets per chunk;
  * packets split across multiple chunks;
  * malformed/truncated packets;
  * disconnects during parsing.
* Separate transport, framing, decoding, validation, routing, state updates, and encoding.
* Respect Node.js stream backpressure.
* Avoid repeated `Buffer.concat()` and unnecessary buffer copies in hot paths.
* Never trust packet lengths or network input without validation.

## C++ / Node Boundary

* C++ handles low-level client interaction and performance-critical native work.
* Node.js acts as the high-level runtime, packet processor, proxy, state layer, and plugin host.
* Do not move high-level logic into C++ without a concrete reason.
* Communication between C++ and Node must use a small, explicit, versionable protocol.
* Minimize IPC calls, serialization, and copying without introducing unnecessary latency.

## Plugins

* Plugins interact through a documented public API, not internal runtime objects.
* Define explicit lifecycle behavior for load, enable, disable, unload, reload, and failure.
* A plugin error must be isolated from the core runtime.
* Plugin resources and event subscriptions must be cleaned up on unload.

## Error Handling

* Use a consistent error-handling strategy.
* Do not silently swallow errors.
* Validate errors at subsystem boundaries.
* External/malformed input should fail safely.
* Programmer errors should not be hidden behind broad catch-all handlers.
* Error paths and shutdown paths are part of the implementation, not optional cleanup work.

## Code Quality

* Prefer descriptive names over generic names such as `Manager`, `Helper`, `Utils`, `Common`, or `Data`.
* Comments should explain **why**, not restate the code.
* Document unusual protocol behavior, lifetime assumptions, and compatibility workarounds.
* Do not create wrapper classes or interfaces that provide no real architectural value.
* Do not split trivial logic across excessive numbers of files.
* Do split files that contain multiple unrelated responsibilities.

## Dependencies

Before adding a dependency, determine:

* Is it actually needed?
* Is it maintained?
* Does the standard library already solve the problem?
* Is the dependency justified by the complexity it removes?

Remove unused and obsolete dependencies.

## Testing

Critical logic should be testable independently.

Prioritize tests for:

* packet framing;
* parsing and serialization;
* malformed/truncated input;
* state transitions;
* IPC;
* plugin lifecycle;
* ownership/lifetime-sensitive code;
* shutdown behavior.

For native code, use sanitizers and static analysis where supported.

## Cheat Engine MCP

* A local Cheat Engine MCP bridge is installed at `tools/cheatengine-mcp-bridge` and registered as the `cheatengine` MCP server in `opencode.json` and `.mcp.json`.
* Use it when the user requests authorized local memory inspection, pointer scanning, disassembly, debugging, or related reverse-engineering work. Call the MCP `ping` tool before starting an analysis session.
* Before use, Cheat Engine must be running with `tools/cheatengine-mcp-bridge/MCP_Server/ce_mcp_bridge.lua` loaded and the intended process attached.
* In Cheat Engine, disable `Settings -> Extra -> Query memory region routines` before DBVM or protected-page scanning because the bridge documents a BSOD risk when it is enabled.
* Prefer read-only inspection. Obtain explicit user approval before writing memory, injecting code or DLLs, executing Lua or target code, deleting files, controlling input, or changing process state.
* Keep `CE_MCP_ALLOW_SHELL` unset unless the user explicitly requests and approves arbitrary shell execution through Cheat Engine.
* Use the bridge only on software and processes the user is authorized to analyze; do not use it to bypass anti-cheat systems or third-party access controls.

## Definition of Done

Code is not complete until:

* architecture and responsibility are clear;
* ownership and lifetime are clear;
* error handling exists;
* shutdown behavior is correct;
* critical logic is tested;
* unnecessary allocations/copies were considered;
* no obvious dead or duplicated code remains;
* formatting passes;
* lint/static analysis passes;
* build succeeds;
* tests pass;
* relevant documentation is updated.

## Core Rule

Do not reproduce bad legacy architecture simply because it already exists.

Preserve required behavior, not technical debt.
