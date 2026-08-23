# Node ⇄ native IPC

This document is the contract. `packages/ipc` implements it in TypeScript and
`apps/native/src/ipc` implements it in C++; neither is the specification, this
is. When they disagree, this file decides.

## Transport

A Windows named pipe. The **runtime is the server**; the injected module
connects as a client.

This is the right primitive: the peer is a DLL in another process on the same
machine, the connection is point-to-point, and the pipe's ACL is the access
control. The runtime restricts the pipe to the current user — nothing else on
the machine can open it.

**A write is not a message.** Both sides may put several frames in one write,
and a reader must already cope with a read that carries half a frame or six of
them — so this adds no rule, it uses the one framing was built for. It matters
because an overlay sync is a hundred-odd records for one logical change: the
runtime gathers everything queued during a turn of its event loop and writes it
once, and the module drains whatever a read hands it. The alternative is a
hundred pipe writes and a hundred buffers to say one thing.

## Frame

```
 0   u32  magic      'BRWN' (0x4E575242 little-endian)
 4   u16  version    IPC_VERSION; a mismatch closes the connection
 6   u16  type       message type
 8   u16  flags      bit 0 = binary payload, otherwise UTF-8 JSON
10   u16  reserved   must be zero
12   u32  seq        monotonic per direction, starts at 1
16   u32  length     payload byte count, ≤ 256 KiB
20   ...  payload
```

Everything is **little-endian**. The game protocol is big-endian; these are
unrelated wire formats and the difference is deliberate.

Three fields exist because the reference implementation lacked them and paid
for it:

* **magic** — a peer that is not ours is detected on its first frame, not after
  a confusing JSON parse failure.
* **version** — a mismatch is detectable before any message is interpreted. The
  old build carried the version *inside* the handshake JSON, so it could only
  be checked after successfully parsing a message from a peer that might not
  share the format.
* **reserved** — must be zero, and is checked. It is the only way a future
  version can add a header field and be certain older builds refused the frame
  rather than misreading it.

A bad magic, an unknown version, a non-zero reserved field, an oversized
length, or a sequence gap all mean the same thing: **close the connection**.
None of them is recoverable, because the stream is no longer aligned or the
peer is not who we think it is.

## Sequence numbers

Monotonic per direction, starting at 1, wrapping from `0xFFFFFFFF` back to 1
(never to 0, so "no frames yet" stays distinguishable). A receiver that sees
anything other than `last + 1` closes the connection.

### Why there is no per-message MAC

The reference implementation derived a session key at handshake time and signed
**every** message with HMAC-SHA256 over a canonical string rebuilt from the
message's fields — including per-frame player telemetry.

That is not carried over, for two reasons:

1. **It defended against nobody reachable.** A named pipe instance is
   point-to-point. Once the runtime has accepted a connection and both sides
   have completed a mutual challenge, no third party can insert, modify or
   reorder a frame on that instance without already having the privileges to do
   far worse. The MAC's real effect was to detect *loss and reordering* — which
   a counter does for free.
2. **The canonical string was a second, undocumented encoding of every
   message.** `playerPayloadFromMessage` rebuilt the signed text with
   `posX.toFixed(3)`; the signature therefore depended on decimal formatting,
   and any change to it silently dropped every telemetry frame with a
   "dropped unsigned/invalid" warning.

What replaced it: a mutual challenge at connect (below), a sequence counter,
and a signed liveness exchange every few seconds that keeps re-proving key
possession without costing a hash per frame.

## Handshake

```
native  → runtime   hello         { pid, challenge }
runtime → native    authChallenge { userId, pid, response, challenge }
native  → runtime   authResult    { ok, response }
```

Both `response` values are

```
HMAC-SHA256(secret, challenge | userId | senderPid)
```

where the fields are joined with a literal `|`, `challenge` is the *peer's*
challenge, `userId` is the normalised identity (below) and `senderPid` is the
decimal process id of whoever is signing.

* Joining with a separator rather than concatenating makes the signed string
  unambiguous: no combination of field values can collide with a different
  combination.
