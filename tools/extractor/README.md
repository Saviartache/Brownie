# RotMG Resource Extractor (Go)

Automatically watches RotMG (Realm of the Mad God) builds, extracts Unity game
data, publishes versioned output, writes changelogs, and can optionally run
IL2CPP dump tools against `GameAssembly` + `global-metadata.dat`.

This is a Go rewrite of the original Python extractor.

> **Status:** local/remote extraction, automatic Windows metadata key recovery,
> metadata decryption, packet-name catalogs, native packet-handler discovery,
> semantic build diffs, and optional IL2CPP dump backends are implemented. The
> native Unity TextAsset path is the default.

## Usage

Build once, then run either a single pass or the polling loop:

```sh
go build -o extractor ./cmd/extractor
go build -o metatool ./cmd/metatool
go build -o builddiff ./cmd/builddiff
go build -o handlers ./cmd/handlers
./extractor -once
./extractor
```

Run directly during development:

```sh
go run cmd/extractor/main.go -once
```

Useful flags:

| Flag | Default | Description |
|------|---------|-------------|
| `-config` | `extractor.yml` | Path to the YAML config file. Missing file is allowed; built-in defaults are used. |
| `-once` | `false` | Run one pass and exit instead of polling forever. |
| `-il2cpp-only` | `false` | Run only the configured IL2CPP dump against an existing client build. |
| `-il2cpp-env` | `""` | Platform/env for `-il2cpp-only`; defaults to local `Production` or the first remote platform. |
| `-il2cpp-format` | `""` | Comma-separated Cpp2IL output format override for `-il2cpp-only` (Cpp2IL backend only). |
| `-il2cpp-tool` | `""` | IL2CPP backend override for `-il2cpp-only`, e.g. `il2cppdumper` or `cpp2il`. |

### Common Commands

Remote Windows client/launcher pass:

```sh
go run cmd/extractor/main.go -once
```

Rerun only Cpp2IL against the already-downloaded remote Windows client files:

```sh
go run cmd/extractor/main.go -once -il2cpp-only -il2cpp-env windows -il2cpp-format dummydll
```

Run every Cpp2IL output format configured by `il2cpp.cpp2il.full_dump`:

```sh
go run cmd/extractor/main.go -once -il2cpp-only -il2cpp-env windows
```

`-il2cpp-only` is designed for fast iteration. In remote mode it reads
`output/buildfiles/<env>/client`, so it works best with `source.incremental:
true`.

## Metadata and Build Inspection

The inspection commands accept either a versioned publish directory, its
`game_files` directory, or a direct `global-metadata.dat` path. When metadata is
obfuscated, they locate `GameAssembly.dll`, recover the build's XXTEA key, and
reconstruct a validated metadata v31 file automatically.

Inspect a build and show the recovered key, table count, and managed type count:

```sh
go run ./cmd/metatool info "output/publish/windows/client/6.12.0.2.0-<hash>"
```

Write ordinary metadata for Cpp2IL, Il2CppDumper, or another IL2CPP tool:

```sh
go run ./cmd/metatool decrypt -out global-metadata.decrypted.dat \
  "output/publish/windows/client/6.12.0.2.0-<hash>"
```

List every Incoming, Outgoing, and Data packet directly through the main
extractor. Child namespaces such as `Incoming.Trade` are included. This uses
RotMG's embedded unobfuscated type catalog, so packet names remain available
when the corresponding IL2CPP class names are obfuscated:

```sh
go run ./cmd/extractor packets "output/publish/windows/client/6.12.0.2.0-<hash>"
go run ./cmd/extractor packets -direction outgoing "<build>"
go run ./cmd/extractor packets -direction incoming -out incoming.txt "<build>"
go run ./cmd/extractor packets -json -out packets.json "<build>"
go run ./cmd/extractor packets -packet-map ../realmlib "<build>"
```

When realmlib is checked out beside the extractor, `packets` automatically
joins `src/packet-map.ts` and `src/create-packet.ts` to the current client's
embedded catalog. Text output prints the numeric ID beside every reconciled
Incoming/Outgoing name and `?` beside names absent from the supplied map. JSON
preserves every map row, enum/class name, direction, confidence, provenance,
catalog match, conflict, and the current catalog's unmapped names. Use
`--no-packet-map` for a metadata-only inventory, `--packet-map PATH` for an
explicit realmlib root/TypeScript file/JSON map, or set
`REALMLIB_PACKET_MAP`.

Find the actual managed and native packet handling functions. This resolves the
`Assembly-CSharp.dll` codegen module, metadata type table, method tokens, native
RVAs, and IL2CPP delegate registrations without Cpp2IL. Registered callbacks
include the packet IDs loaded at each `SocketManager.AddListener` call:

