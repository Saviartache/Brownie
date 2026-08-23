# Architecture

## What this is

A MITM proxy and automation runtime for Realm of the Mad God (Exalt) on Windows
x64, plus an injected native module that talks to the game process directly.

Two processes, two languages, one contract between them:

```
      Exalt (game process)
        │            ▲
 TCP    │            │  in-process
        ▼            │
┌─────────────────┐  │   ┌──────────────────────────┐
│  Node runtime   │  └───│  native module (C++)     │
│                 │      │  d3d11.dll               │
│  proxy ⇄ server │◄───►│  IL2CPP hooks + overlay  │
└─────────────────┘ pipe └──────────────────────────┘
        │
        ▼
   game server
```

The Node runtime is the brain. The native module is a pair of hands inside the
game process. Everything that *can* live in Node does.

## Layer boundary — what goes where

The native module does only what must happen inside the game's address space:

* IL2CPP field/method access and method hooks,
* the DXGI `Present` detour and the ImGui overlay,
* the camera's own projection — which is what turns a cursor into a place on
  the map, and a place on the map into a mark drawn over it,
* anything on a per-frame deadline that would not survive a process hop
  (dodge steering, auto-nexus, auto-aim),
* keyboard polling for hotkeys.

Everything else is Node: the TCP proxy, packet framing/decoding/encoding, game
state derived from packets, plugin hosting, configuration, persistence,
logging, orchestration, and every piece of UI *content* (the overlay renders
what the runtime describes; it decides nothing).

Two rules keep the boundary from eroding:

1. **The native module stores no settings.** The runtime re-pushes every
   feature key on enable, on connect and on cleanup. A fresh injection starts
   from the C++ defaults and anything not re-sent stays there. This makes the
   two sides independently restartable.
2. **The runtime knows no C++ internals.** It speaks the IPC contract in
   `packages/ipc` and nothing else — no offsets, no class names, no addresses.

## Repository layout

```
.
├── packages/
│   ├── protocol/      RotMG wire protocol. Pure, zero dependencies, no I/O.
│   ├── ipc/           Node ⇄ native contract: framing, envelope, records.
│   └── plugin-api/    The types a plugin author compiles against.
│
├── apps/
│   ├── runtime/       The Node process: proxy, pipeline, state, plugins.
│   └── native/        The injected C++ module.
│
├── docs/
├── tools/
└── tests/
```

Dependency direction is strictly downward and acyclic:

```
apps/runtime ──► packages/plugin-api ──► packages/protocol
     │                                        ▲
     └──────────► packages/ipc ───────────────┘
apps/native  ──► (packages/ipc, as a documented contract — no code sharing)
```

`packages/protocol` imports nothing but the Node standard library. It has no
logger, no config, no clock — a decoder that reaches for a logger is a decoder
you cannot test.

## Packet flow

```
socket data
   │
   ▼
PacketFramer          bytes → complete frames (length-prefixed, TCP-aware)
   │
   ▼
Rc4                   in-place, from byte 5, stateful per direction
   │
   ▼
PacketDecoder         frame → DecodedPacket, driven by the schema registry
   │
   ▼
PacketPipeline        ordered stages:
   │                    1. state    — world/player/session updates
   │                    2. core     — reconnect, commands, safety
   │                    3. plugins  — subscriber dispatch
   │
   ▼
verdict               forward | drop | forward-modified
   │
   ▼
PacketEncoder         only when a stage actually modified fields
   │
   ▼
Rc4 (opposite key) ──► peer socket
```

Design points, each of which the old implementation got wrong at least once:

* **Framing is its own component.** One TCP chunk is not one packet: it can be
  half a packet, five packets, or the tail of one and the head of the next.
  `PacketFramer` is a state machine over a compacting cursor buffer, tested
  directly against byte-at-a-time, split-header and coalesced-chunk feeds.
* **A packet is re-encoded only if a stage set a field.** Untouched packets
  forward their original plaintext bytes verbatim, so a definition that has
  drifted from the live game cannot corrupt traffic — it can only fail to
  *describe* it. Modification is tracked by the packet object, not guessed.
* **State updates run before plugins, always.** Ordering is a property of the
  pipeline, not of the order in which modules happened to register.
* **A stage that throws loses its packet's turn, not the connection.** The
  error is attributed to the stage (and, for plugins, to the plugin) and the
  packet continues down the pipeline with the verdict it had.

Errors: parsing produces a typed `ProtocolError` carrying the packet id, field
path and byte offset. Malformed input is never fatal — an undecodable body
becomes an opaque packet that still forwards. Only a frame that is structurally
impossible (declared length ≤ 0, or beyond the cap) closes the session, because
at that point the stream is desynchronised and nothing after it is meaningful.

## Session model

One `ProxySession` per accepted client connection. It owns exactly two
`PeerLink`s (client-side and server-side), each of which owns one socket, one
receive cipher, one send cipher and one framer. The session owns the state
objects, the pipeline instance and the game clock. When the session closes it
disposes all of them, in order, once.

Reconnect (`RECONNECT` → new HELLO to a new host) keeps a small carry-over
record — target host/port, key, and the parts of world state worth preserving —
keyed by the connection GUID, in a bounded cache with a TTL. The old
implementation kept an unbounded map for the life of the process.