* Binding the pid means a captured transcript cannot authenticate a different
  process.
* Nonces and MACs are 32 bytes, exchanged as lower-case hex.
* MAC comparison is constant-time, and a malformed MAC compares false rather
  than throwing — a peer must not learn "wrong shape" from "wrong value".

The runtime must **not** accept an `authResult` it cannot verify. The reference
implementation shipped with those checks commented out behind an "admin dev"
path, which made the mutual half of the mutual authentication decorative.

### `serverTarget` — how the proxy learns where the game was going

`0x0302`, native → runtime, JSON `{ host, port }`.

The game receives its server list over HTTPS, which a MITM proxy never sees, so
it dials an address the runtime has no way to learn. The module detours Winsock's
`connect`, rewrites a game-server connection to the local proxy, and sends the
*original* address in this message. Without it `AllowlistTargets` has nothing to
check and refuses every session.

**Reported, never obeyed.** The message names a host; the allowlist decides
whether the proxy follows it. The runtime validates it is IPv4 and drops it
otherwise, and the message may only originate from the native side — a value
that reaches the allowlist must not be settable by anything that can merely
speak the protocol, or the proxy becomes an open relay.

Sent from whichever thread the game connects on, with the game's `connect`
blocked behind it, so the module does one send and returns. A send that fails is
dropped rather than retried: the session is then refused, which is visible,
whereas stalling the game's connection to fix it would not be.

### Where the shared secret comes from

The module cannot carry one. A secret compiled into a shipped DLL is a secret
everybody with that DLL has, which would make everything above an expensive way
to authenticate nobody. A file next to the module is the same thing with an
extra step.

So the runtime **mints a fresh 32-byte secret per run** and publishes it at a
path both sides derive from the same two inputs:

```
%LOCALAPPDATA%\Brownie\<pipe name>.key
```

Contents: exactly 64 lower-case hex characters, optionally followed by
whitespace. Anything else is refused rather than padded or truncated — a
silently reshaped key is a *different* secret, and the failure would surface as
an authentication error with nothing pointing at the file.

The pipe name reaches this from configuration, and it decides which file is
read, so both implementations require it to match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
The leading-alphanumeric rule is what rules out `.` and `..`, which pass a plain
character-set check and name a directory.

**What this protects and what it does not.** `%LOCALAPPDATA%` is readable by
this user, SYSTEM and Administrators and nobody else — the same audience that
can already open the named pipe. The file adds no exposure the transport did not
have. What it buys is that the secret is fresh every run and lives nowhere
durable.

The module reads it **on every connection attempt and never caches it**: the
runtime can be restarted under a running game, and it mints a new key when it
is. A cached key would authenticate against a runtime that is no longer there.

The runtime removes the file on shutdown. `native.secret` in the configuration
overrides all of this, for the case where something else has to know the secret
too; setting it also means nothing is published or removed.

Implementations: `apps/runtime/src/native/SessionKey.ts` and
`apps/native/src/ipc/SessionKey.{h,cpp}`.

### Normalised identity

Both sides sign the same identity string, so both must derive it identically:

* trim whitespace;
* empty becomes the literal `anonymous` — "no user" is a real state and must not
  be indistinguishable from a missing field;
* any character outside `[A-Za-z0-9._-]` becomes `_`;
* truncate to 96 characters.

## Liveness

Every 5 seconds each side sends `ping { nonce }`; the peer answers
`pong { response = HMAC(secret, nonce) }`. Three consecutive unanswered pings
close the connection.

Signed rather than bare, because a signed exchange re-proves key possession
periodically instead of merely proving the socket is open — at one hash per
side per five seconds.

## Messages