```sh
go run ./cmd/extractor handlers "<build>"
go run ./cmd/extractor handlers -json -out handlers.json "<build>"
go run ./cmd/extractor handlers -packet-id 92 "<build>"
go run ./cmd/extractor handlers -match AcceleratorsManager "<build>"
go run ./cmd/extractor handlers -match Trade "<build>"
go run ./cmd/extractor handlers -packet-map ../realmlib "<build>"
go run ./cmd/extractor handlers -managed-type SocketManager "<build>"
go run ./cmd/extractor handlers -returns-type OODFCLBKDJJ "<build>"
go run ./cmd/extractor handlers -factory "<build>"
```

Handler reports use native `AddListener` registrations as the authority for
ID-to-listener bindings, then enrich those IDs with realmlib names and
current-client catalog matches. `AddListener` is an event bus and is not, by
itself, evidence that a packet is incoming; direction comes from the concrete
packet mapping. For IDs absent from realmlib, the report ranks current-catalog
name suggestions from handler subsystem/type evidence and labels them as
heuristic rather than silently asserting a match. Callback entries include
metadata type references and direct native call targets. `--managed-type`
includes every method on a selected obfuscated or friendly type for deeper
inspection.

`--factory` goes beyond listener correlation. It finds the actual client
message factories, decodes constructed generic types such as
`Func<ObfuscatedPacket>`, recovers compressed native byte-switch tables, and
prints exact `packet ID -> managed packet type` bindings. A nearby realmlib map
adds friendly names but is not the source of the numeric binding. Unmapped
native types retain evidence-ranked name candidates from their managed method
signatures; candidates are visibly marked as heuristic.

Compare the important packet gateway, registration, and callback code between
two builds:

```sh
go run ./cmd/extractor handlers OLD_BUILD NEW_BUILD
go run ./cmd/extractor handlers -json -out handler-diff.json OLD_BUILD NEW_BUILD
```

The code fingerprint decodes x86-64 instructions and normalizes relocated call
and RIP-relative addresses. A changed fingerprint therefore reflects an
instruction/constant/field-access change rather than ordinary binary layout
shuffling. The diff separately reports packet-listener binding changes (IDs
added to or removed from an otherwise stable callback), instead of mixing them
with native code changes. It also compares the native factory ID sets, so a
newly constructible packet ID is reported independently of handler churn or
obfuscated method renaming. Packet callback type and method names may still be
obfuscated; the report preserves their managed tokens, RVAs, owner types,
signatures, packet IDs, confidence, referenced types, direct calls, and the
evidence used to classify them.

Compare two builds through the main extractor:

```sh
go run ./cmd/extractor diff OLD_BUILD NEW_BUILD
```

The report includes recovered-key rotation, exact recursive file changes,
managed type changes, string-literal changes, and Incoming/Outgoing/Data packet
catalog changes. Generated logs, timestamps, and changelogs are hidden by
default. Useful options are:

```sh
go run ./cmd/extractor diff -literals OLD_BUILD NEW_BUILD
go run ./cmd/extractor diff -all-types OLD_BUILD NEW_BUILD
go run ./cmd/extractor diff -json -out build-diff.json OLD_BUILD NEW_BUILD
go run ./cmd/extractor diff -namespace Managers.Pool OLD_BUILD NEW_BUILD
```

`cmd/builddiff` and `cmd/handlers` remain standalone aliases for scripting.
`metatool names` also supports arbitrary namespace catalogs, while `extractor
packets` is the focused protocol inventory command.

## Source Modes

`source.mode: local` extracts an installed RotMG build on disk. If
`source.local_path` is empty, the extractor tries OS-specific default install
locations.

`source.mode: remote` fetches build information from the RotMG endpoints and
downloads either the selected essential files or the full manifest. With
`source.incremental: true`, downloaded client files are kept under
`output/buildfiles/<platform>/client` and reused between runs.

Launcher builds are downloaded and published as raw installers. They are not
unpacked yet.

## How It Works

For each configured platform/build type, the pipeline does the following:

1. Resolve the build source.
   Local mode locates an installed Unity IL2CPP build. Remote mode fetches build
   settings and downloads the client manifest files or launcher installer.
2. Check whether the build is new.
   Client builds use the metadata/build hash marker in `publish/.../current`.
   If the hash matches, the pass exits early.
3. Archive native game files.
   Client builds copy `global-metadata.dat`, `GameAssembly`, and `UnityPlayer`
   into `game_files/` for the immutable versioned archive.
4. Extract Unity assets.
   The default `native` backend extracts TextAssets from Unity SerializedFiles.
   The optional `assetripper` backend exports broader Unity asset content.
