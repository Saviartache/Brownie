# Finding offsets

How to work out where something lives in the game's memory, and how to be sure
it is what you think it is. `docs/architecture.md` says why the design is what
it is; this is the procedure.

Everything here is written against a game that is **running**. That is not a
convenience — it is the rule the rest of the document follows from.

## The one rule

An offset that cannot be verified does not exist, and the feature that wanted it
goes quiet. There are no constants and no fallbacks anywhere in
`src/game/PlayerFields.cpp` or beside it.

The reason is not tidiness. A stale offset that still resolves does not make a
feature stop; it makes the feature read and write *the wrong memory*, inside
someone else's process, and the damage surfaces somewhere unrelated minutes
later. A feature that is switched off is visible, reportable and harmless. A
feature running on a wrong offset is none of those.

## Why the usual order is inverted

The game ships through Beebyte, and only partly obfuscated. `ObjectProperties`
and `collisionRadiusMultiplier` come through intact. The class holding the
player's health is called `LKHPPBEGNOM`, and its fields are `KJNHLADHEMH`,
`NCBIICBDGAG`, `HODJPKFINKF`. From a name alone the two cases look the same.

So a name is worth only as much as the next rebuild allows. Shape — a field's
declared type and its position among the fields of that type — survives a
rename. That makes the fingerprint layer **the plan, not the fallback**, which
is the reverse of how such a table usually works.

And it forces the rule that runs through everything below: **a fingerprint may
only be written from a game that was running.** A fingerprint is a claim about a
class's layout. One invented at a desk is exactly the guess the whole design
exists to forbid.

## The procedure

### 1. Find the class

Open the overlay (INSERT) and expand **Inspector**.

Press **Load class list**. The panel becomes a filter box and a table of every
class the runtime has built — type a fragment to narrow it, click a row to see
what that class holds.

**Nothing here runs on its own.** The list is fetched when the button is
pressed, a class is described when its row is clicked, and **Clear** drops both.
The report is shared by pointer, so letting go of it on both sides is what
actually returns the memory — which matters, because this runs inside somebody
else's process.

**Export all to a file** writes every prepared class with its members to
`game-data/game-classes.txt`. Worth doing once per game build and keeping: the
metadata does not move while the build does not, so walking it again answers the
same question. Grepping that file is usually faster than any amount of clicking.

The export skips classes the runtime has registered but not finished preparing,
and says how many. Asking a class its name is safe whatever state it is in;
asking an unprepared one for its members is not, and is how the reference
implementation crashed inside `GameAssembly` with nothing in the dump to say
why. Clicking a row is safe for the same reason in reverse — the class was named
by the runtime, so it exists.

The search is a substring match and is **case-sensitive**, because the names
being hunted are eleven random capitals and a case-insensitive match over those
finds everything.

It reports how many names it matched as well as how many it listed. If those
differ, narrow the fragment — a list truncated at a round number while presenting
itself as the answer is how a search gets believed for something it never did.

**A class that is not found may still exist.** IL2CPP registers classes lazily,
so one the game has not instantiated yet is missing in exactly the way a renamed
one is. Get into the world, do the thing that would create the object, and look
again. Only a name still missing after real play means anything.

This is not a theoretical caveat. A dump taken from a live session listed
`ProjectileProperties`, the player's class and the map-object base class it
derives from — but not `ObjectProperties`, which the reference implementation
resolves at runtime and which therefore certainly exists. Nothing had built one
yet. **A dump is a list of what the game has needed so far, not an inventory of
what it has.**

### 2. Read the class

Type the full class name — as printed, `Namespace.Name` and all — and press
**Describe class**. Every field comes back with its offset, its declared type
and whether it is static; every method with its signature.

Roughly three names in five are obfuscated: a dump taken from a played session
held 3 289 classes, of which 1 906 were bare eleven-capital names and 1 065 kept
a real namespace. `DecaGames.RotMG.Objects.Map.Data.ProjectileProperties`
survived intact; the class holding the player's health did not.

