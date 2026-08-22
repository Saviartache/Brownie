# IL2CPP metadata and dump reference

Notes preserved from the original Python tool before its source was deleted, to
guide the il2cpp dump implementation. The Go implementation lives in
`internal/il2cpp` and follows the same bundled-binary pattern as
[`tools/assetripper`](../tools/assetripper/README.md). Cpp2IL and
Il2CppDumper are available as selectable backends.

## Inputs

- **GameAssembly** binary — `GameAssembly.dylib` (macOS), `GameAssembly.dll`
  (Windows), `GameAssembly.so` (Linux). Already located by `localsrc.Build.GameAssembly`.
- **`global-metadata.dat`** — already located by `localsrc.Build.Metadata`.

## Metadata recovery (`internal/metadata`)

RotMG obfuscates `global-metadata.dat` on **Windows** with an XXTEA-encrypted,
shuffled custom header, two XOR-masked heaps, and a payload shifted by `0x1E4`.
The **macOS** build ships ordinary metadata beginning with `0xFAB11BAF` and is
validated/copied without decryption.

No per-build key or shuffled-header field offsets are hardcoded. Recovery now:

1. Locates the generated key getter in the PE by its consecutive RIP-relative
   `movdqa` loads (both the older two-load and current three-load forms).
2. Reads the encoded literal constants through PE RVA-to-file mapping.
3. Solves the repeating eight-byte XOR mask by constraining the plaintext to
   lowercase hexadecimal and verifies the candidate with XXTEA's plaintext
   length word.
4. Applies the native post-XXTEA fixups.
5. Discovers the shuffled table descriptors by arithmetic relationships in the
   custom header and semantic checks on the literal and managed-string heaps.
6. Unmasks the two protected heaps and writes all 31 metadata-v31 tables behind
   a clean standard `0x100`-byte header.
7. Rejects the output unless ranges, record sizes, the string heap, and every
   type-definition name/namespace index validate.

The stable loader constants retained from the native algorithm are:

| Constant | Meaning |
|----------|---------|
| `lenOffBase` (`0x2F1AF`) | base for the encrypted-header length-seed offset |
| `teaLenAdd` (`0x621CF`) | added to the seed for the XXTEA block length |
| `shift` (`0x1E4`) | custom on-disk payload shift |
| post-XXTEA fixups | swap first/last header bytes; XOR byte 9 with `0x27` and byte 5 with `0x59` |
| literal-data XOR | byte `i` XOR `(0x0D-i)` |
| managed-string XOR | byte `i` XOR `(i+0x5F)` |

The main binary exposes `extractor packets`, `extractor handlers`, and
`extractor diff`; `cmd/metatool` also exposes recovery/decryption and arbitrary
namespace listing. Handler discovery parses v31 method/parameter/image records,
locates `Assembly-CSharp.dll`'s `Il2CppCodeGenModule`, resolves method tokens to
native RVAs, decodes `AddListener` call sites and MethodDef metadata usages, and
emits packet IDs plus relocation-normalized x86-64 code fingerprints. Normal
publishing writes the build and handler inventories/diffs automatically.

## Packet ID and callback recovery

`extractor packets` automatically discovers a nearby realmlib checkout and
imports `src/packet-map.ts`. When `src/create-packet.ts` is available it also
recovers the packet class and Incoming/Outgoing direction. The external map is
treated as a versioned seed, not as proof:

1. The realmlib row supplies `numeric ID -> PacketType`.
2. The factory supplies its class and expected direction.
3. Exalt's embedded unobfuscated catalog verifies that the friendly class name
   exists in the inspected build and under the expected namespace.
4. Native `SocketManager.AddListener` calls independently establish current
   ID-to-listener bindings and their exact managed callback MethodDefs.
5. Direction remains attached to the concrete packet mapping: the listener bus
   can observe both Incoming and Outgoing messages, so registration alone is
   not treated as direction evidence.

Use `--packet-map PATH` with either a realmlib root, `packet-map.ts`, or a JSON
object in `{"14":"TRADEACCEPTED"}` / `{"TRADEACCEPTED":14}` form. An empty
path checks `REALMLIB_PACKET_MAP` and nearby sibling/node_modules locations.
`--no-packet-map` disables enrichment.