5. Merge game XML.
   Extracted XML files are consolidated into `merged/object.xml`,
   `merged/ground.xml`, and `merged/misc.xml`.
6. Prepare IL2CPP metadata.
   If enabled, the Windows key is recovered from `GameAssembly`, the shuffled
   tables are rebuilt and validated, and the result is written to
   `game_files/global-metadata.decrypted.dat`. Already-valid metadata is copied
   through.
7. Dump IL2CPP, optionally.
   Cpp2IL runs after metadata preparation and writes to `il2cpp_dump/`.
   Failures warn by default or fail the build when `il2cpp.required: true`.
8. Diff and publish.
   The extractor compares against the newest immutable archive and writes
   `build-diff.txt` plus `build-diff.json` with native-file, managed-type,
   string-literal, and packet-catalog changes. The work directory is then
   archived, `current/` is updated, and `changelog.md` is written.
9. Notify.
   Discord notification is sent when configured.

## Output Layout

```text
<output.dir>/
  buildfiles/<env>/client/              persistent remote client files when source.incremental=true
  temp/
    files/<env>/<build>/                transient downloads or local snapshots
    work/<env>/<build>/                 work-in-progress output for the current pass
  publish/<env>/<build>/
    <version>-<hash>/                   immutable archive of a processed build
      game_files/                       native binaries + original/decrypted metadata
      extracted_assets/                 raw extracted Unity assets
      merged/{object,ground,misc}.xml
      il2cpp_dump/                      optional Cpp2IL output, logs, manifest
      changelog.md
      build-diff.txt                    automatic semantic diff vs. previous archive
      build-diff.json                   complete machine-readable diff
      packets.txt                       Incoming, Outgoing, and Data packet names
      packets.json                      machine-readable packet catalog
      handlers.txt                      packet gateways, callbacks, IDs, RVAs, evidence
      handlers.json                     machine-readable handler inventory
      handler-diff.txt                  normalized native handler-code changes
      handler-diff.json                 machine-readable handler diff
      build_hash.txt
      exalt_version.txt
      timestamp.txt
    current/                            latest build, excluding game_files
```

`game_files/` is intentionally omitted from `current/` to avoid duplicating large
native binaries. It remains available in each versioned archive. The generated
packet catalog is retained in `current/`, so `extractor packets
<publish-dir>/current` works without the native files.

## Extraction Backends

| Backend | Status | Output | Needs a binary? | Notes |
|---------|--------|--------|-----------------|-------|
| `native` | Supported, default | Unity TextAssets as `.xml`, `.json`, `.txt` | No | Pure Go. This is the normal game-data path used by merge/diff/changelog. |
| `assetripper` | Supported | Broader Unity asset export | Yes, AssetRipper | Heavier. Useful for textures/sprites/meshes. XML merge may no-op when text exports as `.bytes`. |
| `cpp2il` | Supported as optional IL2CPP dump | Cpp2IL output formats under `il2cpp_dump/cpp2il/<format>/` | Yes, Cpp2IL | Configured under `il2cpp.cpp2il`. Can run all listed formats or a selected format. Requires compatible metadata/tool support. |
| `il2cppdumper` | Supported as optional IL2CPP dump | DummyDll, `dump.cs`, `il2cpp.h`, `script.json`, `stringliteral.json` under `il2cpp_dump/` | Yes, Il2CppDumper | Selected by `il2cpp.backend: il2cppdumper`. Older releases target metadata v16–29 and may not understand the current v31 layout; use a compatible current binary. Native executable or `Il2CppDumper.dll` via `dotnet`. |

## Configuration Reference

All keys are optional. The values below show built-in defaults, not necessarily
the local sample file.

