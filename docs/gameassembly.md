# Fast GameAssembly Investigation

Use this checklist to identify one managed member, native RVA, packet handler,
or runtime field with the least expensive evidence first. The default is fully
offline. Cheat Engine is a last resort, never the starting point.

This document covers static metadata and recovered IL2CPP code. Use
`offsets.md` only when a live object layout genuinely must be verified.

## Non-negotiable rules

- [ ] State one concrete question before searching. Good: "Which local-player
      setter changes the active skin field?" Bad: "Find how skins work."
- [ ] Write the expected evidence before choosing a tool: owner type, method
      signature, field type, packet id, XML tag, or known caller.
- [ ] Use the matching `GameAssembly.dll` and `global-metadata.dat` from one
      explicit build directory. Never mix builds.
- [ ] Search recovered C# and ISIL before metadata tools, native disassembly, or
      live inspection.
- [ ] Prefer one exact class and member over a repository-wide semantic search.
- [ ] Follow wrappers one call deeper. A field assignment plus a call is not the
      complete behavior.
- [ ] Find every read and write of a candidate field before declaring its
      purpose. Adjacent fields and near-identical setters are common.
- [ ] Treat names, signatures, RVAs, and offsets as candidates until control flow
      confirms how the value is selected and consumed.
- [ ] Stop when the evidence answers the question. Do not continue collecting
      addresses "just in case."
- [ ] Ask the user immediately before every Cheat Engine session. Earlier
      permission does not carry forward.
- [ ] Never start Cheat Engine exploration without a written, bounded plan.
- [ ] Keep Cheat Engine read-only unless the user separately and explicitly
      approves a write, injection, code execution, input control, or process
      state change.

## Build inputs

Use an immutable version/hash directory, not `current/`, when recording a
finding. The retained build currently used for reference is:

```text
tools/extractor/output/publish/production/client/6.13.0.0.0-39635f2ca772/
```

Recovered artifacts for that build are under:

```text
tools/extractor/output/temp/work/6.13.0.0.0-39635f2ca772/client/il2cpp_dump/cpp2il/
├── diffable-cs/DiffableCs/Assembly-CSharp/  declarations, fields, signatures
├── isil/IsilDump/Assembly-CSharp/           native disassembly and IL-like flow
└── dll_il_recovery/                         recovered managed assemblies
```

Regenerate them only when missing or when investigating a different build:

```powershell
go run ./cmd/extractor -config local.yml -il2cpp-only `
  -il2cpp-input "output\publish\production\client\<build>" `
  -il2cpp-format "dll_il_recovery,diffable-cs,isil"
```

Run extractor commands from `tools/extractor`. Prefer the directory form for
`<build>` so the tool selects the matching assembly and metadata itself.

## Search budget

Use this order. Do not skip a layer because a later tool feels more direct.

1. XML and project code: up to three narrow searches.
2. Recovered `diffable-cs`: up to three narrow searches.
3. Matching ISIL file: inspect only the candidate methods and their direct
   callees.
4. `metatool`: resolve only the remaining identity or RVA question.
5. Offline native disassembly: inspect one small range at a time.
6. Existing injected Inspector from `offsets.md` when it already exposes the
   needed live value.
7. Cheat Engine only after the previous layers leave one specific runtime fact
   unresolved.

If three searches at one layer produce no narrower candidate, stop and revise
the question. Do not respond by broadening every search term at once.

## Investigation checklist

### 1. Define the target

- [ ] Write the behavior in one sentence.
- [ ] Identify the boundary that owns it: packet, player model, renderer,
      manager, catalog, or UI.
- [ ] List the strongest known anchors: XML object id/type, setting key, packet
      id/stat id, managed type, field type, method signature, or log text.
- [ ] State what would disprove the current hypothesis.

Example:

```text
Question: Which setter controls the skin currently rendered by LocalPlayer?
Anchors: FKALGHJIADI, two Int32 skin candidates, void(Int32) setters.
Proof: the setter writes the field selected by the downstream render rebuild.
Disproof: the rebuild reads a different field under the live player mode.
```

### 2. Search data and existing project code

- [ ] Search extracted XML for the exact display id, object type, activation
      tag, or packet/stat name.
- [ ] Search `apps/` for an existing binding key, query, parser, or test.
- [ ] Check whether the value is decimal in configuration but hexadecimal in
      XML before assuming it is wrong.
- [ ] Check paired definitions. Player and pet shaders, base and set skins, or
      normal and transformed states often have parallel ids.

