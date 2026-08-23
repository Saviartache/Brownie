# Plugins

A plugin is a module that declares what it wants and is handed a narrow
capability object. It never sees a socket, a cipher, the pipeline, or another
plugin.

```ts
import { definePlugin, PluginCategory } from '@brownie/plugin-api';

export default definePlugin({
  meta: {
    id: 'auto-nexus',
    name: 'Auto Nexus',
    category: PluginCategory.Combat,
    description: 'Escapes to the nexus before a hit would be lethal.',
  },
  setup(ctx) {
    const threshold = ctx.settings.range('hpPercent', {
      label: 'Escape below',
      default: 25,
      min: 1,
      max: 99,
      step: 1,
    });

    // onFirst: this must see a health drop before a plugin that might drop the
    // packet does. Ordinary plugins use `on`.
    ctx.packets.onFirst('NEWTICK', (packet, session) => {
      const { hp, maxHp } = session.self;
      if (maxHp > 0 && (hp / maxHp) * 100 <= threshold.get()) {
        session.sendToServer('ESCAPE', {});
        packet.drop();
      }
    });

    ctx.commands.register({
      name: 'nexus',
      description: 'Escape to the nexus now.',
      run: (_args, session) => {
        session.sendToServer('ESCAPE', {});
      },
    });
  },
});
```

## Lifecycle

```
discover → load → setup → enabled ⇄ disabled → dispose
                     ↘ failed
```

`setup` runs **once**, while the plugin is still disabled. It declares settings
and registers handlers; the host owns every subscription and only *delivers* to
it while the plugin is enabled.

That is why there is no `onEnable`/`onDisable` pair: enabling is a gate the host
applies, not work the plugin repeats — and forgetting to unregister on disable
is the most common way a plugin system leaks.

`setup` is synchronous. An `async setup` would leave a window in which a plugin
is loaded but has not finished subscribing, so a packet arriving during it would
reach some of its handlers and not others. Asynchronous work starts inside
`setup` and owns its own failure.

Cleanup goes through `ctx.onDispose`, and nothing else — one mechanism, not two.

## Failure isolation

* A plugin that throws in `setup` is marked `failed` and skipped. Nothing else
  is affected.
* A plugin whose handler throws has the error attributed to it and counted; the
  packet continues down the pipeline with the verdict it already had.
* A plugin that throws repeatedly is disabled with a reason, rather than left to
  spray errors into every packet.

One plugin's mistake never reaches another plugin, the proxy, or the game.

## The context

| Member | What it is for |
|---|---|
| `ctx.packets` | `on`, `onFirst`, `onAny` — packet subscriptions |
| `ctx.commands` | chat commands, consumed only if the handler succeeds |
| `ctx.settings` | typed setting handles: `boolean`, `number`, `range`, `select`, `text`, `button` |
| `ctx.sessions` | the current session, and connect/disconnect events |
| `ctx.native` | `setFeature`, and whether the native module is connected |
| `ctx.timers` | timers the host cancels with the plugin |
| `ctx.log` | levelled logging, tagged with the plugin |
| `ctx.onDispose` | cleanup |

Each is a small interface, so a plugin is testable against fakes with no proxy,
no game and no network.

## Settings

Declaring a setting returns a **typed handle**, not a string key:

```ts
const mode = ctx.settings.select('planner', {
  label: 'Planner',
  default: 'rollout',
  options: [
    ['rollout', 'Rollout'],
    ['gradient', 'Gradient'],
  ],
});

const radius = ctx.settings.range('radius', {
  default: 1.5,
  min: 0,
  max: 4,
  step: 0.1,
  visibleWhen: { key: 'planner', equals: ['gradient'] },
});
```

One declaration is the source of truth for three things at once: the value the
plugin reads, the control the overlay draws, and the key the config store
persists.

`visibleWhen` hides rather than disables — against the overlay's usual rule,
because a plugin with one knob per planner would otherwise show several sets of
greyed-out controls that can never apply at once.

## Packets

`packet.fields` is read-only; `packet.set(field, value)` marks the packet for
re-encoding. That asymmetry is what lets the pipeline forward an untouched
packet from its original bytes and rebuild only the ones that changed — so a
packet definition that has drifted from the live game can fail to *describe*
traffic but can never corrupt it.

`set` refuses a field the packet's schema does not have, and refuses entirely on
a packet whose body did not decode. Both would otherwise be silent no-ops.

Use `packet.number(...)`, `.string(...)`, `.boolean(...)` rather than casting:
they return `undefined` for the wrong type instead of letting a string travel on
as a number.

## Reading the world

`session.world` is a **snapshot accessor**, valid for the call that handed it
out. Holding a view across ticks and expecting it to update is a mistake; ask
again.

