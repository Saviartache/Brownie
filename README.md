# Brownie

A MITM proxy and automation runtime for Realm of the Mad God (Exalt) on
Windows x64, plus an injected native module that talks to the game process
directly.

## Components

| Component | What it is |
|---|---|
| `packages/protocol` | The RotMG wire protocol. Pure, no I/O, no dependencies. |
| `packages/ipc` | The Node ⇄ native contract: framing, envelope, records. |
| `packages/plugin-api` | The types a plugin author compiles against. |
| `apps/runtime` | The Node process: proxy, packet pipeline, state, plugin host. |
| `apps/native` | The injected C++ module: IL2CPP hooks and the ImGui overlay. |
| `tools/gamedata` | Extracts the game's own data files from the installed game. |
| `tools/rotmg-extractor` | Go tool: IL2CPP metadata recovery and decryption, build diffs. |

Read [`docs/architecture.md`](docs/architecture.md) before changing anything
structural — it records why the boundaries are where they are.
[`docs/protocol.md`](docs/protocol.md) and [`docs/ipc.md`](docs/ipc.md) are the
two wire contracts; the C++ side implements the latter independently, so that
document — not either implementation — is the specification.
[`docs/offsets.md`](docs/offsets.md) is the procedure for finding where
something lives in the game's memory and proving it is what you think it is —
read it before adding an offset, and again after a game patch.

## Status

Under construction. What is finished and green:

- [x] Discovery pass over the reference implementation
- [x] Architecture and layer boundaries
- [x] Toolchain: TypeScript (strict), ESLint, Prettier, Vitest
- [x] `packages/protocol` — framing, RC4, binary codecs, schema loader,
      registry, decode/encode, 73 tests
- [x] `packages/ipc` — frame header, framer, sequence guard, message codec,
      handshake, overlay record codec, 71 tests
- [x] `packages/plugin-api` — plugin contract, capability context, typed
      settings, `MutablePacket`, 13 tests
- [ ] `apps/runtime` — in progress: logging, transport with backpressure,
      peer links, packet pipeline, proxy session, world/self state and the
      state stage, plugin host with settings and commands, native link and
      pipe server, proxy server, configuration, overlay control plane,
      composition root, plugin discovery and hot reload, game-data catalogs,
      projectile tracking — **it runs** (186 tests)
- [ ] `apps/native` — in progress: build (Zig, sources discovered from disk),
      `core/` (Result, RAII handles), `ipc/` (frame codec, frame reader,
      cancellable pipe, handshake, flat JSON, session), self-check. Still to
      come: engine lifecycle, IL2CPP layer with the self-healing offset table,
      hooks, the ImGui overlay, one dodge planner.
      The session is not covered by the self-check — it needs a live peer, so
      the honest test for it is an end-to-end run against the Node runtime.

## Requirements

| | |
|---|---|
| Node | 22 or newer |
| OS | Windows x64 (the native module is a Win32 DLL; the proxy alone is portable) |
| C++ toolchain | the pinned Zig toolchain — no Visual Studio needed |
| Optional | `clang-format` and `clang-tidy` for the native module |

## Getting started

```bash
npm install
npm run check
```

`check` runs, in order: typecheck, lint, format check, tests. It is what CI
runs and what a change is expected to pass before it lands.

Individually:

```bash
npm run build        # tsc project references
npm test             # vitest
npm run test:watch
npm run lint
npm run format
```

Two profilers, for when a change is meant to make something cheaper. Neither
asserts anything — they report, so a change has a before and an after:

```bash
npm run profile:ipc    # the Node hot paths: ns/op, allocations, frames on the wire
npm run profile:link   # the real module over a real pipe: idle cost, latency, throughput
```

## Building the native module

```bash
npm run build:native     # apps/native/build/version.dll
npm run test:native      # builds and runs the self-check
```

The compiler is Zig's clang, installed as an ordinary dev dependency — no
Visual Studio and no separate SDK, with the version pinned in the lockfile like
everything else. `ZIG=<path>` overrides it.

**Sources are discovered from disk.** The reference implementation's build
parsed a Visual Studio project file for its source list, so a file added on disk
but not in the project silently vanished from the binary — and needed two more
tools whose only job was to police that drift. `node apps/native/build.mjs
--list` prints exactly what will be compiled.

## Running

```bash
npm run build
node apps/runtime/dist/main.js
```

Configuration is layered: built-in defaults ← `config/runtime.json` ←
environment. A missing config file is normal — defaults plus the environment
are a complete configuration.

