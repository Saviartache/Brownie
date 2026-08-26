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
| `ctx.settings` | typed setting handles: `boolean`, `number`, `range`, `select`, `multiSelect`, `text`, `colour`, `button` |
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

`multiSelect` is a many-of-N choice, drawn as a list of checkboxes. Its handle
reads back a `readonly string[]`, but the value is stored and sent as a single
string of the chosen keys joined by `MULTI_SELECT_DELIMITER` — the persistence
and overlay layers carry one scalar value per setting, and a set that rode along
as an array would need every one of them to learn a new shape. Unknown keys are
dropped on write, and the stored string is always the chosen keys in the order
the options were declared, so the same set never reads as a change.

```ts
const dungeons = ctx.settings.multiSelect('portals', {
  label: 'Dungeons to enter',
  default: [],
  options: [
    ['1818', 'Snake Pit Portal'],
    ['1817', 'Undead Lair Portal'],
  ],
});
// dungeons.get() -> readonly string[];  dungeons.has('1817') -> boolean
```

`colour` is a colour, drawn as a picker with a bar for red, green, blue and
alpha. Its value is **always `#rrggbbaa` in lower case**, whatever spelling it
was set from: `#RRGGBB` is accepted and made opaque, and anything else is
refused so that what the setting holds stays a colour. That is the point of the
kind rather than a `text` field — a colour nothing has to validate is one the
overlay can draw and the injected module can apply without either of them
inventing a fallback. A default that is not a colour fails the plugin's setup,
like a `select` default that is not one of its options.

`visibleWhen` hides rather than disables — against the overlay's usual rule,
because a plugin with one knob per planner would otherwise show several sets of
greyed-out controls that can never apply at once.

`hidden: true` declares a setting the overlay never draws at all. It is not a
knob, it is state the plugin has to keep across runs — the skin changer's record
of what was chosen for each character class, for one. A declaration is already
the only thing the config store persists, so this is where such state belongs
instead of in a second file with a lifetime of its own.

## Hotkeys

A plugin can offer a key that switches it on and off:

```ts
meta: {
  id: 'auto-dodge',
  name: 'Auto Dodge',
  category: PluginCategory.Movement,
  bindable: true,
}
```

That is the whole declaration. The plugin registers nothing, hears nothing about
the key, and cannot read it — the switch a bind moves is the *host's*, so the
bind that moves it is the host's too. What the plugin gets is a control in the
overlay: a key, and whether it **toggles** the plugin or holds it on while the
key is down.

`bindable` is opt-in rather than universal because a bind is only worth having
where switching mid-fight is the point. A chat filter is switched on once and
left there, and a row for binding one is a control that answers a question
nobody asked.

**A string names a boolean setting to bind instead of the switch.** A plugin
cannot observe its own switch moving — that is the whole reason there is no
`onEnable`/`onDisable` pair — so one that has to *undo* something when it stops
carries its own armed setting, and that is what a key has to move:

```ts
meta: { id: 'player-noclip', /* … */ bindable: 'active' },
setup(ctx) {
  const active = ctx.settings.boolean('active', { default: false });
  active.onChange((on) => (on ? start() : stop()));
}
```

Pressing the key then switches the plugin on *and* arms the setting, because an
armed setting inside a plugin nobody enabled does nothing — its timers never
run. Switching off only disarms: that is what makes the plugin let go of
whatever it was holding, and taking the plugin's switch away as well would undo
something the user chose.

**A list offers more than one key.** A plugin that is switched on for a run and
then *told* something inside it wants two: auto-dodge is one — its own switch,
and a key that holds the ground you are standing on:

```ts
meta: {
  id: 'auto-dodge', /* … */
  bindable: [{ label: 'Hotkey' }, { setting: 'anchor', label: 'Anchor here' }],
},
```

Each entry is a row in the overlay and a key of its own. What identifies one is
the **slot** — the setting it moves, or nothing for the plugin's own switch — so
the slot is as much part of the plugin's identity as its id: renaming one loses
the key the user chose. Two entries naming one slot is refused at
`definePlugin`, because two rows writing one stored key is one press moving
whichever of them the host kept.

**Every press says what it did**, over the character, in the game's own floating
text — `Auto Aim: On`, `Auto Loot: Off`. A key exists so that switching mid-fight
does not mean opening a panel, and a key you then have to open the panel to
verify is not that key.

The line is the plugin's **name** and its two states, which default to `On` and
`Off`. A bind whose switch does not read that way says so:

```ts
bindable: [
  { label: 'Hotkey' },
  {
    setting: 'anchor',
    label: 'Anchor here',
    announce: { name: 'Anchor', on: 'set', off: 'unset' },
  },
],
```

The plugin declares the words and nothing else — the line is said by the host,
because the host is the only side that knows what a press actually did. A plugin
cannot watch its own switch, a hold puts a switch back with nobody pressing
anything, and a key bound to a plugin that cannot be switched moves nothing at
all; a plugin announcing its own state would be announcing what it was asked
for. The state is read back after the move for the same reason.

**A hold puts back what it found.** A plugin that was already running comes back
running when the key comes up, rather than being switched off by a key that only
meant to switch it on. Each slot is remembered separately, so holding two of one
plugin's keys is two holds. And a hold ends on its own when the module stops
reporting — an alt-tab, the overlay opening, the game closing — because a hold
nothing can revoke is a plugin left running by a key nobody is pressing.

Which key a bind names, and why it is stored the way it is, is
[`docs/ipc.md`](ipc.md#hotkeyevent) — the short version being that it is the
*physical* key, so it survives the player changing keyboard layout.

## Persistence

Every setting value, every plugin's on/off switch, and the key bound to that
switch survive a restart. They are kept in `config/plugins.json`, beside the
runtime's own configuration:

```json
{
  "version": 1,
  "plugins": {
    "auto-nexus": { "enabled": true, "settings": { "hpPercent": 40 } },
    "auto-dodge": {
      "enabled": false,
      "bind": "hold:Mouse5",
      "binds": { "anchor": "toggle:F6" },
      "settings": {}
    }
  }
}
```

`bind` sits beside `enabled` rather than among the settings, and for the reason
the switch itself does: neither is declared, neither has a descriptor to
validate against, and both belong to the host. A bind the file no longer
describes — a mode this build dropped, a key it has no name for — leaves the
plugin unbound rather than bound to a guess.

`binds` holds the plugin's *other* keys, filed under the settings they move. It
is a second field rather than one map with an empty key in it because the
switch is the one slot that is not a setting, and `"": "hold:Mouse5"` is not a
line anybody reading the file could act on.

The file is the user's, not the project's — it is written by clicking rather
than by editing, and it is not in the repository.

A plugin reads its persisted values while it is *declaring* them, so there is no
replay step afterwards and no window in which a plugin is running on defaults it
was never meant to have. A value that no longer fits its declaration — bounds
tightened, an option removed, a key renamed — falls back to the new default
rather than being restored out of range, and a key this build no longer declares
is ignored rather than being an error.

`meta.enabledByDefault` decides how a plugin starts **the first time it is ever
seen**. After that the stored switch wins, including when the user switched the
plugin off. Restoring never writes: only moving a switch or changing a value
does, so a build that changes a default still applies it to anyone who never
touched that setting.

Writes are coalesced — dragging a slider is one write, not one per frame — and
land by renaming a complete file over the old one, so a run that dies mid-write
cannot leave half a configuration behind.

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