Useful searches from the repository root:

```powershell
rg -n -F "Brown Hologram Style" tools/extractor/output/publish
rg -n "kSetPlayerSkin|kPlayerSkin" apps/native
rg -n "<Activate>Shader</Activate>|<Activate>PetShader</Activate>" `
  tools/extractor/output/publish/production/client/<build>/extracted_assets
```

Do not infer runtime ownership from UI labels. XML establishes data semantics;
it does not prove which managed object or setter consumes the data.

### 3. Read recovered C# declarations

- [ ] Locate the exact class in `diffable-cs`.
- [ ] Record candidate fields with their declared offsets and types.
- [ ] Record methods by exact name and full signature.
- [ ] Check the base class and concrete local-player override.
- [ ] Search the same class for every occurrence of each candidate field name.
- [ ] Note adjacent same-type fields. They are a warning that a fingerprint or
      guessed offset cannot distinguish semantics.

Start with exact symbols:

```powershell
rg -n -F "class ShaderProperties" <cpp2il>/diffable-cs/DiffableCs
rg -n -F "BKMIHOGBMMC" <cpp2il>/diffable-cs/DiffableCs/Assembly-CSharp
rg -n "void [A-Z]{11}\(int " <candidate-class.cs>
```

Recovered method bodies are often empty. That is expected; declarations answer
owner, field, and signature questions. Move to the matching ISIL file for
behavior instead of opening a live debugger.

### 4. Prove behavior in ISIL

- [ ] Open only the `.txt` corresponding to the candidate class.
- [ ] Search for the exact method heading, not a broad behavior word.
- [ ] Record each field read/write in the method.
- [ ] Follow direct calls until reaching the consumer, renderer update, event,
      or an already understood method.
- [ ] Search the entire class ISIL for every candidate field name.
- [ ] Compare near-identical setters instruction by instruction.
- [ ] Inspect the condition that chooses between adjacent fields.
- [ ] Check whether a concrete override adds UI, event, ownership, or local
      state synchronization beyond the base method.

Typical setter shape:

```text
Move this.<field>, argument
CallVoid this.<rebuild-or-notify>()
Return
```

The setter is not proven until `<rebuild-or-notify>` is inspected. That callee
may choose another field based on player state, validate an object type, replace
renderer properties, reset animation, or notify UI.

High-value IL2CPP patterns:

- Two adjacent fields plus two identical setters usually represent two modes,
  not aliases. Find the consumer's conditional selection.
- A base setter and a local-player override are not interchangeable. Prefer the
  concrete override when it owns local UI/events.
- Multiple managed methods can share one native body. Owner and call site still
  matter.
- A method that writes the requested value can still be the wrong setter if the
  renderer reads its paired field.
- Repeated visual rebuild calls can reset animation or facing. Do not use
  periodic setter calls to compensate for an unproven binding.
- A list returned by a correctly named manager can still contain only one data
  category. Verify actual ids against XML before changing lookup logic.
- Obfuscated names change; the relation between writer, selector, and consumer
  is stronger evidence than the name.

### 5. Use metadata tools only to close identity gaps

Confirm the build pair:

```powershell
go run ./cmd/metatool info "<build>"
```

Then make one targeted query:

```powershell
go run ./cmd/metatool members -type FKALGHJIADI -name MBKGLHCJBCD -rva "<build>"
go run ./cmd/metatool members -type ShaderProperties -name id "<build>"
go run ./cmd/metatool method -rva 0x<RVA> "<build>"
go run ./cmd/metatool type -index <index> "<build>"
go run ./cmd/metatool members -field-type-index <index> "<build>"
```

Rules:

- [ ] Use `members` after a class/member candidate exists, not to enumerate the
      whole game.
- [ ] Use `-field-type-index` only when an obfuscated field's type is distinctive.
- [ ] Treat shared RVAs as aliases until owner, signature, and call site agree.
- [ ] Save tokens/RVAs only with the build identity that produced them.

### 6. Disassemble a small offline range

Use offline disassembly only when ISIL omits a detail needed to answer the
question. Verify the PE image base first; do not assume it remains
`0x180000000` across architectures or builds.

```text
preferred VA = image base + RVA
```

```powershell
dumpbin /NOLOGO /DISASM:NOBYTES `
  /RANGE:0x<start>,0x<end> "<build>\game_files\GameAssembly.dll"
```