An entity carries the stats the runtime names — health, conditions, guild — and
`entity.stat(id)` for every other one the server has sent, so a boss phase
written into a stat nothing else reads needs no change to the state layer. Its
mirror `entity.text(id)` reads the ids that carry a string, which are usually
not text at all but a packed blob — a container's enchants, say — so decode it
and survive a build that encodes it differently. Match a **value you can
recognise** rather than testing for non-zero: a stat id is a fact about a game
build, and the two tables in this repository do not agree about all of them.
`features/sanctuary/punishedHits.ts` is the worked example.

`session.self.inventory` is what the player is wearing, carrying and drinking
from, addressed by the slot ids the item packets use. **A slot the server has
not stated is absent, not empty** — see the note in
[`docs/architecture.md`](architecture.md). A plugin that moves items reads
`carried()`, `backpack()` and `belt()` and never assumes a slot it was not told
about, because that is a swap aimed at a slot that may well be full.

More important, and the one that has actually cost time: **the world keeps what
is currently true, not a history.** Entities go on `UPDATE.drops`, tiles and
everything positional go on a map change, and shots go the moment their flight
ends.

That last one is a trap, because it is the opposite of what the packet you are
handling implies. A `PLAYERHIT` exists *because* the bullet's flight ended — it
hit the player — and then it travelled back to the proxy. `world.projectiles()`
only holds shots still in the air, and shots in this game live 600–2000 ms, so
by the time the hit arrives its shot has expired and been pruned. A handler that
goes looking for it there finds nothing, in every real session, silently.

**Record what you need when the shot is announced, and keep it longer than the
flight.** `ENEMYSHOOT` is where a shot can still be asked about; remember the
answer under each of the volley's bullet ids and read it back at the hit.

Bound such a log by age and by size, and clear it on `MAPINFO` — **an object id
is only unique within a map**, so an entry carried across one does not cost
memory, it acts on the wrong object. `features/autonexus/BulletLog.ts` is the
worked example.

## Injecting a packet toward the server

**Read this before writing a plugin that sends anything.** A client→server
packet is slipped into a stream the server is already tracking, and it has to
look like something that stream would have produced. Four rules, every one of
them learned by ending a live session:

**1. Stamp `time` with `session.world.clientTimeMs`, read at the moment of
sending.** That is the clock the *game client* puts on its own packets — not
`world.gameTimeMs`, which counts from when this proxy opened the server link.
The two are unrelated numbers: the client has usually been running for a while,
through other maps, before this connection existed. A packet stamped with the
wrong one is discarded in silence — no error, no effect, nothing in the stream
to say so, and since nothing acknowledges an item move or a drink either, the
result is indistinguishable from a refusal. `USEITEM`, `INVENTORYSWAP`,
`PLAYERSHOOT`, `MOVE` and their neighbours all carry one.

**2. Never let a stamp go backwards.** The client's stamps are a rising
sequence and a packet injected into the middle of it is part of that sequence.
So do not cache a stamp and reuse it later. `clientTimeMs` will not read behind
the client's own last stamp, but the *order* of what a plugin sends is still the
plugin's to get right.

**3. Set the fields a working implementation sets, and no more — a trailing
optional in the definition file is not an invitation.** `INVENTORYSWAP` has an
optional `tickId` there; this build of the game does not carry it. Filling it in
— which looks like exactly the right way to place an operation in the tick
sequence — made the server answer `Bad message received` and hang up, on *every*
swap including the one that had been working a minute earlier. An optional field
is a field some build had, not one this build wants.

**4. Leave a gap between packets that change the same thing.** Two item moves
inside half a second end the session; the same two seven seconds apart are fine.
Auto-loot holds everything it sends to one second by default and never resets
that spacing — not even when the player steps from one loot bag onto another,
which is precisely the case that produced the fatal pair.

### What the server says when it refuses

`FAILURE` is the only account it gives before hanging up, and it is worth
knowing how to read even though nothing logs it by default. Its `errorId` is
always 0 and says nothing; the **message** is what distinguishes the two kinds
of failure:

| message | what it means |
|---|---|
| empty | a rule was refused — the packet parsed, its contents were rejected |
| `Bad message received` | the packet did not parse — wrong fields, wrong length |

While chasing one of these, log `FAILURE` from a packet handler; the difference
between those two answers is what tells a malformed packet from a rejected
action, and confusing them costs days.

The full reasoning, and the sessions that paid for each rule, are under *the
client's timeline* in [`docs/architecture.md`](architecture.md).

## Native features

```ts
ctx.native.setFeature('player.collider', true);
```

The native module stores nothing. The runtime remembers the last value per key
and re-sends every key whenever the module (re)connects, so a plugin sets a key
once and never has to watch the connection. Unknown keys are ignored by the
module, so a newer plugin never breaks an older build.

Which keys a build resolves, and what each of them means, is the table in
[`docs/ipc.md`](ipc.md). Read the note under it before adding one: a key that
makes the module change the game is a **lease**, restated once a second while
the plugin wants it and dropped by the module a few seconds after it stops —
because a plugin can be disabled, can fail, can be unloaded, and the runtime
behind it can be killed, and none of those say so.
