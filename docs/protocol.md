# The wire protocol

Everything in this document is implemented by `packages/protocol` and covered by
its tests. The reference implementation
(`C:\Users\__hidden\Downloads\ROTMG\client\src\packets`) is the source these
facts were recovered from.

## Frame

```
 0      4       5                    length
 +------+-------+---------------------+
 | int32| byte  |        body         |
 |length|  id   |     (enciphered)    |
 +------+-------+---------------------+
```

* `length` is big-endian and **counts itself**, so an empty packet is 5 bytes.
* `id` is a single byte and is **not** enciphered — the id of a packet can be
  read before deciphering, which is occasionally useful for diagnostics.
* Everything is big-endian.

A frame shorter than 5 bytes or longer than 1 MiB is treated as a
desynchronised stream and closes the session. Nothing else does.

## Encipherment

RC4, two fixed keys, four cipher instances per session:

| Instance | Key | Used for |
|---|---|---|
| client receive | client key | deciphering what the game client sends |
| server send | client key | enciphering what we forward to the server |
| server receive | server key | deciphering what the game server sends |
| client send | server key | enciphering what we forward to the client |

```
client key  5a4d2016bc16dc64883194ffd9
server key  c91d9eec420160730d825604e0
```

The keystream is **continuous for the life of a connection**. Dropping,
reordering or double-sending a single packet desynchronises that direction
permanently, and every packet after it decodes to noise. Two consequences the
proxy is built around:

* Packets that arrive while the server socket is still connecting are
  **queued**, never dropped.
* A reconnect resets that direction's ciphers *and* its framer together.

## Types

| Type | Encoding |
|---|---|
| `byte` / `sbyte` | 1 byte |
| `bool` | 1 byte, non-zero is true |
| `int16` / `uint16` | 2 bytes, big-endian |
| `int32` / `uint32` | 4 bytes, big-endian |
| `float` | 4 bytes, IEEE-754 big-endian |
| `string` | `int16` byte length + UTF-8 |
| `utf32string` | `int32` byte length + UTF-8 |
| `byteArray16` / `byteArray32` | `int16` / `int32` byte length + raw bytes |
| `compressedInt` | variable length, see below |
| `array` | length prefix (`byte`, `int16`, `uint16`, `int32` or `compressedInt`) + elements |
| *object name* | the named data object's fields, inline |
| `statValue` | depends on the sibling `id`, see below |

### `compressedInt`

```
first byte:        c s v v v v v v      c = continue, s = sign, v = payload
continuation byte: c v v v v v v v
```

Payload bits accumulate little-endian: 6 bits from the first byte, then 7 per
continuation byte. The sign lives only in the first byte, so the encoding is
sign-magnitude rather than two's complement.

Values are range-checked against `int32`. Accumulation uses arithmetic rather
than `<<`, because JavaScript's shift truncates to 32 bits and a hostile run of
continuation bytes would otherwise wrap into a plausible negative number instead
of being rejected.

### `statValue`

A stat is `{ id: byte, value: statValue, stackCount: compressedInt }`. `value`
is a `string` when `id` appears in `stat-types.json`'s `stringStats`, and a
`compressedInt` otherwise.

The dependency is **scoped to the object being read**. The reference
implementation tracked it in a variable that survived across nested objects and
array elements, so one string stat could change how the *next* element decoded.
Here the resolution reads the `id` sibling of the same object, and nothing else.

## Optional fields

A definition may mark trailing fields `optional`. Fields are positional, so
"optional" can only mean *the packet ended here* — which is why the schema
loader rejects a required field that follows an optional one, and rejects
optional fields inside data objects entirely.

Absent optional fields are **not** filled with their defaults during decode.
`undefined` means "not on the wire", which is what lets an untouched packet
re-encode to exactly the bytes that arrived. The default is a game semantic and
is available through `fieldOr(schema, fields, name)`.

## Degradation rules

These are behavioural requirements, not implementation details:

| Situation | Behaviour |
|---|---|
| id has no definition | opaque packet, forwarded unchanged |
| body fails to decode | opaque packet, reason recorded, forwarded unchanged |
| bytes left over after the last field | kept as `trailing`, re-emitted verbatim |
| declared array count exceeds the packet | decode fails → opaque |
| frame length structurally impossible | session closes |

A definition that has drifted from the live game can therefore only degrade to
"we do not understand this packet". It can never corrupt traffic, because a
packet nobody modified is forwarded from its original bytes and never rebuilt.

## Updating after a game patch

1. Edit `packages/protocol/data/packet-definitions.json`.
2. `npm test` — the definitions are validated, every packet is round-tripped
   with generated values, and every id is fuzzed with random bodies.
3. No rebuild of the runtime is required; the file is data.

## What a live session actually showed

A played session — realm, dungeon, portals, item use, a death — carried **2 830
packets across 38 ids**. Of those: **no id the definitions fail to name, no body
that fails to decode, and one direction wrong**:

    185 UPGRADEENCHANTER — defined client->server, seen 16 times from the server

Corrected. The name is inherited and unverified, and the definition has no
fields at all, so all nine body bytes go through as trailing — see below.

**This retires the estimate that preceded it.** A static comparison against the
extractor's recovered listener ids had suggested 28 ids defined with the wrong
direction and 32 undefined. Traffic contradicts that for every id it exercised:
the extractor reads native call sites rather than a table, and its id recovery
evidently produces false positives. That was one of the three readings offered
below, and it is the one the evidence supports.