Nothing is a module-level singleton. The composition root builds the object
graph in `Application`; anything that needs a collaborator is given it.

A session can **hold** what the client sends — `holdClientTraffic`, one
direction only, which is a lag switch and the one gameplay capability on this
class. It is the transport's own gate and its own ordered queue, the same pair
that covers the TCP connect window, so a hold is held and never dropped: these
are enciphered frames, and RC4 does not survive a gap. Neither does the game's
protocol — the client answers each server tick with a `MOVE` carrying that
tick's number, and a missing one is a gap the server counts. Player noclip is
what needs this, and `features/noclip` is where the clock on it lives: this
layer cannot know how long a hold the server will tolerate, so it enforces
nothing but order.

## World model — what it keeps, and for how long

Each session derives a world model from the packet stream. It is written only by
the state stage, which runs first, so every later stage reads the world as of
the packet it is handling.

**None of it is a history.** Each store holds what is *currently true* and drops
the rest, and the lifetimes differ per store because the questions do:

| Store | Holds | Dropped when |
|---|---|---|
| `SelfState` | the player's latest stats | never, within a session |
| `EntityStore` | objects in view | `UPDATE.drops`, or the map changes |
| `TileMap` | ground the server has sent | the map changes |
| `ProjectileStore` | shots **still in flight** | their flight ends, or the map changes |

### The client's timeline: two clocks, one direction

A client→server packet with a `time` field is a statement on a timeline the
server is already tracking, and there are two ways to get it wrong. Both have
cost a session.

**Use the right clock.** `world.gameTimeMs` counts from the moment *this proxy*
opened the server link. `world.clientTimeMs` is the clock the **game client**
stamps on everything it sends, read off its own packets — `MOVE` records,
`PONG`, `PLAYERSHOOT`. They agree only if the client's clock starts where our
connection did, and it does not: the client has usually been running for a
while, through other maps, before the connection this session is carrying.

Anything sending a packet with a `time` field uses `clientTimeMs`. The server
checks that stamp against what the client has been telling it and drops a packet
that disagrees — with no error, no effect and nothing in the stream to say so.
Because nothing acknowledges an item move or a drink either, the result is
indistinguishable from a refusal: auto-loot walked its way through every slot in
the inventory being "refused", and auto-drink logged a drink every 400 ms while
the mana bar rose at exactly the rate of natural regeneration.

**Never send a stamp that goes backwards.** What the client puts on the wire is
a rising sequence, and the server is entitled to read it as one. A packet
*injected into the middle of that stream* is part of the same sequence, so one
carrying an earlier time than the client's own last packet is the timeline
running backwards — which is not a value the server has to tolerate. Every
calibration is taken from a reading that was already a moment old (a movement
record describes where the player *was*), so an estimate alone can sit behind
the client. `clientTimeMs` is therefore floored at the highest stamp seen, and
`calibrateClientClock` is re-read on every stamped packet so the lag never gets
frozen in.

The practical rule for anything injecting toward the server:

* stamp with `world.clientTimeMs` and nothing else;
* do not hold a stamp and reuse it later — read it at the moment of sending;
* leave room between injected packets rather than emitting several for one tick,
  so what we add to the stream keeps the shape the client's own traffic has.

### Two item moves inside half a second end the session

Every disconnect auto-loot has caused has one shape, and it is not the item, the
bag or the destination slot:

```
08:03:11.952  took 2594 from bag 291383 slot 0 into slot 1000000
08:03:18.964  took 2595 from bag 291531 slot 0 into slot 7
08:03:19.373  took 2594 from bag 291532 slot 0 into slot 1000000
08:03:19.476  FAILURE, empty message, and the connection closed
```

Seven seconds between the first two and nothing happened. Four hundred
milliseconds between the next two and the server refused the second and hung up.
The reference implementation spaced pickups by 250 ms *and reset that spacing
whenever the player stood on no bag*, so stepping from one bag to the next sent
a move immediately — which is exactly the pair above, two different bags.

So the spacing is a floor on everything the feature sends and is never reset.
A second by default, exposed as a setting, because where the real limit sits
between 400 ms and 7 s has not been measured.

### A trailing optional the definition has and the game does not

`packet-definitions.json` gives `INVENTORYSWAP` a trailing optional `tickId`.
**The live build does not carry it.** Filling it in — a reasonable-looking way
to place an operation in the tick sequence — got every swap back as `FAILURE`
with the message `Bad message received`, including the stack join that had been
working a minute earlier.

That message is the server failing to *parse* the packet rather than refusing
what it asked for: four bytes this build does not expect. An optional field in
that file is a field some build had, not one this build wants.

**So set only the fields a working implementation sets, and treat a trailing
optional as absent unless the live game has been seen to carry one.**

### What the server says when it refuses

`FAILURE` is the only account the server gives before hanging up. Nothing logs
it by default — its `errorId` is always 0 and carries no information — but the
**message** is worth knowing about, because it separates two failures that look
identical from the outside:

| message | what it means |
|---|---|
| empty | a rule was refused: the packet parsed, its contents were rejected |
| `Bad message received` | the packet did not parse: wrong fields, wrong length |

Several disconnects were diagnosed as the wrong one of those before anything
read it. When chasing a refusal, log `FAILURE` from a packet handler for the
duration; that one line is what tells a malformed packet from a rejected action.