Two things about that listing routinely mislead:

**It is the class's own fields only.** Nothing inherited appears. `objectId` and
the player's position are not on `LKHPPBEGNOM` at all — they are on the base
class `KJMONHENJEN`, and asking the wrong one produced two clean "no field of
that name" failures before anybody thought to check. When something obviously
ought to be there and is not, the base class is the first place to look.

**A static field's offset means something else entirely.** It indexes a
different block of memory, so it can never be read off an instance. The
fingerprint layer ignores statics for the same reason, and a resolution on one
reports no ordinal at all.

### 3. Work out what a field actually holds

This is the part that cannot be done by staring. In order of how much they
prove:

**Compare against the packet stream.** The strongest test available, and it
costs nothing, because the runtime already knows a great deal independently: HP,
maximum HP, position, object id and the map's contents all arrive in packets and
are already parsed. An in-process read that agrees with the packet the server
sent is two independent sources agreeing. One that does not is a wrong offset,
whatever the name suggested. **This is the intended way to confirm any new field
and it is worth doing before writing a line of feature code against it.**

**Watch it move.** Read the field every frame and do something in the game that
should change it. A health value falls when you are hit; a position changes when
you walk. A field that never moves while the thing it claims to describe does is
not that thing.

**Prefer the field that is written continuously.** The player's class carries a
`Unity.Mathematics.float3` position *and* two `System.Single` fields. The
`float3` is written on a teleport or a move and lags behind where the player
actually is, so the two floats are what a feature should read. There is often
more than one plausible field, and "plausible" is not the standard.

**Type and neighbours narrow the field, they do not settle it.** Three `Int32`s
in a row at `0x1B8`, `0x1BC`, `0x1C0` being max HP, HP and defense is a good
guess about a stat block. It is still a guess until one of the tests above
agrees with it.

### 4. Write the query

In `src/game/PlayerFields.cpp`, with the name only — no fingerprint:

```cpp
KeyedFieldQuery{kPlayerHp, FieldQuery{kPlayer, "KJNHLADHEMH", {}}},
```

Leaving `type_name` / `type_ordinal` / `type_count` unset switches the
fingerprint layer off for that key. That is the correct starting state: a rename
then makes the field go quiet instead of resolving to a plausible neighbour.

### 5. Run, and let the game write the fingerprint

The Offsets panel lists every key with its offset and how it was found. A
resolution reports the shape the live class gave it:

```
self.hp        0x1BC   exact name; System.Int32 #4 of 26
```

That is the fingerprint, in the order the query takes it. Transcribe it:

```cpp
KeyedFieldQuery{kPlayerHp, FieldQuery{kPlayer, "KJNHLADHEMH", {}, "System.Int32", 4, 26}},
```

Now the key survives a rename, and it survives it *strictly*: the count must
still match, not merely be large enough, because a field of that type being
added or removed moves the ordinal onto a different member.

Failures stay in the panel rather than being filtered out. "We looked and it was
not there" is precisely what somebody needs to see after a patch, and a report
showing only successes would look healthy while a feature sat silently off.

## Methods

A method is resolved the same way as a field and reported in the same panel,
with one difference that matters: a *field* resolved wrongly reads the wrong
number, and a *method* resolved wrongly is a call into — or a detour over —
arbitrary managed code, with arguments in the wrong registers. So the layers are
stricter: an overload that two methods match is a refusal, not a choice.

**The C++ prototype is part of the query.** The query says which method; the
prototype says how to call it, and a managed method reached through the wrong
one does not fail, it corrupts. The two are written together, from one
inspection, and changed together.

**A method's signature does not stand in for its name.** For a field the
fingerprint is the plan; for a method it is off unless the query explicitly
turns it on, because most signatures identify nothing — a class has many a
`void(float)`, and taking the only one that exists today is picking at random
among the ones that happen to exist today. `MethodQuery::fingerprint` is the
opt-in, and it is for a shape that is genuinely rare on its owner, claimed
having seen the live class say so.