| Code | Name | From | Payload |
|---|---|---|---|
| `0x0001` | `hello` | native | `{ pid, challenge }` |
| `0x0002` | `authChallenge` | runtime | `{ userId, pid, response, challenge }` |
| `0x0003` | `authResult` | native | `{ ok, response }` |
| `0x0100` | `ping` | either | `{ nonce }` |
| `0x0101` | `pong` | either | `{ response }` |
| `0x0200` | `setFeature` | runtime | `{ key, value }` — value is boolean, finite number or string |
| `0x0201` | `controlRecord` | runtime | `{ record }` — one overlay record |
| `0x0202` | `controlAction` | native | `{ action }` — one overlay interaction |
| `0x0300` | `hotkeyEvent` | native | `{ pluginId, action, value }` |
| `0x0301` | `offsetHealth` | native | `{ unresolved: string[] }` |
| `0x0400` | `playerTelemetry` | native | binary, 24 bytes (below) |

Two rules make the set extensible in both directions:

* **A message whose type this build does not know is kept, not rejected.** It
  decodes to an opaque `unknown` and can be forwarded or dropped by the layer
  above. A newer peer must never break an older one.
* **A message that travelled the wrong way is rejected.** The native module has
  no business sending `setFeature`; accepting one would let a confused — or
  compromised — peer drive the runtime. Direction is part of the contract, and
  is enforced on receipt.

### `setFeature`

The only way to control a gameplay feature. Two rules follow from the native
module storing nothing:

* the runtime re-pushes every key it owns on enable, on connect and on cleanup;
  a fresh injection starts from the C++ defaults and anything not re-sent stays
  there;
* handlers run on the IPC thread and may therefore only *store* state. A key
  that has to end in an IL2CPP call raises a request that the render thread
  consumes on its next tick.

Unknown keys are accepted and ignored, so a newer plugin never breaks an older
module. The value is read as *text* whatever its JSON type is — `true`, `1234`,
`"anything"` — because this message is the one place the protocol carries a
value of no fixed type, and the feature that consumes it is what knows its
shape.

Four keys are resolved today:

| key                         | value                | meaning                                                      |
| --------------------------- | -------------------- | ------------------------------------------------------------ |
| `player.noclip`             | `true` / `false`     | silence the client's own walkability check                   |
| `cursor.track`              | `true` / `false`     | measure where the cursor points, and send it                 |
| `player.collider`           | `true` / `false`     | scale the player's collision circle, and put it back after   |
| `player.colliderMultiplier` | `0` … `1`            | what to scale it by, clamped on arrival                      |

**The three switches are leases rather than flags**, and nothing else here is.
Every other change the module makes to the game is switched on in the overlay,
by a switch that cannot go away. These belong to plugins, and a plugin can be
disabled, can fail, can be unloaded, and the runtime behind it can be killed —
each of which would otherwise leave the module doing something with nothing left
to say stop. So the runtime restates `true` once a second while it wants it, the
module gives the claim three seconds, and `false` ends it at once. A switch that
is simply switched off is therefore immediate; only the ways a runtime stops
*without* saying so wait out the lease.

What is left behind differs, and only one of them is dangerous: a lapsed
`player.noclip` is a character walking through walls, while a lapsed
`cursor.track` is three calls a frame into a camera nobody is reading, and a
lapsed `player.collider` is the module writing the game's own multiplier back
over its own. The last two are leases anyway, because a claim that outlives its
claimant is a claim nobody can revoke — and because the collider's expiry is
what actually undoes the write.

`player.colliderMultiplier` is the exception on this table: not a claim but the
number one of the claims applies. It goes out **ahead of the claim and only when
it has moved** — the module applies whatever it was last told, so a claim heard
before its number would act on the previous one, while a number that has not
changed is one the module already has and the runtime would be repeating for
nobody. It is stored whether or not the claim is live, because a value refused
for arriving first would leave the claim acting on whatever came before it. The
module clamps it to `0` … `1` on arrival rather than trusting the slider it came
from: above one is a *larger* collision circle than the game built.

### `playerTelemetry`

```
 0  u8   flags      bit 0 = alive, bit 1 = defense is known
 1  u8   reserved
 2  i16  defense
 4  f32  x
 8  f32  y
12  i32  hp
16  i32  maxHp
20  u32  uptimeMs   milliseconds since the module attached, monotonic
```

Binary because it arrives every game frame. A separate "defense is known" bit
exists so *unknown* stays distinguishable from *zero* — the runtime's survival
logic must not read a failed memory read as "no armour".