`extractor handlers --factory BUILD` performs a separate, stronger recovery:
it locates byte-to-message lookup methods, uses PE `.pdata` records for exact
native bounds, expands IL2CPP generic instances to their concrete arguments,
joins cached factory delegates to static-field offsets, and decodes MSVC's
compressed byte switch tables. The resulting ID-to-obfuscated-TypeDef links
come from `GameAssembly.dll`; realmlib only annotates them with friendly names.
JSON preserves the native evidence and any explicitly heuristic name
candidates. Two-build handler diffs compare these factory ID sets as well as
listener bindings and native code fingerprints.

The handler scanner also decodes RIP-relative TypeInfo/Type metadata usages and
direct native calls in each callback body. For map gaps it ranks friendly-name
candidates from the callback's manager/subsystem and the current catalog, but
keeps these in a separate `unmapped_candidates` collection with explicit
scores. Two-build handler diffs separately report stable methods whose listener
ID sets changed. `--managed-type NAME` includes every method belonging to a
selected friendly or obfuscated type for call/type-reference inspection.

## Current Go invocation (Cpp2IL)

The pipeline prepares `game_files/global-metadata.decrypted.dat`, stages a
minimal Cpp2IL game folder, then runs Cpp2IL into `il2cpp_dump/`.

With `il2cpp.cpp2il.full_dump: true`, it first runs:

```
Cpp2IL --list-output-formats
```

Then each listed format is run separately:

```
Cpp2IL \
  --game-path=<staged-game-dir> \
  --exe-name=RotMGExalt \
  --output-to=<out>/il2cpp_dump/cpp2il/<format> \
  --output-as=<format>
```

Logs are written to `il2cpp_dump/logs/`, and `manifest.json` records selected
formats, command arguments, durations, input hashes, and errors.

## Original Python invocation (Il2CppInspector)

```
Il2CppInspector \
  --bin <GameAssembly> \
  --metadata <global-metadata.dat> \
  --layout class \
  --select-outputs \
  --py-out   <out>/il2cpp.py \
  --json-out <out>/metadata.json \
  --cs-out   <out>/types \
  --cpp-out  <out>/cpp
```

Output directory (publish as `il2cpp_dump/`): `il2cpp.py`, `metadata.json`,
`types/` (C# stubs), `cpp/`.

## Tooling notes

- The old repo bundled **Il2CppInspector** binaries (`Il2CppInspector-linux`,
  `Il2CppInspector-cli-win.exe`, + plugins) and an `unpacker-*` for the
  launcher. There was **no macOS binary**, so they are unusable on the current
  dev machine (mac/arm64). They were removed with `src/` and remain recoverable
  from git history if needed.
- This build is **Unity 6 (6000.0.58f2)**; Il2CppInspector's support for that
  metadata version is uncertain. **Cpp2IL** is the primary supported backend —
  bundle it under `tools/il2cpp/cpp2il` and resolve the per-OS binary like
  AssetRipper.

## Namespaces of interest

`metatool names` and `builddiff -namespace` accept these useful namespace
suffixes. Child namespaces are included automatically:

| Purpose | Namespace |
|---------|-----------|
| Incoming packets | `Net.SocketServer.Messages.Incoming` |
| Outgoing packets | `Net.SocketServer.Messages.Outgoing` |
| Data packets | `Net.SocketServer.Messages.Data` |
| Pool managers | `Managers.Pool` |
| Debug tools | `DebugTools` |

## Il2CppDumper backend (roadmap item #3)

[Perfare/Il2CppDumper](https://github.com/Perfare/Il2CppDumper) is wired in as a
selectable backend (`il2cpp.backend: il2cppdumper`), implemented in
`internal/il2cpp/il2cppdumper.go`.

Invocation: `Il2CppDumper <GameAssembly> <global-metadata.dat> <output-dir>`
(the managed `Il2CppDumper.dll` is run as `dotnet Il2CppDumper.dll ...`). It reads
`config.json` from the binary's directory; the backend ensures
`RequireAnyKey: false` so it never blocks on a prompt, and sets
`ForceIl2CppVersion`/`ForceVersion` when `force_version` is configured.

Outputs: `DummyDll/`, `dump.cs`, `il2cpp.h`, `script.json`, `stringliteral.json`
(plus IDA/Ghidra/BinaryNinja scripts) under `il2cpp_dump/`.

Older Il2CppDumper releases cover the metadata-v29 era but may reject the
current metadata-v31 layout even after successful decryption. Use a backend
release which explicitly supports Unity 6000/v31; `force_version` is retained
for genuinely older builds and should not be used to relabel a v31 file.