**An argument count is the third layer, and never a name either.**
`MethodQuery::parameter_count` narrows the overloads of a name that was given,
for the case where the types cannot be written out: a parameter whose type is
obfuscator output changes its spelling with the build, and a spelling that is
wrong refuses a method that is sitting right there — an argument count does not.
It is used only when no signature is given, and two overloads of the same arity
are an ambiguity and refused.

**Looking a class up must not change the game.** `il2cpp_runtime_class_init`
sounds like part of finding a class and is not: it runs the class's static
constructor, which is the game's own code, on whichever thread asked. One class
in this game answers that by building a singleton the game is not ready for, and
the game aborts before it starts — one added class query was enough to find that
out. Nothing here calls it; the export stays bound only so that the next person
to reach for it reads why.

**Nothing is asked about a class the runtime has registered but not built.**
IL2CPP registers a class long before it prepares one, and asking an unprepared
class for its members faults inside `GameAssembly`. Resolution runs twice a
second from the moment the module attaches — long before the game has built most
of what it will — so the gate is in `ResolveClass`, which reports `kNotReady`
and lets the loop ask again.

These are resolved today, and `map.walkable` stands for however many predicates
of that shape the running build declares — nine in the one this was written
against:

| key                      | method                                              | used by                   |
| ------------------------ | --------------------------------------------------- | ------------------------- |
| `self.moveTo`            | `bool DGLCONCOIBO(float, float)`                     | dodge, through `PlayerMover` |
| `self.computeShootAngle` | `void ELCBJAFBLJG(byte, out float, out bool, bool)`  | auto-aim, through `AimHook`  |
| `self.shootWithAngle`    | `void EHGHCACPAGH(float)`                            | auto-aim, through `AimHook`  |
| `shot.hitsWall`          | `bool GJFKGLJEGKO(int, int)`                         | projectile noclip, through `ProjectileNoclip` |
| `shot.tileBlocks`        | `bool IACODGNOFMH(int, int)`                         | projectile noclip, through `ProjectileNoclip` |
| `map.walkable.<name>`    | every `bool(float, float)` on the world manager       | player noclip, through `PlayerNoclip` |
| `self.tileSpeedHere`     | `float GCFKGLKAPND()`                                | player noclip, through `PlayerTileSpeed` |
| `self.applyTileSpeed`    | `void CNPNFDNDIJC()`                                 | player noclip, through `PlayerTileSpeed` |
| `world.objects` / `world.objects.alt` | the world manager's two `Dictionary<int, MapObject>` fields | auto-aim, through `MapObjects` — where the *client* has a monster, which is what a shot is tested against |
| `ui.MapObjectUIManager.ShowFloatingText` | `void ShowFloatingText(kind, string, …)` | floating text, through `FloatingText` |
| `ui.MapObjectUIManager.ShowFloatingText.number` | `void ShowFloatingText(kind, int, …)` | the same, read for the style the game draws with |

The two aim methods are **detoured, not called**: the client decides when to
shoot and builds the shot itself, and the only thing changed is the angle it
computes. Either one alone is useful, so each is installed as soon as its own
class is built — which is rarely the same turn of the loop.

The two collision methods are detoured too, and the opposite is true of them:
**both or neither.** The inner one makes the square under a shot passable, the
outer one puts it back, and half of that pair is a hole in somebody's map that
nothing closes. It needs three field keys with it — `shot.active`,
`map.MapObject.tile` and `map.Tile.collisionLayer` — and refuses to install
until every one of the five has answered.

The walkability predicates are **the one query in this project made by shape
rather than by name**, and the exception is deliberate. The reference
implementation carried seven obfuscated names, forced two of them and left the
other five counting calls so a live run could say which was the real gate. It
never said, and a live run here showed the list was no good anyway: of its two
forced names one is never called at all, and of the nine predicates this build
declares only three are.