Out-of-range values are clamped rather than rejected: this is a hot path fed by
memory reads that can transiently return nonsense, and dropping the connection
over one bad frame would be worse than reporting a clamped one.

## Overlay records

The overlay holds no state. The runtime describes what to draw as a stream of
`controlRecord` messages, and interactions come back as `controlAction`.

A sync is sent only when it says something new. Every interaction ends in a full
re-sync and most of them change one field of one record, so the runtime keeps
the records it last sent and says nothing when the next sync would be identical
— the module's mirror is a function of those records alone, so an identical sync
leaves it exactly where it already is. A module that has just connected mirrors
nothing, and always gets a full one.

A record is a `|`-separated field list whose first field is the record kind.
Every field is percent-encoded, so no value can contain a separator or upset
the C++ side with non-ASCII text.

```
setting|auto-drink|hpPercent|HP%20percent|range|n|7|1|0|1|14|1|0|
kind    plugin     key       label        type  vt v hasMin min hasMax max step adv options
```

* **Unknown record kinds are ignored, not rejected.**
* **Fields are positional and new fields are appended**, so an older reader
  that stops early still decodes everything it knows about.
* Booleans are `1` / `0` on both sides.
* Lists inside a field use `;`, which cannot be escaped — a `;` in a cell
  becomes `,`. That compromise lives in the codec, not at each call site.

Record kinds and their fields are documented with the overlay pages that emit
them, in `apps/runtime/src/overlay`.

A handful of kinds are not about drawing at all. Most of them carry integers
only — no encoding to apply, and nothing to get wrong between two languages.
`weapon` and `text` are the two that do not, and each says why below:

| record  | fields                                            | meaning                                                                                               |
| ------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `world` | hp, maxHp, x·100, y·100, entities, shots, defense | what the server last said — for the overlay, and for the module to check its own memory reads against |
| `weapon` | name, objectType, speed·100 (tiles/s), lifetimeMs, range·100 | the equipped item, as `objects.xml` describes it — sent when it changes, and shown so the range the dodge planner keeps the player inside can be checked against the item it was read for |
| `move`  | x·100, y·100, speed·100, holdMs, fromPlayer       | walk towards here, no faster than this, for this long unless replaced. `fromPlayer` is `1` when the two numbers are an offset from wherever the character is on the frame the module acts, and `0` (or absent) when they are a place on the map |
| `aim`   | x·100, y·100, holdMs                              | point the shots the player fires at here, for this long unless replaced                               |
| `text`  | red, green, blue, message                         | show this over the player, in the game's own floating text, replacing whatever was waiting            |
| `dodge-begin` / `dodge-end` | —                     | brackets the dodge planner's picture — paths and circles alike — which is committed whole             |
| `trails` | one field per shot: `life‰,x·100,y·100,…` (pairs) | every shot's remaining path, from where it is now to where it stops existing                         |
| `marks` | one field per circle: `kind,x·100,y·100,radius·100,ahead‰,anchor,vx·100,vy·100` | every circle the planner is reasoning about: the character, the ring a shot has to enter before it is answered, a monster's body, the weapon's reach, or where an area effect will land. `ahead‰` is how much of its wait is left, which only a blast has. `anchor` is `1` for a circle centred on the character, which the module draws wherever it can see the character is; `vx`/`vy` are tiles a second, and are what lets a monster's circle be drawn between two publishes where the monster is rather than where it was. Both are `0` (or absent) for a circle that sits still where it was stated |

`weapon` carries one field of text — the item's own id — so unlike its
neighbours it is percent-encoded and the module reads it with the same splitter
the control records use. It is sent only when the answer changes, which is when
the player swaps an item, rather than on the world record's own four-times-a-
second clock. An item the data files do not describe is still reported, with an
empty name and its type: "no entry for this type" and "these numbers are wrong"
look identical on screen otherwise, and want opposite fixes.