| Key | Environment | Default |
|---|---|---|
| `proxy.host` / `proxy.port` | `BROWNIE_PROXY_HOST` / `BROWNIE_PROXY_PORT` | `127.0.0.1:2050` |
| `servers.allow` | — | `[]` — a session is refused unless its target is listed |
| `native.secret` | `BROWNIE_NATIVE_SECRET` | none, which disables the overlay |
| `native.pipeName` | `BROWNIE_NATIVE_PIPE` | `brownie-bridge` |
| `logging.level` | `BROWNIE_LOG_LEVEL` | `info` |
| `logging.file` | `BROWNIE_LOG_FILE` | none — terminal only |
| `gameData.directory` | `BROWNIE_GAME_DATA_DIR` | none — objects and tiles stay unclassified |
| `plugins.directory` | `BROWNIE_PLUGIN_DIR` | `plugins` |

The overlay is enabled by *having a shared secret*, not by a separate flag: a
`true` that cannot authenticate is a configuration that fails later rather than
at startup. Without one the proxy runs perfectly well and says the overlay is
off.

Setting `logging.file` writes the same lines the terminal gets to a file as
well, **truncated on every start** so it always holds exactly one run — which is
what makes "what did it say when that happened?" answerable by someone who was
not watching, and greppable. `npm run live` sets it to `logs/runtime.log`
without being asked, because bring-up is precisely when that question comes up.

## Writing a plugin

The API is defined; the host that runs it is not built yet. See
[`docs/plugins.md`](docs/plugins.md).

```ts
import { definePlugin, PluginCategory } from '@brownie/plugin-api';

export default definePlugin({
  meta: { id: 'auto-nexus', name: 'Auto Nexus', category: PluginCategory.Combat },
  setup(ctx) {
    const threshold = ctx.settings.range('hpPercent', { default: 25, min: 1, max: 99 });
    ctx.packets.onFirst('NEWTICK', (packet, session) => {
      const { hp, maxHp } = session.self;
      if (maxHp > 0 && (hp / maxHp) * 100 <= threshold.get()) {
        session.sendToServer('ESCAPE', {});
      }
    });
  },
});
```

## Where the game's data comes from

`objects.xml` and `tiles.xml` are the game's own files, shipped inside its Unity
asset bundle. They are **not** checked in: they are 30 MB, they belong to Deca,
and they change with every patch. Extract them from your own install:

```bash
npm run gamedata extract
```

| Command | What it does |
|---|---|
| `npm run gamedata where` | prints where the game was found |
| `npm run gamedata extract` | writes `objects.xml`, `tiles.xml`, enchantment data and a manifest to `./game-data` |
| `npm run gamedata check` | exits non-zero if the extracted data no longer matches the install |

Point the runtime at the result with `gameData.directory` (or
`BROWNIE_GAME_DATA_DIR`). The manifest records which asset bundle the data came
from, so the runtime warns at startup when the game has been patched since:

```
warn  brownie  game data is out of date — the installed game no longer matches
                what this data came from
warn  brownie  run `npm run gamedata extract` to refresh it
```

Extraction is a separate tool rather than something the runtime does on its own,
because it reads a 375 MB bundle, needs to run once per game patch rather than
once per launch, and produces files a person may want to inspect or copy to
another machine.

## IL2CPP metadata

`tools/rotmg-extractor` is a separate Go program that recovers and decrypts the
game's `global-metadata.dat`, catalogs packet names, finds native packet
handlers and diffs builds. The native module needs its output to resolve IL2CPP
classes after a game patch — the metadata is encrypted, so it cannot simply be
read off disk.

It is kept as its own tool, in its own language, because that is what it already
is: a working program with its own release cycle. Vendoring it into this build
would mean maintaining a rewrite of it.

```sh
cd tools/rotmg-extractor
go build -o extractor ./cmd/extractor && ./extractor -once
```

## Where the packet definitions are

`packages/protocol/data/packet-definitions.json` and
`packages/protocol/data/stat-types.json`. They are data, not generated code: a
game patch that moves a field is a JSON edit, validated and round-tripped by
`npm test`, with no rebuild. See [`docs/protocol.md`](docs/protocol.md).

## Layout

```
packages/protocol/
├── data/                 packet + stat definitions (the source of truth)
├── src/
│   ├── binary/           bounds-checked big-endian reader / writer
│   ├── crypto/           RC4
│   ├── framing/          frame layout, TCP-aware framer
│   ├── schema/           definition types, validating loader
│   ├── registry/         id ⇄ name ⇄ schema
│   └── codec/            decode / encode
└── test/
```

## License

See [LICENSE](LICENSE).