**What this does not say.** 38 ids is what one session touched. Trading, the
vault, guild traffic, pets and the forge were not exercised, so the ids they use
remain unverified — neither confirmed nor disproved. The capture is a floor, not
a certificate.

**An empty schema cannot fail.** `UPGRADEENCHANTER` reported a clean decode
because it has no fields to get wrong, while nine bytes of every one of them went
undescribed. `PacketCensus` now counts undescribed trailing bytes for exactly
this reason: "it parsed" and "we understand it" are different claims, and the
first was hiding the second.

Capture your own with `npm run live`; the runtime writes
`game-data/packet-census.json` on shutdown, beside everything else this project
learns about the game.

## The estimate this replaced

`tools/extractor` recovers, from the game's own metadata and native code, the
names of every packet type (110 incoming, 93 outgoing, 11 data structures on
Exalt 6.13.0.0.0) and the numeric ids the client registers listeners for.

Comparing that against `packet-definitions.json` (170 packets) raises a question
that is **not yet settled**:

- The client registers listeners for **131 ids**. We classify only **82** ids as
  server→client.
- **28 ids** the client registers a listener for are ones we define with the
  *opposite* direction (client→server): 1, 3, 7, 9, 16, 36, 56, 57, 60, 61, 62,
  65, 81, 98, 102, 105, 113, 118, 123, 126, 137, 138, 140, 151, 163, 185, 189,
  215.
- **32 ids** the client listens for are ones we do not define at all: 29, 32,
  111, 130, 132, 135, 141, 143, 144, 152, 153, 158, 179, 184, 188, 192, 196,
  198, 202, 219, 220, 227, 229, 230, 231, 233, 235, 236, 238, 242, 250, 251.
- **11 ids** we define as server→client have no listener: 17, 39, 41, 53, 63, 66,
  68, 106, 108, 164, 171.

Three readings fit this evidence and it does not distinguish between them: our
id→name→direction table is stale, the extractor's listener-id recovery has false
positives (it reads native call sites, not a table), or the two number different
things. **A name comparison cannot arbitrate it either** — the game spells
packets as class names (`InventoryDrop`, `ForceReconnectMessage`) while the
definitions use short screaming-case (`INVDROP`, `FORRECONNECT`), and the
extractor's id→type bindings resolve to obfuscated type names (`GGGDAHKMFJC`).

The ground truth is a live capture: run the proxy against a real session and
record which ids actually arrive in each direction. Until that is done nothing in
`packet-definitions.json` should be changed on the strength of the numbers above.
The degradation rules above bound the cost of that uncertainty: an unknown or
misclassified packet is forwarded untouched, so what is missing is visibility,
not correctness of the traffic.

## SHOWEFFECT, and how a recovered body proves itself

`SHOWEFFECT` (id 11) is the one packet here whose **fields** were recovered from
the game rather than inherited. It matters because it is the only warning the
wire carries before an area effect goes off: `AOE` reports a detonation that has
already happened, and the client answers it with an `AOEACK` saying where the
player was — by then there is nothing to dodge. The telegraph is what the dodge
planner reads; see `state/blasts/BlastStore.ts`.

The field list came from the client's own metadata, not from guesswork:

- `tools/extractor` publishes `handlers.json`, whose `message_factories` binds
  **packet id 11 to managed type `COEFCBBIBMC`** at confidence 100.
- That is the same class the reference implementation hooks for ShowEffect, and
  its `RuntimeOffsets` give the field offsets: `0x10` effectType, `0x14`
  targetObjectId, `0x18` pos1, `0x20` pos2, `0x2C` duration.
- The gap at `0x28` is a field the reference never read. The decrypted metadata
  the extractor also publishes has the class's field-name strings in declaration
  order, and the name between pos2 and duration is the colour.

Six fields, and as wire types they come to **29 bytes**. A live census recorded
**30** as the largest undescribed body over 113,698 sightings, so one byte is
still unaccounted for. That is not a problem: bytes past the last field are kept
as `trailing` and re-emitted verbatim, exactly as the table above promises.

**The decode checks itself against the game.** Where a telegraph says a bomb will
land is a claim; the `AOE` that follows is the answer sheet. `BlastStore` counts
predictions a detonation landed on and detonations nothing predicted, and the
World tab shows both. A layout that drifts after a patch therefore shows up as
confirmations stopping and unmatched climbing — a number to look at, rather than
a dodge that quietly stopped avoiding bombs.

**Two of the six fields decide whether a telegraph is a threat at all.**
`targetObjectId` is the object the effect hangs on, which is the thrower: a
teammate's ability and a monster's bomb are otherwise the same packet with the
same effect type, and the planner walked out of both. The catalog is what tells
them apart — `<Player/>` and `<Pet/>` in `objects.xml` — so with no game data
loaded every telegraph is treated as dangerous, which is the safe direction.
`color` is not used to make that decision: it names the ability rather than the
side, and a colour table would have to be maintained against a game that adds
abilities. What it is used for is remembering how wide the blast turned out to
be, keyed with the thrower's object type; see `state/blasts/BlastRadiusTable.ts`.

`AOE` is read the same way. Its `damage` and `effect` say whether a detonation
could hurt anybody, and one that could not is a heal or a buff landing on the
party. Counting one as a detonation confirms — and so cancels — whatever real
prediction it happens to land near.