`text` is the exception to "integers only", and to the encoding above: **the
message is the whole of the rest of the record**, separators included, which is
why it comes last and why nothing about it is escaped. The alternative is an
escape scheme for one field that carries prose — the reference implementation
packed its colour into the *message* as a `|#RRGGBB` suffix and then had to
strip it again before display, which is a parser inside a payload. Channels are
0..255 and a record with an empty message is refused.

**There is no style field, and there was briefly.** Which of the game's
floating-text kinds to draw is a number nobody can know — the enumeration's type
name is obfuscator output, and IL2CPP's C API cannot read an enumeration's
constants back, since a literal field's offset is not a static slot. It was
carried here so it could be turned against a running game, which is a setting
for a value with no meaning to whoever turns it. The module now takes the kind
from the game itself: it detours both `ShowFloatingText` overloads — the one
taking a string and the one taking the `int` that every damage number goes
through — and keeps the style argument of the last call the game made. So the
runtime says what to write and in what colour, and the game says the rest.

`move` and `aim` are the only instructions in the protocol, and the division
they embody is the architecture's: the runtime decides *where*, because it holds
the world model and the planner, and the module applies that inside the game —
on the game's own thread, because touching managed code from any other is not a
mistake a module makes twice.

They apply it differently, and the difference is worth stating. `move` **calls**
the game's own `MoveTo`; `aim` **intercepts** the game's own shot and changes
the angle it was about to use. Nothing about `aim` makes the player shoot: the
player decides that, and if they never fire, an aim does nothing at all.

`move` carries a *speed* as well as a place, because the module holds nothing
that says how fast the character may walk — that is the speed stat, which the
runtime has. `aim` needs no such limit: it does not add shots, it redirects the
ones the player was making anyway.

**It is a target, not a destination to jump to.** The module issues a small step
towards it every frame, capped at `speed × frame time`. The reference
implementation states what the alternative costs: "never command farther than
the player can actually travel this frame — commanding past reach is what the
server snaps back." A distant point does not make the player walk there; it
makes them appear there, and then be put back.

**And the player's own walking is counted against that cap**, because the step
is applied on top of the game's own movement rather than in place of it. A
player holding a key the way the runtime is steering them was travelling at both
speeds at once, which the server takes back exactly as it takes back a step past
reach — live report: "if the vectors agree, the speeds add up and it teleports
us." The runtime cancels the input it knows about, but it knows about it from a
position a server tick old and from a belief about which keys are down; the
ground that actually appeared under the character is neither, and only the
module can see it. So the module measures what the position moved since the last
frame, subtracts whatever it asked for itself, and spends only what is left of
`speed × frame time` on the sum — nought when the player is already spending the
whole of it, and never more than the frame allows when they are walking the
other way. A frame with nothing to compare against — the first after a stretch
with nothing to do — issues no step at all, for the same reason it issues none
after a gap.

**And it can be measured from the character rather than from the map**, which is
what `fromPlayer` says. The runtime learns where the player is from `MOVE` and
`NEWTICK` — five times a second — while the character walks at the frame rate,
so its idea of the position is up to a whole server tick and a tile and a half
behind. A planner that decides a *heading* and adds it to that names a place the
player may already have walked past: the module measured the distance from where
they actually were, found it pointing backwards, and hauled them back — then
jumped forwards again the moment the next packet landed. Five times a second,
which is exactly what it looked like. Sending the offset instead puts the
resolution on the side that reads the position every frame.

The chord that walks to the cursor stays a place, and should: a cursor is
measured against the game's own camera, so it already names a point on the map
that owes nothing to the runtime's world model.

`holdMs` is how a target stops mattering. The runtime says *nothing* when it
decides to stand still or hold fire, so silence has to mean stop on its own —
otherwise the last dodge would be walked towards forever and the last target
shot at after it died. It is a few planning intervals rather than a server
tick: the runtime plans about forty times a second, and everything past the
next plan is time the player spends acting on a decision already withdrawn.

**A target at the player's own feet is how a walk is cancelled.** The module
walks *towards* a target and stops once it is close enough, so one it has
already arrived at issues no step — and the runtime sends exactly that, with the
shortest hold the record allows, on the plan where it stops needing to drive.
Waiting out `holdMs` instead would leave the player walking somewhere the
planner has already stopped choosing, against whatever they are pressing.