### A slot the server has not stated is absent, not empty

`SelfState` carries the player's own item slots — what is worn, carried, in the
backpack and on the potion belt — because two features move items and neither
may keep its own copy. They are exposed as a **list of stated slots**, not a
fixed array with `-1` in the gaps, and that is deliberate.

Which stat carries which slot is a fact about a game build, and **the two stat
tables in this repository disagree** about the backpack and the belt.
`packages/protocol/data/stat-types.json` puts the backpack at 135–142 and
148–155 with the belt at 143–145; the reference implementation, from a live
capture, puts the backpack at 131–146 and the belt at 116–118. It cannot be
settled from a file on disk: the game's metadata is name-obfuscated, so the enum
is not in it. `state/ItemSlots.ts` holds the answer and is the only place it
appears.

**A live session settled it against the JSON table**, by a four-slot shift: a
swap aimed at a backpack slot chosen because stat 139 read as empty was refused
over and over. Under the capture 139 is backpack slot **8**, so the packet named
a slot four places earlier than the one that was free — a swap into an occupied
slot, which is what the server refuses.

Three rules keep a future disagreement from costing anything:

* **Only a slot the server has stated is ever named.** "Empty" has to be
  something the server said about that slot, not the absence of anything being
  said, which is why the inventory view reports a list of stated slots rather
  than an array with gaps. Being reported is also what says the third potion-belt
  slot exists: it is an unlock, and the server states it exactly when the
  character has it.
* **A move is confirmed at both ends before another goes out.** The destination
  filling says the item arrived; the *source* bag slot emptying says the server
  has told us about the bag it came out of. Acting on the first alone aims the
  next swap with a picture of the bag from before the last one.
* **A destination that refuses an item is dropped, not retried.** A move that
  never arrives is the only answer the server gives to a refusal, and it is
  treated as one — which turns a wrong slot map into a pickup that quietly does
  not happen instead of a packet a second saying so.

### A shot is gone the moment its flight ends

`ProjectileStore` expires a shot at `firedAt + lifetimeMs` — the flight time the
game's own data declares — and `WorldStatusStage` prunes on **every packet**, so
expiry is effectively immediate. That is correct for what the store exists for:
dodging things that are still moving.

It is wrong for anything asking **"what was that bullet?"**, and every
client→server acknowledgement asks exactly that. A `PLAYERHIT` is sent *because*
the bullet's flight ended — it reached the player — and then travels back to the
proxy, so it arrives strictly later still. Debuff-carrying shots in
`objects.xml` declare lifetimes of 600–2000 ms, so a shot fired from across a
room is **always** already expired and pruned by the time its own hit comes past.

**A feature reacting to an acknowledgement must therefore record what it needs
when the shot is *announced*, and keep it far longer than the flight.**
`autonexus/BulletLog` is the worked example: damage per bullet, kept
`BULLET_MAX_AGE_MS` (12 s). It does not duplicate the world model — it answers a
different question with a different lifetime.

Anti-debuffs learned this the expensive way. It read the world model from its
`PLAYERHIT` handler, which looked like exactly the reuse to prefer, type-checked
and passed its tests against a fake world — and in a real session refused
precisely nothing, silently, because the shot was never there to find.

## Plugins

A plugin is a module with metadata and lifecycle hooks. It receives a
`PluginContext` — a narrow capability object, not the runtime.

```ts
export default definePlugin({
  meta: { id: 'auto-nexus', name: 'Auto Nexus', category: 'combat' },
  setup(ctx) {
    const threshold = ctx.settings.number('hpPercent', { default: 25, min: 1, max: 99 });
    ctx.packets.on('NEWTICK', (packet, session) => { /* ... */ });
    return { /* optional dispose */ };
  },
});
```

`ctx` exposes `packets`, `commands`, `state`, `settings`, `config`, `log`,
`native` and `events` — each a small interface, each independently mockable.
A plugin never sees `ProxySession`'s internals, the socket, or the pipeline.

Lifecycle: `discover → load → setup → enable ⇄ disable → dispose`, plus
`reload` (hot reload on file change, dispose-then-setup). Every transition is
wrapped: a plugin that throws in `setup` is marked failed and skipped; a plugin
that throws in a handler is counted, and a plugin that throws repeatedly is
disabled with a reason rather than left to spray errors. One plugin's failure
never reaches another plugin or the proxy.

Subscriptions are owned by the host, not the plugin: unloading a plugin removes
every hook, command, timer and listener it registered, because the host holds
the registry and the plugin only ever handed it callbacks.

## Node ⇄ native IPC

Transport: a Windows named pipe. The runtime is the server; the injected module
connects as a client. This is the right primitive here — the peer is a DLL in
another process on the same machine, the connection is point-to-point, and the
pipe's ACL is the access-control mechanism.

Framing: a fixed 20-byte binary header plus payload, little-endian.

```
 0  magic     u32   'BRWN'
 4  version   u16   protocol version; mismatch closes the connection
 6  type      u16   message type
 8  flags     u16   bit 0 = binary payload, otherwise UTF-8 JSON
10  reserved  u16   must be zero, and is checked
12  seq       u32   monotonic per direction; a gap closes the connection
16  length    u32   payload byte count, capped
```

Payload encoding depends on the message type: JSON for control and
configuration (low rate, human-debuggable), and packed binary for telemetry
(player position, projectiles, frame timing).