- [ ] Keep the range to one function or one direct callee.
- [ ] Decode branch conditions before assigning meaning to either path.
- [ ] Resolve direct call targets back through `metatool method -rva`.
- [ ] Do not transplant a VA into a live process. Only the RVA is portable for
      the same binary.

### 7. Packet-specific shortcut

Use the generated handler report before manually reversing registration or
dispatch:

```powershell
go run ./cmd/extractor handlers -packet-id <id> "<build>"
go run ./cmd/extractor handlers -match <text> "<build>"
go run ./cmd/extractor handlers -managed-type <type> "<build>"
go run ./cmd/metatool switch -rva 0x<RVA> -case <value> "<build>"
```

- [ ] Confirm packet direction from the packet mapping, not from `AddListener`
      alone.
- [ ] Check subtraction, bounds checks, compressed tables, and shared defaults
      before interpreting a switch case.
- [ ] Follow the case target to the concrete setter and then its consumer.
- [ ] Do not assume a packet setter is the field used for a local override. The
      game may intentionally keep server/base and local/temporary values apart.

## Cheat Engine permission gate

Cheat Engine may be considered only when one runtime-only fact remains, such as
which branch the current player takes, whether a resolved setter is reached, or
which object instance a static route returns.

Before using it, send the user a plan containing all of the following and wait
for explicit approval:

```text
Question: <one runtime fact>
Static evidence: <class, member, RVA/AOB, expected object>
Read-only actions: <exact breakpoints/reads>
Expected result: <register/field/branch and interpretation>
Budget: <maximum breakpoints, hits, and observation time>
Stop condition: <what ends the session>
Cleanup: remove every breakpoint/watch before continuing
```

Mandatory gate:

- [ ] The user explicitly approved this Cheat Engine session after seeing the
      plan.
- [ ] The question cannot be answered from XML, project code, recovered C#,
      ISIL, metadata, offline disassembly, logs, or the existing Inspector.
- [ ] The attached process and current `GameAssembly.dll` build are identified.
- [ ] Every address is derived from a current module-relative RVA, a unique AOB,
      or a current binding. No stale absolute VA is reused.
- [ ] At most four hardware breakpoints are planned.
- [ ] Each breakpoint has a predicted register or branch outcome.
- [ ] Hit collection is bounded. Default maximum: 20 relevant hits or 10 seconds.
- [ ] No memory write, function call, injection, Lua execution, input control,
      pause, or process mutation is included.
- [ ] All breakpoints and watches will be removed immediately after observation.

If any box is unchecked, do not start Cheat Engine.

After approval:

1. Call `ping` and confirm the intended process.
2. Confirm the current module base/build.
3. Install only the planned breakpoints.
4. Collect only the bounded evidence.
5. Remove all breakpoints and watches.
6. Compare the result with the static hypothesis.
7. Stop. Do not turn one answer into an open-ended exploration.

Writes require a second, separate approval describing the exact address, bytes
or call, expected side effect, restoration method, and risk. Read-only approval
does not authorize writes.

## Evidence record

Record only what another engineer needs to reproduce the conclusion:

```text
Build: <version-hash and file checksum when relevant>
Question: <single sentence>
Candidate: <owner.member, signature, field>
Static proof: <ISIL lines/control flow/callee>
Runtime proof: <none, Inspector, or approved bounded CE observation>
Rejected alternative: <candidate and decisive contradiction>
Binding: <name/signature; no absolute live address>
Tests: <regression that distinguishes the rejected alternative>
```

Do not keep stale absolute addresses or long breakpoint transcripts in this
guide. Findings that affect implementation belong in code comments and tests;
build-specific evidence belongs in an investigation note tied to that build.

## Definition of done

- [ ] One concrete question is answered.
- [ ] The assembly and metadata came from the same explicit build.
- [ ] Owner, signature, field, and consumer agree.
- [ ] Adjacent fields and near-identical setters were checked.
- [ ] Base and concrete override behavior were compared where applicable.
- [ ] At least one direct callee was followed for wrapper/setter methods.
- [ ] Runtime inspection was avoided, or its permission plan and bounded result
      were recorded.
- [ ] All live breakpoints/watches were removed.
- [ ] The implementation binds by verified metadata shape/name, not a stale VA.
- [ ] A regression test distinguishes the correct member from the rejected one.
- [ ] The final note contains no unsupported semantic claim.

Fast investigation means eliminating candidates early. It does not mean jumping
to the most invasive tool.