Four actions travel the other way and are not about the overlay at all. They
carry integers only, for the same reason:

| action      | fields                       | meaning                                     |
| ----------- | ---------------------------- | ------------------------------------------- |
| `cursor-at` | x·100, y·100                 | where the cursor is, in tiles               |
| `unstick`   | `1` or `0`                   | the walk-to-cursor chord, down or up        |
| `steer`     | `1`, x·1000, y·1000 — or `0` | which way the player is walking, as a world direction |

**`cursor-at` is a place, not a direction, and the module is the only thing that
can work one out.** The cursor is a point on a window and the map is somewhere
else entirely, so turning one into the other means asking the game's own camera.
It is asked by measurement rather than by reversing the projection: three points
whose world position is known, projected by the camera itself, give the two
screen vectors one tile is worth, and a two-by-two solve turns the cursor's
pixel offset back into tiles. Camera rotation, zoom, window borders and a render
resolution that differs from the window's are all already inside that answer, so
none of them has to be read. See `apps/native/src/game/ScreenProjection.h`.

**It used to be an angle, and that is worth writing down.** The record was
`cursor`, carrying milliradians scavenged from the client's own shot path — the
argument being that a cursor names a direction, that the game never says how far
along it the cursor sits, and that a player does not aim with that distance
anyway. A live session ended the argument: the `out float angle` that method
writes is `0` on every call, whatever the mouse is doing, so everything ranking
by it ranked by due east. The kind was renamed rather than reused, so a runtime
of that vintage ignores the new record instead of reading a coordinate as a
bearing.

It is sent twenty times a second while anything is watching — the chord is down,
or a plugin holds `cursor.track` — and not at all otherwise: measuring costs
three calls into the camera per frame, and a record per fiftieth of a second for
a feature nobody switched on is traffic with no reader. **The repetition is the
safety.** A module that is killed, unloaded or restarted mid-aim says nothing
more, and the runtime lets go of the point on its own within half a second — see
`apps/runtime/src/native/CursorTracker.ts`. **Silence means "we do not know",
never "point at the closest thing instead."** The reference implementation had
the opposite rule and a cursor position that was declared and never written, so
its "closest to mouse" was "closest to player" in every session it ever ran.

`unstick` is an edge and nothing else: the press and the release, with nothing
in between, because where the chord points is already travelling as `cursor-at`
for a reader that wants it whether or not anybody is holding anything. **The
module reports the chord and decides nothing.** Where to walk needs the
character's speed, which is a stat off the wire, so the answer comes back as an
ordinary `move` — the same target the dodge produces, from the same plugin, so
that one writer owns the module's move target. The runtime clears the boolean
when the module connects: a chord held by a module that has since restarted is
a key nobody is pressing.

`steer` is **a world direction, not a key**, and working one out is the whole
reason it comes from the module. The movement keys say "towards the top of the
screen"; the game maps that through the camera, so a rotated camera turns the
same key into any heading at all. The module therefore converts it with the same
measured basis `cursor-at` uses — one pixel up and one pixel right, put back
through the projection — and sends thousandths of a unit vector. Nothing on the
wire knows any of it, and nothing on the runtime's side has to know about keys,
cameras, or which way `y` counts.

The keys are read from the OS rather than from the game's own "is moving" field,
and the reference implementation is why: the planner's own movement sets that
field, so the planner sees itself steering, stops, sees the field clear, resumes
— a thirty-hertz stutter with no cause visible anywhere in the planner. A panel
over the game takes the keys, so a player typing into one is not steering; a
window of another application having focus means the same.

**What it is for is the runtime deciding when *not* to act.** Auto-dodge leaves a
player who is already walking somewhere safe entirely alone, and when it does
have to take the wheel it subtracts what they are contributing rather than adding
to it — the module's step lands on top of the game's own movement, so commanding
a direction while the player pulls another way produces the sum of the two. See
`apps/runtime/src/features/dodge/dodgeCommand.ts`.