```yaml
source:
  mode: local              # "local" | "remote"
  platforms: [windows]     # remote platforms: "windows", "macos"
  local_path: ""           # local install root; empty = auto-discover
  snapshot: false          # copy the whole Data dir into output/temp/files
  copy_game_files: true    # archive GameAssembly/UnityPlayer/metadata
  full_download: false     # remote: download all manifest files instead of essentials
  incremental: false       # remote: keep reusable files in output/buildfiles

build:
  version_override: ""     # fallback when Exalt version cannot be detected

extraction:
  backend: native          # "native" | "assetripper"
  decrypt_metadata: true   # prepare global-metadata.decrypted.dat for IL2CPP tools

il2cpp:
  enabled: false           # run IL2CPP dumping after asset extraction
  required: false          # true = fail build when IL2CPP dump fails
  timeout_minutes: 10      # per dumper command; 0 disables timeout
  backend: cpp2il          # "cpp2il" | "il2cppdumper"
  cpp2il:
    dir: tools/il2cpp/cpp2il  # directory containing Cpp2IL, or the binary path itself
    binary: ""                # explicit binary override
    full_dump: true           # list and run every available Cpp2IL output format
    formats: [dll_il_recovery] # fallback or explicit list when full_dump=false
    processors: []            # Cpp2IL processing layers
    extra_args: []            # appended to every Cpp2IL invocation
    verbose: false
    continue_on_fail: true    # keep trying formats after one format fails
  il2cppdumper:
    dir: tools/il2cpp/il2cppdumper  # directory containing Il2CppDumper, or the binary/dll path itself
    binary: ""                      # explicit binary override (native exe or Il2CppDumper.dll)
    extra_args: []                  # appended to every Il2CppDumper invocation
    force_version: ""               # set ForceIl2CppVersion (metadata major, e.g. "29") when auto-detect fails
    keep_config: false              # leave an existing config.json next to the binary untouched

assetripper:
  dir: tools/assetripper   # directory holding AssetRipper.GUI.Free[.exe]
  port: 0                  # 0 = choose a free local port
  export: primary          # "primary" | "project"

notify:
  discord:
    enabled: false
    webhook_url: ""
    role_id: ""

poll:
  client_check_delay_minutes: 5
  launcher_check_delay_minutes: 30

output:
  dir: ./output
  keep_builds: 0           # 0 = keep all versioned builds

logging:
  level: debug             # debug | info | warn | error
  console: true
  colors: true
  file: true
```

## IL2CPP Dumping Notes

Cpp2IL is configured separately from Unity asset extraction. Enable it with:

```yaml
il2cpp:
  enabled: true
```

Place the native Cpp2IL executable at `tools/il2cpp/cpp2il`, place an
OS-specific binary inside that directory, or set `il2cpp.cpp2il.binary`.

The pipeline stages a minimal Cpp2IL game folder under
`il2cpp_dump/_input`, swaps in `game_files/global-metadata.decrypted.dat`, and
runs Cpp2IL with absolute `--game-path` and `--output-to` paths. The temporary
staging folder is removed after the run. Logs and `manifest.json` are retained.

For Unity 6000 builds, older Cpp2IL binaries may not support metadata version
31. If that happens, test with a current backend and a single format first:

```sh
go run cmd/extractor/main.go -once -il2cpp-only -il2cpp-env windows -il2cpp-format dummydll
```

Then inspect:

```text
output/temp/work/windows/client/il2cpp_dump/logs/dummydll.log
output/temp/work/windows/client/il2cpp_dump/manifest.json
```

### Il2CppDumper backend

Select Perfare's [Il2CppDumper](https://github.com/Perfare/Il2CppDumper) instead
of Cpp2IL with:

```yaml
il2cpp:
  enabled: true
  backend: il2cppdumper
```

Place the executable at `tools/il2cpp/il2cppdumper/` (a native `Il2CppDumper`/
`Il2CppDumper.exe`, or the cross-platform `Il2CppDumper.dll`, which is run via
`dotnet`), or set `il2cpp.il2cppdumper.binary`. The backend takes `GameAssembly`
and the dumpable `global-metadata.dat` as direct arguments — no staged game
folder — and writes `DummyDll/`, `dump.cs`, `il2cpp.h`, `script.json`, and
`stringliteral.json` to `il2cpp_dump/`, plus `logs/` and `manifest.json`.

It writes a `config.json` next to the binary with `RequireAnyKey: false` so it
runs non-interactively (set `keep_config: true` to manage that file yourself). If
metadata-version auto-detection fails, set `force_version` (e.g. `"29"`).

Iterate against an already-downloaded build without re-extracting:

```sh
go run cmd/extractor/main.go -once -il2cpp-only -il2cpp-tool il2cppdumper
```

`-il2cpp-format` applies to the Cpp2IL backend only.

## Platform Notes

The default `native` backend and pipeline code are pure Go. AssetRipper, Cpp2IL,
and the Il2CppDumper backend require platform-appropriate external
binaries.

The downloader can fetch Windows builds while running on macOS or Linux. IL2CPP
tools still need to support analyzing that target binary format.

## Development

```sh
go test ./...
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
```

## Roadmap

- **Try/update newer Cpp2IL builds** for Unity 6000 metadata support.
- **Improve IL2CPP result normalization** so common outputs can be compared
  across Cpp2IL and Il2CppDumper.
- **Launcher unpacking** for `.exe`/`.dmg`/`.pkg` installers.
- **Additional delivery targets** such as SSH, FTP, Redis pub-sub, or other
  publish/notify sinks.