So the query is `bool(float, float)` on the world manager, every one of them, up
to sixteen. The rule that normally forbids this — a method picked by shape is
*called* through a prototype that may not describe it — does not apply when the
shape is what is wanted: they are taken as a set, every member has the same
prototype by construction, and nothing is picked. A rename changes nothing and a
build that adds an eighth gets it hooked. Each is registered under its own key
so the report names them, in the order the detours go on.

The two speed methods are the other half of player noclip, and they are **both
or neither** for a reason the game's own movement states outright: it keeps
`min(the multiplier it stored, the multiplier the ground answers)`. Detouring
the answer alone leaves the low number the previous tick stored; correcting the
stored number alone is taken back by the next `min`. Together they agree on one,
and the player crosses water at the speed the character was built with. They
need the field key `self.moveMultiplier` with them — where the client keeps that
number — and refuse to install until all three have answered.

They were **counted separately for one live run**, which is the half of the
reference implementation's design that earned its keep: of the nine this build
declares, three are ever asked and six are never called at all — including one
of the two the reference forced. The counters came out again once they had said
that. They did not narrow the set and were not going to: a predicate unasked for
one session in one map is not a predicate the game does not have, and the six
cost nothing precisely because nothing calls them.

`ShowFloatingText` is **two methods of one name**, told apart by how many
arguments they take — a live run listed them:

```
ShowFloatingText(kind, System.String, Nullable<Color32>, float, float, float)
ShowFloatingText(kind, System.Int32,  Nullable<Color32>, float)
```

The first is what a line of ours goes out through. The second is what the game
itself calls all day, because damage and experience are *numbers* — detouring
only the first and waiting saw nothing at all over half a minute of real play.
Both are detoured now, and **neither is changed**: they forward every call, and
what they keep is the style argument, which is a member of an obfuscated
enumeration and is otherwise unknowable — IL2CPP's C API cannot read an
enumeration's constants back — along with the `MethodInfo*` the game passes and
which manager it passed them to. The style seen on the *player's own* manager is
the one preferred, because a damage number over a monster is drawn in the style
for a damage number over a monster. See `game/FloatingText.h`.

The receiver is not observed but read, through `map.MapObject.viewHandler` and
`map.ViewHandler.GUIManager`, **starting from the local player pointer.** Finding
it by walking the scene for a node named "Player" was tried and works only in an
empty map: with three hundred players in one, it finds somebody else, and the
line appears over a stranger while the game's own damage numbers look perfect.

These two are also **the only methods here queried by name and argument count**. Its signature runs through an enumeration whose type
name is obfuscator output and a `Nullable<Color32>`, so spelling the shape out
would be a guess at spellings rather than the disambiguation a signature is for
— and a wrong spelling refuses a method that is sitting right there.

Name alone was tried first, and a live run answered `more than one method
matches that name`: it is overloaded. So `MethodQuery::parameter_count` is the
third disambiguating layer, and it is the weakest one that is still a claim —
**a count never stands in for a name**, it narrows the overloads of a name that
was given, and two overloads of the same arity are refused exactly as two of the
same name are. Six is what the reference implementation asked
`il2cpp_class_get_method_from_name` for against this same build, and the
prototype in `FloatingText.cpp` is the one that went with it.

**Nothing under `shot.` resolves before the first shot of a session.** IL2CPP
builds a class the first time the game needs one, and the game does not need a
projectile until something has fired; an unresolved `shot.` key during the menu
looks exactly like a rename and means nothing. Only one still missing after real
play does.

**A detour goes in only once the feature asks for one.** An offset costs nothing
until something reads it; a hook is a write into the game's own code and is in
the way of every shot from the moment it exists. So the module installs the aim
detours the first time the runtime sends an `aim` record — which it only does
while auto-aim is switched on — the projectile collision detours the first
time the runtime claims `shots.noclip` — auto-aim's **Shots pass walls** setting
— and the walkability detours the first time it claims `player.noclip`. Each says in the runtime's log
which methods it went onto.

To find another, from one live run:

1. Open the overlay's Inspector and press **Export the player's class**. It
   takes no name on purpose: the class is eleven letters of obfuscator output
   that changes with the build, and the module already knows which one it is
   because every player offset is resolved through it. Its members go to the
   runtime's log with their signatures and entry points.
2. Write the method as a `MethodQuery` beside the ones above, name **and**
   signature, so a rename is recovered from the shape.
3. Write the matching prototype where it is used.

Leave a query empty rather than guessing at it. A feature that is quiet is
visible and harmless; a detour over the wrong method is neither.

## Classes outside the game's own assembly

Everything above is about `Assembly-CSharp`, which is the one image the runtime
opens for itself. The engine's classes are not in it: `UnityEngine.GameObject`
lives in `UnityEngine.CoreModule`, and asking for it by namespace and name alone
finds nothing.

So a `ClassQuery` may name the assemblies to look in, and when it does that is
the *only* place it looks — a query for `UnityEngine.UI.Image` must never be
answered by whatever the game happens to call `Image`, which is exactly the
plausible wrong answer this layer exists to refuse.

It names more than one, in order, because Unity moves its own types between
assemblies: the UI classes ship in `UnityEngine.UI` in one build and
`Unity.ugui` in the next, under the same namespace and the same name. That is an
alias for the *assembly* rather than for the class, and it proves exactly as
much as one. This build ships `UnityEngine.UI`; `Unity.ugui` is carried for the
one after it.

The keys under `unity.` and `map.` in the Offsets panel are these — the scene
walk and the map-data fields both features in `ScenePatches` need. See
`src/game/SceneFields.cpp`, and `docs/hpbarmod.md` for where they came from.

**None of this game's IL2CPP exports is renamed except one.** The shipped
`GameAssembly.dll` has no `il2cpp_domain_get_assemblies`; it has
`ac1164_wasting_your_life` instead. Nothing here calls it — an assembly is
reached with `il2cpp_domain_assembly_open` — but if `Il2CppApi::Load` ever
starts failing after an update, a renamed export carrying that suffix is the
first thing to look for.

## After a game patch

1. Run and read the Offsets panel. Anything still listed as resolved by exact
   name did not move.
2. A key that now says **recovered by fingerprint** is working, and is the one to
   look at *before* the following patch rather than after it. Find its new name
   with the Inspector and update the query.
3. A key that fails: check it is not simply a class the game has not built yet —
   get into the world and look again. If it still fails, the shape changed too,
   and it has to be found again from step 1.
4. Re-confirm against the packet stream before trusting anything that moved.

## The anti-tamper displacement

An offset that resolves cleanly can still be the wrong place to read. The game
moves the player's stat block away from where the metadata says it is, so a
field can have the right name, the right type, the right ordinal among its
siblings — and hold nothing.

The displacement is `0x50`, and it is **measured on every run, never written
down**. The runtime already knows health and maximum health from the packet
stream, so the module looks for the one distance at which *both* read back what
the server said. Two values rather than one, because a single number turns up in
memory by coincidence constantly; two of them a fixed distance apart, both
matching, do not. More than one candidate distance is a refusal.

**The block is rearranged, not merely moved**, and a constant would never have
said so. Health and maximum health sit at their declared offsets plus `0x50`.
Defence was found at the offset the metadata assigns to *maximum health* — so it
is located the same way, by the value the server gave, requiring it to occur
exactly once in the object. That offset is then held only while it keeps
agreeing: it was found by matching a value rather than by name, so it is the one
most likely to be a coincidence that lasted a while, and the check that found it
is the check that can take it away.

The practical consequence for anything added later: **a field is not confirmed
by resolving.** It is confirmed by agreeing with something that knows the answer
independently — which, for most of what a feature wants, is the packet stream.

### When a field will not come right

Use **Dump player object** in the Inspector. It prints the object word by word,
each as an integer and as a float, with what the server says on the first line.
Everything above was found that way: the displacement is visible as health
appearing `0x50` past where it was declared, and defence as a lone `35` sitting
where maximum health was supposed to be.