Authentication happens **once**, at connect: challenge/response over a shared
secret, then the connection is trusted for its lifetime. The old implementation
recomputed an HMAC-SHA256 over a hex-encoded JSON body for *every* message,
including per-frame telemetry. On a point-to-point pipe that has already
completed a mutual challenge, a per-message MAC defends against nothing — no
third party can inject into an accepted pipe instance — and it cost a hash per
frame. The monotonic `seq` remains, because it detects the thing that actually
happens: a dropped or reordered frame.

Batching: telemetry is coalesced per frame rather than sent per event. Control
messages are never batched — they are rare and latency-visible.

The full contract, which the C++ side implements independently, is
[`docs/ipc.md`](./ipc.md).

## Configuration and logging

Configuration is layered: built-in defaults ← file (`config/*.json`) ←
environment ← command line, resolved once at startup into a frozen, validated
object. Validation is explicit, not a cast: a bad config fails at startup with
the offending key named, not at 3 a.m. inside a packet handler.

What the user configures from the overlay is a separate file and a separate
mechanism: `config/plugins.json` holds each plugin's switch and settings, is
read once before any plugin loads, and is written back — coalesced, and by
rename — whenever one of them moves. It is not layered and not validated at
startup, because it is not a contract with the operator: every value in it is
checked against the declaration of the setting that named it, at the moment that
setting is declared. See [`docs/plugins.md`](./plugins.md).

Logging is level-based (`trace debug info warn error fatal`) with a component
tag and, where one exists, a session id. Formatting is deferred behind a level
check so a disabled `trace` costs a comparison. Binary buffers are never logged
by default; the packet inspector is the tool for that and it is opt-in and
bounded.

A `LogSink` is where records land, and there can be more than one: `ConsoleSink`
for whoever is watching, `FileSink` for whoever is not. Both render through the
same `formatRecord`, deliberately — the file exists so a line somebody was told
to look for can be found, and two formats would break exactly that. The file is
**truncated on open**: one run per file, no rotation to get wrong and no
unbounded growth. It is opened and closed by `main`, which is the only place
that knows it exists; the application is handed one sink and does not care how
many places it goes.

Composition is `writeToAll([...])`, a function rather than a class because it
holds nothing. A sink that throws is swallowed there — the one place in this
runtime where swallowing is right, because logging is what a caller does *about*
a failure and there is nowhere left to report a failure of it.

## Threading

Node runs on one loop and stays there: no blocking calls in handlers, no
synchronous file I/O after startup, no `Buffer.concat` in the framer.

The native module has exactly three threads, and no component may create a
fourth:

| Thread | Owns | Rule |
|---|---|---|
| Render (the game's, via `Present`) | IL2CPP access, overlay, feature ticks | The only thread that may touch the game. |
| IPC | pipe read/write, message decode | May only enqueue; never calls into IL2CPP. |
| Watchdog | unload event, health checks | Owns teardown ordering. |

State crossing a thread boundary crosses it as a message or through a
single-writer atomic snapshot — not through a mutex wrapped around a subsystem.
This is a direct consequence of the existing (correct) rule that IPC-thread
feature handlers may only *store* state; anything needing an IL2CPP call raises
a request that the render thread consumes on its next tick.

## Startup and shutdown

Startup, in order, each step failing loudly:

1. resolve configuration and paths
2. load protocol definitions and game data (validated)
3. build the object graph
4. start the IPC server
5. read persisted preferences, then discover and load plugins into them
6. bind the TCP listener

The native module starts on its own schedule, because it is loaded by whoever
launches the game rather than by us. On attach it forwards the real library and
starts one thread; that thread opens a message box and waits. Nothing is hooked,
bound or dialled until it is answered, and cancelling leaves the process with a
working proxy and nothing else. Only the game is asked — the test host loads the
module unattended through `BROWNIE_NATIVE_ANY_HOST` and starts straight away.

Shutdown is the exact reverse and is deterministic:

1. stop accepting connections
2. disable and dispose plugins (each isolated, with a timeout), then flush their
   preferences — after disposal, so a plugin that writes on its way out is kept
3. close proxy sessions (flush, then destroy sockets)
4. close the IPC server and let the native side reset its mirror
5. stop timers and watchers
6. release install-time artefacts (deployed DLLs)

Every long-lived object has a `dispose()` and disposal is idempotent. Nothing
relies on `process.exit()` to clean up.

## Native module — what owns what

`src/app/` is the only place that may depend on every other directory, and it is
deliberately thin. `game/` and `overlay/` know nothing about each other; a piece
that needs both — describing a class the game holds, as rows the overlay draws —
belongs here and nowhere else.

| Piece | Owns | Thread |
|---|---|---|
| `Engine` | the IPC thread, the link, the published model, the wiring | IPC, plus the frame it hands to `Overlay` |
| `GameBinding` | the IL2CPP runtime, the offset table, the player reader | IPC only |
| `PlayerControl` | the route, the mover, the aim detours, the two targets | published on IPC, acted on by the frame |
| `ScenePatches` | the Unity scene walk, the health bar tint, the collision write | resolved on IPC, applied by the frame |
| `Inspection` | nothing — it takes a catalog and a sink | whichever calls it |

The split is by owner and by thread, not by subject. `PlayerControl` spans two
threads because *the problem does*: the runtime asks for a step on the IPC thread
and only the game's thread may take one, so the snapshot between them is the
whole point of the object. `GameBinding` spans one, and says so.

Nothing here is ever unbound. The runtime is attached once and lives until the
module is unloaded, because a frame reads through what it hands over and there is
no moment at which taking it back would be safe. Teardown is `Overlay::Shutdown`
removing the `Present` detour first, which is what makes "no further frame" true
before anything else is taken apart.

There is one teardown that happens while the game is still there. `QuitWatch`
detours `UnityEngine.Application::Quit`, which is where the game closing starts;
the detour raises a flag and calls through, and the IPC thread does the letting
go on its next turn — the scene pass stops, the `Present` detour comes out, and
nothing reads through a runtime that is being destroyed. It exists because the
two shutdown paths that were already here do not cover the ordinary way this
process ends: `DllMain` may not tear anything down (loader lock), and
`BrownieShutdown` only happens when somebody calls it.

### The scene

`ScenePatches` owns what the module does through the scene itself: the local
player's health bar held at one colour, the local player's collision radius
scaled — which is what area damage is decided against, not what walls are — and
a line of the game's own floating text shown over the player.

**Every switch over any of it belongs to a plugin.** The overlay holds only the
switches that *draw*, under **Visualisation**; anything that reaches into the
game is a plugin, so it is configured in one place, persisted with everything
else, and reachable by a chat command or another plugin rather than only by a
mouse. The collision radius is `player-collider` — where "no hitbox" is that
plugin asking for a multiplier of nought — and letting shots through walls is a
setting of `auto-aim`. The floating text has no switch at all: it does nothing
until the runtime sends a `text` record, which today is noclip's countdown.

The health bar tint has no switch of its own either, and deliberately: it is a
**sign**, claimed by whatever feature needs to be visible while it is on. Today
that is "no hitbox", which paints the bar purple — a player with no collision
circle looks exactly like one with a circle until something fails to hit them,
and by then it is too late to notice the switch was off.

**Each of those is a lease, not a flag**, for the reason player noclip's is: a
plugin can be disabled, can fail, can be unloaded, and the runtime behind it can
be killed — and none of those say so. The runtime restates a claim once a second
while it wants it, the module gives it three, and what the claim was applying is
put back when it lapses. A value the claim applies — the collider's multiplier,
the tint's colour — travels ahead of the claim and only when it has moved.

A detour goes in only once something has asked for it, because a detour nobody
asked for is still in the way of every call the game makes through it; it never
comes out, because removing one suspends every thread in the game. With nothing
claimed it forwards each call unchanged. Because the collision write replaces a
value the game chose, the pass keeps the game's own multiplier and puts it back
once nobody is asking. See `src/game/PlayerCollision.h`.

All three still need the same walk through Unity's own object model — `GameObject.Find`,
`transform`, `GetChild`, `GetComponent` and the rest — which is `UnityScene`, and
which is why they share an owner. Those calls are managed code, so they run on
the game's thread, from inside the frame; and they are expensive enough
(`GameObject.Find` walks the scene) that they run behind a 500 ms cadence rather
than per frame.

Both features come from HPBarMod, a third-party cheat found beside the game.
`docs/hpbarmod.md` is what it did and which parts of it are here.

## Game layer — reaching IL2CPP

`GameAssembly.dll` exports the IL2CPP C API — 240 `il2cpp_*` functions, by name.
Everything the native module needs is one of them: open an assembly, find a
class, enumerate its fields, read a field's offset, enumerate methods and their
signatures, attach a thread. So that is the only way it talks to the runtime.

The types in `src/game/Il2CppApi.h` are **declared and never defined**. A pointer
to an incomplete type cannot be dereferenced, which makes "do not assume a struct
layout" a compile error rather than a code-review convention.

This replaces the old approach — six generated headers describing IL2CPP's
internal structs, regenerated per Unity version from metadata this game ships
encrypted — and with it two failures. The headers could not be regenerated
without first defeating the encryption, and walking those structs by hand meant
dereferencing runtime state that had not been initialised, which crashed inside
`GameAssembly` with nothing in the dump to say why.

There is exactly one exception, and it is quarantined in
`Il2CppRuntime::EntryPointOf`: a method's native entry point is
`MethodInfo::methodPointer`, the first member, and no exported function returns
it. `il2cpp_runtime_invoke` can *call* a method without knowing its address, so
only hooking needs this. What makes it safe is not the claim that the member is
at offset zero but the check that follows: the value is used only if it lands in
an executable section of the game image. A shifted layout yields a metadata
pointer or padding, which fails, which makes the method unresolvable — and the
feature that wanted it goes quiet.

### Hooks

`src/hooks/`. A hook is a write into executable memory another thread may be
running through at that instant, so two rules are structural rather than
remembered:

**A hook is removed by leaving scope.** The old tree installed hooks wherever the
feature that wanted them lived and removed them only on a clean shutdown — so an
unload at any other moment left the game jumping into a trampoline in memory the
module no longer occupied. That is not a leak; it is a crash on the next frame.

**The engine outlives every hook.** MinHook has one process-wide initialisation,
and a hook removed after it is torn down is a hook that never gets removed.
Declaration order in the owner enforces it: engine first, so it is destroyed
last. A second `HookEngine::Create` fails rather than quietly sharing somebody
else's initialisation.

`IDXGISwapChain::Present` — the frame boundary the overlay draws in — is found by
creating a throwaway device and swap chain on a window nobody sees, and reading
slot 8 of its vtable. A COM interface's vtable belongs to the interface, not the
object, so a swap chain we make ourselves yields the same pointer the game's
would, without waiting for the game to initialise or walking its objects. The old
tree byte-pattern-scanned `dxgi.dll`, which had to be revised whenever Windows
updated it. The resolved address is verified to be executable code in a loaded
module before it is returned — the same rule as `EntryPointOf`, for the same
reason: a wrong vtable index yields a data pointer that hooks "successfully".

The hook layer is tested by detouring a function in the self-check binary
itself, including the property that matters most — that leaving scope restores
the target.

### Overlay

`src/overlay/`. ImGui, drawn inside the `Present` detour — the one moment per
frame when the game's device, context and back buffer are all valid and nothing
else is using them.

**Styling: stock ImGui, and that is a rule.** No theme call, no colour set, no
font loaded. A custom widget is allowed where ImGui has no equivalent, but it
must draw in ImGui's own visual language: colours from `ImGuiCol_*` via
`GetColorU32`/`GetStyleColorVec4`, metrics from `GetStyle` and the current font,
never a literal. `Ui.cpp`'s `StatusDot` is the worked example. Layout — padding,
spacing, widths, table and window flags — is fair game. The reason is drift: a
widget that paints its own colours stops matching everything around it the moment
anything about the theme changes.

**Threading, which is where overlays usually go wrong.** A window procedure runs
on whichever thread owns the window; `Present` runs on whichever thread draws. In
Unity those coincide only when multithreaded rendering is off, and "usually the
same" is not a threading model. Feeding ImGui from the window procedure while the
render thread is inside `NewFrame` is a data race on the whole input state.

So: **only the render thread touches ImGui.** The window procedure copies each
message into a bounded queue and returns; the render thread drains it just before
building a frame. Input arrives one frame late, which nobody perceives. The one
decision the window procedure must make synchronously — whether to swallow a
message — reads atomics the render thread publishes, so it is one frame stale,
which at worst passes a single click through on the frame a window opens under
the cursor. The queue is bounded because it is fed by an external source, and
overflow is counted and shown rather than hidden.

The render target view is created per frame from the current back buffer rather
than cached with a `ResizeBuffers` hook to invalidate it: more allocation, fewer
moving parts, and no way for a stale view to survive into the frame after a
resize.

Teardown removes the detour first — MinHook suspends threads and fixes up
instruction pointers, so no new frame can begin — then waits, with a bound, for a
frame already inside the object, then restores the window procedure and shuts
ImGui down. The bound exists because at process exit the render thread may
already have been terminated mid-frame.

### Offsets are never constants

`src/game/OffsetTable.h`. The old tree kept hard-coded offsets with a fallback
path that used them when a lookup failed, so after a game patch a feature did not
stop — it read and wrote the wrong memory. **A wrong offset is memory corruption
in someone else's process, surfacing somewhere unrelated, minutes later.**

The rule here: an offset that cannot be verified does not exist. Resolution runs
three layers, in decreasing order of what they prove — exact name, then known
alias, then a fingerprint argued from shape (a field's declared type, a method's
signature). Only the third layer can be wrong, so it is the strictest: a field
fingerprint requires the class to still have the *recorded number* of instance
fields of that type, not merely enough of them, because an added field moves the
ordinal onto a different member. Ambiguity refuses. Every resolution reports
which layer answered, so a feature running on a fingerprint is visible before the
next patch rather than after it.

The rules are written against `MetadataSource`, an interface, and tested against
a fake. Exercising them inside a live game would mean provoking exactly the
corruption they exist to prevent.

#### Beebyte inverts the layer ordering

The game ships obfuscated, and only partly. `ObjectProperties` and
`collisionRadiusMultiplier` survive intact; the class holding the player's
health is called `LKHPPBEGNOM` and its fields are eleven-letter nonsense. From a
name alone the two cases are indistinguishable, and the reference
implementation's deobfuscation map covers neither the player's class nor any of
its stat fields — so for the things a feature actually wants, there is no real
name to prefer.

That makes **the fingerprint the primary mechanism rather than the last resort**.
A renamed field's name holds only until the next rebuild renames it again; its
shape does not change with it.

Which forces one more rule: **a fingerprint may only be written from a game that
was running.** It is a claim about a class's layout, and one invented at a desk
is exactly the guess this section exists to forbid. So a resolution reports the
shape the live class gave it — `System.Int32 #1 of 2` — and those numbers are
transcribed into the query afterwards. A query with no fingerprint resolves by
name or goes quiet, which is the safe half of the trade.

The overlay's Inspector is how a name is found in the first place: it searches
the running game's class names and lists a class's fields and methods, so a new
offset starts from the game rather than from an older project that knows only
the names somebody already went and found. `docs/offsets.md` is the procedure,
including how to establish what a field actually holds — chiefly by comparing an
in-process read against the same value arriving in a packet, which the runtime
already parses.

## Performance, measured

Two instruments, both `npm run` scripts, both reporting rather than asserting:
`profile:ipc` times the runtime's per-tick paths with V8's own GC profiler
behind them, and `profile:link` loads the real module into a real host and
measures it from outside — idle cost, a signed round trip, and records per
second under saturation.

What the runtime costs on a realm with four hundred entities, split by what
drives it — a packet arriving, or the planning clock the combat features decide
on:

| path | driven by | time | allocated |
| --- | --- | --- | --- |
| decode a 40-entity `NEWTICK` | the tick | 62 µs | 22.7 KB |
| apply it to the world | the tick | 6 µs | 19.0 KB |
| every plugin's packet handler | the tick | 7 µs | 0.1 KB |
| a plan with nothing in the air | 40 Hz | 0.3 µs | 0.3 KB |
| a plan with 60 shots in the air | 40 Hz | 28 µs | 18.1 KB |

Five ticks a second and forty plans a second put that at a little over a
millisecond of event loop per second in a bullet hell, and well under one the
rest of the time — which is the number that matters: the proxy must never be
the reason a packet is late.

**Why the planners are not on the tick.** They were, and it cost up to 200 ms
of doing nothing: the server describes the world five times a second, so a
feature deciding on the tick holds an aim it could already have changed and
discovers a shot has entered its action window a fifth of a second after it
did. What arrives on a packet is a *sighting*; where to point and which way to
walk are arithmetic over it, and shot positions and enemy velocities are both
carried forward to the moment they are asked about. The cost of asking forty
times a second instead of five is the table above.

Three findings from taking those measurements, in the order they were acted on:

* **A generator per read is not free.** `enemies()` and `players()` were
  generators, so every combat feature walking them paid an iterator step and a
  result object per entity — twice a tick for auto-aim alone. Membership changes
  rarely and is read constantly, so the store now keeps arrays and rebuilds them
  when an object arrives or leaves. The plugin tick went from 53 µs and 93 KB to
  16 µs and 28 KB.
* **Dispatch walked every subscription three times per packet**, building a
  closure and a template string for each one to describe an error almost none of
  them had. Handlers are now indexed by packet name, and the description is
  built in the failing branch. 16 µs and 28 KB became 11 µs and 2.2 KB.
* **The decoder is the largest single cost and was left alone.** 64 µs and
  22.7 KB per `NEWTICK` is most of a tick, and it is inherent to building two
  hundred JavaScript objects from a schema. Five ticks a second makes it 0.03%
  of a core; a compiled-per-schema decoder would be a large change to the most
  safety-critical module in the project for a saving nothing can feel. Measured,
  understood, not done.

The module is measured the same way. It costs 0.00% of a core when nothing is
happening — the loop waits until the soonest of its jobs is due rather than
spinning — holds an 18.6 MB working set, and answers a signed liveness round
trip in 154 µs at the median.

Inside a frame the currency is *system calls*, not instructions: every read of
the player goes through `ReadProcessMemory`, because the pointers it follows are
freed between realms and dereferencing one would take the game down with us. The
self-check times one at about 460 ns. So the frame path is written to make as
few as possible — the chain is walked once per frame and handed to everything
that acts rather than once per feature, the two position floats are adjacent and
so are read together, and both are skipped entirely on a frame with nothing to
do. Ten reads a frame became four.

## Testing

`packages/protocol` is the most heavily tested module because it is pure and
because malformed network input is the most likely source of a crash:
round-trip encode/decode for every definition, framing under adversarial chunk
boundaries, and explicit cases for truncated headers, zero-length frames,
oversized declared lengths, unknown opcodes, invalid string lengths and
unexpected EOF.

`packages/ipc` is tested the same way: header validation, version mismatch,
sequence gaps, oversized payloads, partial frames.

The runtime is tested against fakes for sockets and the native link, so a
session can be driven end to end without a game or a network.

`Session` and `Engine` on the native side have no unit test, and that is the
right answer rather than a gap: their contract is a live peer, and a test against
a fake peer proves only that the fake agrees with the code under test. Their
contract is the *only* thing left there without one — everything the engine used
to do inline and could not test, it now delegates to a piece whose contract is a
value: `Inspection` against `FakeMetadata`, and the target and step arithmetic in
`PlayerControl` against numbers. What
proves something is `npm run test:link` — it builds the module and a host that
does what the game does (load `version.dll`, wait, unload it), starts the real
runtime, and checks that the session key was published and read, that the mutual
handshake completed, and that unloading tore everything down without deadlocking.
It needs no game; the overlay and IL2CPP layers stay dark in the host, but the
link has to work before either of those matters.

    link check passed: published, authenticated, closed cleanly

**What neither test reaches is the game layer.** The host has no IL2CPP and no
swap chain, so nothing that reads the game's metadata or draws a frame runs in
any test — which is why everything on those paths is written to be bounded
rather than to be caught.

The module once carried environment switches that turned each of those layers
off, to bisect a build that stopped the game from starting. They are gone: the
module has one mode — bind, draw, redirect — because a switch left set in an
environment the game inherits produces a module that loads, does nothing, and
looks exactly like a broken one.

## Decision log

| Decision | Why | Alternative rejected |
|---|---|---|
| One protocol implementation, data-driven from JSON | The old tree had three; the JSON already exists and survives game patches better than 200 hand-written classes | class-per-packet (nrelay style): 200 files to update per patch |
| JSON definitions stay JSON; codegen emits only typed ids | Keeps the wire format editable without a rebuild while still giving compile-time packet-name checking | baking definitions into a 2 500-line generated `.ts` (what the old tree did) |
| Framer as a separate component | TCP fragmentation is the single most common source of protocol bugs, and it is only testable in isolation | framing inline in the connection class |
| Named pipe kept for IPC | Correct primitive; the existing native side already speaks it | shared memory (harder lifetime), local TCP (needs port + ACL work) |
| Binary IPC header, mixed JSON/binary payload | Header must be cheap and versionable; control payloads benefit from being readable | JSON for everything (per-frame cost), binary for everything (undebuggable) |
| Per-message MAC dropped, connect-time auth kept | A MAC per message on an authenticated point-to-point pipe protects against no reachable attacker and costs a hash per frame | keep it "because it is more secure" |
| Sources discovered from disk for the native build | Removes an entire class of bug (project file drifting from disk) that the old tree needed two tools to police | explicit source list, `.vcxproj` as source of truth |
| One planner survives the dodge port, and it lives in the runtime, not the module | A dodge planner is arithmetic over game state, and the game state is already there; what must be in-process is reading memory and drawing, not deciding | keep all four "in case"; keep it in C++ because that is where it was |
| The hit test is a square (Chebyshev), not a circle | It is what the game does; a circle disagrees exactly at the corners, which is where a shot grazes | distance comparison, "close enough" |
| The module is installed as `d3d11.dll` | Measured: `version.dll` and `winhttp.dll` kill this Exalt build about a second in — even as Microsoft's own unmodified DLLs, and even as the old project's own proxy rebuilt from source. `d3d11.dll` is tolerated | `version.dll`, `winhttp.dll` — the obvious names, and the ones the old tree used |
| A claim about the game is settled by measuring it, never by reading its crash stack | Four diagnoses argued from that stack were each wrong; an exit code and a launched PID both lied about whether the game was alive — sample by process name instead | reasoning from the stack trace |
| IL2CPP reached only through its exported C API | Removes the generated headers, the per-Unity regeneration step, and the whole class of struct-layout bugs — including the uninitialised-class walk that crashed the old build | generated headers from a metadata dump, structs walked by hand |
| IL2CPP types left incomplete | Makes "no layout assumptions" a compile error instead of a convention | fully declared structs, discipline enforced by review |
| No offset is ever a constant, and none has a fallback | A stale offset that still "works" corrupts memory; one that refuses only disables a feature | hard-coded offsets with a fallback path (what the old tree shipped) |
| A field may be identified by its shape; a method may not, unless the query says so | A field got wrong reads a wrong number; a method got wrong is called or detoured through a prototype that does not describe it. `void(float)` identifies nothing — a class has many | the same fingerprint rule for both, which is what shipped a game that would not start |
| A class is asked about its members only once the runtime has built it | IL2CPP registers long before it prepares, and asking an unprepared class for its members faults inside `GameAssembly`. The whole-image sweep already guarded this; resolution did not | trusting that a class which can be found can be read |
| The module never initialises a class; it waits until the game has | `il2cpp_runtime_class_init` runs the class's *static constructor* — the game's own code, on our thread, at a moment the game has not reached. Adding one new class query was enough: its `.cctor` built a singleton through `MonoSingleton.get_instance()`, `ApplicationManager.Init` threw, and the game aborted before it could start. Asking about a class must not change the game | calling it on lookup "so field offsets are final", which is what the name suggests and what shipped |
| A detour is installed only when the feature that wants it is on | An offset costs nothing until something reads it; a hook is in the way of every call from the moment it exists — and a bad one takes the game down before its overlay can say why | install as soon as the method resolves |
| Every count and every string read out of the game is bounded before it is used | The module is built without exceptions, so a `throw` in the standard library is an `abort` — of the game. A length read from a structure the runtime has not finished writing is whatever those bytes held, and `reserve` on it ends the process with a CRT dialog and no stack | trusting the runtime's own accessors, which is what shipped a game that would not start |
| A fingerprint must match the recorded field *count*, not just the ordinal | An added field of the same type silently moves the ordinal onto a different member | match the ordinal alone, accept the first plausible field |
| IPC secret minted per run and published to `%LOCALAPPDATA%`, read per connection attempt | A secret in a shipped DLL is a secret everybody has; the file's audience is identical to the pipe's, so it costs no exposure and buys freshness | compile it in, ship it in a config file, derive it from something both sides "know" |
| Hooks are RAII, and removed by leaving scope | An unload happens at a moment the module does not choose; a hook that outlives its owner is a crash, not a leak | install-and-forget, removal only on clean shutdown (what the old tree did) |
| Stock ImGui, no theming; custom widgets draw from `ImGuiCol_*` | A widget that paints its own colours drifts from everything around it the moment the theme changes | a project theme, hand-picked colours per widget |
| Only the render thread touches ImGui; the window procedure queues | Window thread and render thread coincide only sometimes, and "usually the same" is not a threading model | call `ImGui_ImplWin32_WndProcHandler` straight from the window procedure, as most overlays do |
| `Present` found via a throwaway swap chain's vtable | The vtable belongs to the interface, so our own swap chain answers for the game's — no waiting, no walking its objects, nothing to revise per Windows update | byte-pattern scan of `dxgi.dll` |