A key going down or coming up is reported on the frame it happens; under that it
is restated about ten times a second, because the camera can turn while a key is
held. **The repetition is the safety, and here it is load-bearing twice over**: a
direction that is subtracted is one that pushes the character when nobody is
holding it, so the runtime lets go of an unrestated one inside half a second —
see `apps/runtime/src/features/dodge/SteerIntent.ts`. The release is a single
`0`, which is what makes letting go immediate.

**`trail` and `mark` are the one thing on this link that is only ever looked
at.** Where a shot will be is the game's own motion model applied to parameters
out of its data files, and how near a monster may stand is a setting the runtime
owns — so only the runtime can work either out; drawing them is pixels, so only
the module can do that. Putting the prediction on the map beside the shots it
claims to describe is the only way to see whether it is right — a drawn line
that runs where the shot actually goes says the model holds, and one that veers
off says it does not, in the half second it takes to look.

**They are also the only records that pack, and they have to.** One field per
thing rather than one record per thing: fifty paths and sixty circles, twenty
times a second, is two thousand messages a second as a record apiece — and the
module reads one bufferful per turn of its loop, so it fell behind, the picture
arrived too late to count as fresh, and it blinked out until the box was
unticked and ticked again. The numbers inside a field are comma-separated; the
fields are bar-separated as everywhere else here.

**And the circles answer the question the paths cannot**: not "is the prediction
right" but "is the decision right". Every complaint this feature has had was
about a distance — it dodges shots that were never near, it lets monsters stand
on top of me, it walks out of range, it ignored that bomb — and each of those is
a number in a settings panel that nobody can check against a moving fight. On
the ground they check themselves. Both halves travel inside one bracket because
they describe one plan: this plan's shots against the last plan's circles would
be a picture of a moment that never happened.

Each path starts at **where the shot is now**, not where it was fired. The part
already travelled is not information — it is visible on the screen as the shot
itself — and starting at the present is what makes the drawn line shorten from
behind as the shot advances, without anything having to erase it. The last point
is where the shot stops existing, so the line ends where the shot does.

`life‰` is how much of the shot's own lifetime is left, a thousand the moment it
was fired and nought as it expires. The module colours the line by it: green
where there is plenty and red where there is not, fading along the line to the
point of expiry — so the length and the colour say the same thing twice, which
is what makes a screen of fifty of them readable.

A set is **bracketed and committed whole**, like the plugin sync, because a set
half-replaced is a picture of two different moments. And it expires: the runtime
says nothing at all while the switch is up, so the module lets go of what it has
within half a second of the records stopping — which is also what a runtime that
was killed mid-fight looks like from there.

| action       | fields      | meaning                                    |
| ------------ | ----------- | ------------------------------------------ |
| `dodge-view` | `1` or `0`  | whether the module wants the dodge picture |

**The only switch that travels this way**, and it has to: the checkbox is in the
module's own scene list, because what it turns on is drawing, and what it turns
on *costs* something the runtime has to be told about — a few hundred numbers a
second that are pointless while nobody is looking. It is stated on the turn it
changes and again whenever a link comes up, because a runtime that has just
started knows nothing about a box that was ticked before it existed.

`aim` names a *point*, not an angle, for the reason `move` does: a plan is made
tens of times a second and the player moves every frame, so the module turns the
point into an angle from wherever the player is at that moment — and it does
that in the frame rather than in the detour, so the game's own shot path costs
an atomic load and a store.

## Lifecycle

```
native connects
  → hello / authChallenge / authResult
  → runtime replays every feature key
  → runtime publishes a full plugin sync and a full page sync
  → steady state: per-page updates, telemetry, actions, liveness
native disconnects
  → both sides drop their mirrors, so a reconnect resyncs cleanly
    rather than showing a frozen snapshot
```

Shutdown from the runtime's side: stop accepting connections, send nothing
further, close the pipe. The native module treats a closed pipe as "reset the
mirror and wait for a new server", not as a fatal error — the runtime is
allowed to restart underneath it.
