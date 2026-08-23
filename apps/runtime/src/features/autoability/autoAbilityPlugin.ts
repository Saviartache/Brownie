/**
 * Auto-ability: casts the support half of the ability slot, and points the
 * other half at an enemy instead of at the mouse.
 *
 * **What the ability does is read from the ability, not from the class.** The
 * implementation this came from kept two hand-written sets of class ids — the
 * ones that aim and the ones that self-cast — and left the rest out, so every
 * class the game has added since did nothing at all and a Trickster holding a
 * prism was still classed as "aims at enemies" while the prism teleported him.
 * `objects.xml` states what an item does when it is used, and `gamedata/
 * abilities.ts` reads it: what moves the character, what needs a target, what
 * buffs, what it costs and how long it lasts. Nothing here knows a class id.
 *
 * **Nothing is cast that the player did not equip for.** An ability whose
 * effects the data file describes in terms `abilities.ts` does not recognise is
 * never fired, in the same way an unfamiliar weapon makes auto-aim go quiet:
 * the game adds effects faster than a table learns them, and a timer on an
 * unknown one is a timer on whatever it turns out to do.
 *
 * **And nothing is cast because a timer said so.** A priest's tome is a heal;
 * firing it at full health throws away both the heal and the mana that would
 * have paid for the next one. So the question asked every tick is not "has the
 * interval elapsed" but "is any of what this ability gives worth having right
 * now" — health while health is missing, an aura while something is there to
 * use it on, a cleanse while something is actually wrong, and none of them
 * while the character is already carrying the effect. That is
 * {@link castReason}, and the interval is only a floor under it.
 *
 * **Being aimed is not a reason to cast, only a place to cast at.** Support
 * abilities carry attacks as riders — `pD Tome` heals, raises a healing aura
 * and fires a shot — and letting the rider decide is how a 180-mana heal went
 * off every 700 ms for as long as anything was on screen.
 *
 * **An attack ability is never cast here, only pointed.** A quiver, a spell, a
 * trap and a scepter give nothing this build can name, so there is no moment
 * that makes one worth firing — only a player who decided to fire it. Those
 * wait for the key press, and all this does with it is rewrite the one field
 * the client fills from the mouse, so the ability lands on the enemy rather
 * than wherever the cursor happened to be. When to spend the mana stays the
 * player's decision; the only thing taken off them is the aiming.
 *
 * **The target is picked the way auto-aim picks one**, out of the same two
 * modules rather than out of a second opinion — see the import below. It is not
 * *read* from auto-aim: one plugin cannot read another, and asking the same
 * question of the same code needs no channel between the two.
 *
 * **Which includes the choice, and not only the code that makes it.** This used
 * to take the closest enemy and nothing else, so a player aiming at the monster
 * under their cursor watched the ability go to whatever had wandered nearest.
 * The same four choices auto-aim offers are offered here, in auto-aim's own
 * words and under its own keys, with the cursor read from the same place —
 * plus the one an ability wants that a shot does not: whether a boss is worth
 * more than whatever is standing closer. A shot costs nothing and can be spent
 * on a bat; 180 mana is a heal the boss room needed.
 *
 * **It reads the character, not the party.** A priest's tome heals everyone
 * standing in it, and a group in trouble around a healthy priest is not
 * something the runtime can see — the server states other players' health, but
 * whether they want a heal from *this* character is a judgement, not a fact.
 * So the trigger is the player's own bar, which is the half that is knowable,
 * and healing the group is still the player's key to press.
 *
 * **It sends `USEITEM`, exactly as the client does for a key press.** The
 * position it names is where the effect lands — an enemy for an aimed ability,
 * the character for a buff — which is the same field the client fills with the
 * mouse, and the same field the redirect above rewrites. Injected packets do
 * not re-enter the pipeline, so this plugin never sees its own cast and needs
 * no flag to tell one from a real key press.
 *
 * It does not reconcile with auto-drink: mana potions are that plugin's
 * threshold and this one's reserve, and moving somebody's setting on their
 * behalf would be worse than leaving both where they put them.
 */

import {
  PluginCategory,
  definePlugin,
  type EntityView,
  type Plugin,
  type Position,
  type SessionView,
  type SettingHandle,
  type SettingValue,
} from '@brownie/plugin-api';
import { isSafeZone } from '../../constants/SafeZones.js';
import { AbilityUse, type AbilityFacts } from '../../gamedata/abilities.js';
// Auto-aim's, and deliberately not a second copy: which enemies are worth
// pointing something at is one question with one hard-won answer — a wall in
// this game is an object with hit points, and a quarter of what the file marks
// as an enemy can never lose one. Casting into either is the same waste as
// shooting at it. See `autoaim/shootable.ts`.
import {
  BossRule,
  TargetPriority,
  selectTarget,
  type BossPreference,
} from '../autoaim/selectTarget.js';
import { isShootable, type ShootableRules } from '../autoaim/shootable.js';
import { castReason, percentOf, type CastPreferences } from './worthCasting.js';

export interface AutoAbilityInputs {
  /**
   * What `objects.xml` says about an ability item. See `ObjectCatalog.item`.
   *
   * Handed over by the composition root because a plugin is not given the
   * object catalog. `undefined` is an item the catalog cannot describe — and
   * for every item at all until the data files have been read — which is what
   * makes this feature do nothing rather than guess.
   */
  readonly ability: (objectType: number) => AbilityFacts | undefined;
  /** Whether an object type is scenery. Same source and reason as {@link ability}. */
  readonly isObstacle: (objectType: number) => boolean;
  /** Whether an object type can never be hurt. Same source and reason. */
  readonly isInvincible: (objectType: number) => boolean;
  /**
   * Whether an object type is a boss. Same source and reason — it is
   * `<Quest />` in `objects.xml`. See `ObjectCatalog.isQuest`.
   */
  readonly isBoss: (objectType: number) => boolean;
  /**
   * Where the player is pointing, in tiles, or nothing when nobody knows.
   *
   * Handed over for the same reason as the rest: it arrives from the native
   * module and a plugin is not given the link. **Asking for it is what keeps it
   * coming** — the module measures the cursor only while the runtime says it
   * wants it, and the claim rides this call. See `native/CursorTracker.ts`.
   */
  readonly cursorPoint: () => Position | undefined;
}

/**
 * The second of the four worn slots, which is the ability everywhere in the
 * game: weapon, ability, armour, ring. See `state/ItemSlots.ts` for the space
 * these ids live in.
 */
const ABILITY_SLOT = 1;

/** `USEITEM.useType` for using something out of one of your own slots. */
const USE_TYPE_SELF = 1;

/**
 * How long a cast by hand holds this off.
 *
 * The point is not the game's cooldown — mana already covers that — but intent:
 * somebody who just pressed the key is using the ability deliberately, and
 * firing again a fifth of a second later spends the mana their next press
 * needed.
 */
const MANUAL_PAUSE_MS = 2000;

/**
 * How long after a map change nothing is cast.
 *
 * Long enough for the client to finish loading and for the server to state the
 * character's mana and slots for the new map. A cast built from the last map's
 * numbers is a cast at a position nothing is standing in.
 */
const MAP_SETTLE_MS = 1000;

/**
 * There is no setting for either.
 *
 * Auto-aim offers them because an invulnerable boss phase ends and a shot in
 * flight can land after it does. An ability is instant and costs mana, so there
 * is no reading under which casting one at a wall is what the player wanted.
 */
const SHOOTABLE: Omit<ShootableRules, 'isObstacle' | 'isInvincible'> = {
  skipUntouchable: true,
  skipObstacles: true,
};

/**
 * Every setting, folded into one record when one of them moves.
 *
 * Read rather than looked up, which is the same reason Oryx's Sanctuary folds
 * its switches: a handle's `get` is a map lookup, there are eight of them on
 * this path, and none of the answers changed between one server tick and the
 * next. It extends {@link CastPreferences} so the three the decision wants can
 * be handed straight to it instead of built into a fresh object per tick.
 */
interface Tuning extends CastPreferences {
  /** Point an attack ability the player fires, rather than leave it on the mouse. */
  readonly aimAttacks: boolean;
  readonly support: boolean;
  readonly rangeTiles: number;
  /** Which enemy out of the ones in range, in auto-aim's own terms. */
  readonly priority: TargetPriority;
  readonly cursorRadiusTiles: number;
  /**
   * Built here rather than per search, because both halves of it are settled
   * the moment a setting moves: the rule is the setting, and the test behind it
   * is the catalog, which does not change.
   */
  readonly bosses: BossPreference;
  /** The share of the mana bar to leave standing, as a fraction of it. */
  readonly manaReserve: number;
  readonly minIntervalMs: number;
}

/**
 * What one connection remembers.
 *
 * The map name rides along with the clock so "is this a safe zone" is answered
 * once per map rather than once per tick — the test lowercases the name, and a
 * string built five times a second to reach the same verdict is the only thing
 * on this path that allocates at all.
 */
interface SessionState {
  /** When this session may cast again, on the world's clock. */
  nextAtMs: number;
  mapName: string;
  safeZone: boolean;
}

export function createAutoAbilityPlugin(inputs: AutoAbilityInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-ability',
      name: 'Auto Ability',
      category: PluginCategory.Combat,
      description: 'Casts your support ability when it is worth it, and aims the attacks you fire.',
    },

    setup(context) {
      // The two halves of the feature, and they are not the same offer: one
      // decides when to spend the mana, the other only decides where what the
      // player already spent lands.
      const aimAttacks = context.settings.boolean('aimAttacks', {
        label: 'Aim the attack abilities you use — quivers, spells, traps, scepters',
        default: true,
      });
      const castSupport = context.settings.boolean('castSelf', {
        label: 'Use support abilities — heals, buffs, auras, cleanses',
        default: true,
      });
      // **Auto-aim's own question, asked in auto-aim's own words**, because the
      // complaint that produced it was that the two disagreed: a player aiming
      // at the enemy under their cursor had the ability go to whatever stood
      // closest instead. The options and the keys are the same as that
      // plugin's, so the two read alike wherever they are shown together — and
      // they stay two settings, because pointing a 180-mana heal is not the
      // same decision as pointing a shot that costs nothing.
      const priority = context.settings.select<TargetPriority>('priority', {
        label: 'Aim at',
        default: TargetPriority.Closest,
        options: [
          [TargetPriority.Closest, 'The closest enemy'],
          [TargetPriority.LowestHp, 'The weakest enemy'],
          [TargetPriority.HighestHp, 'The toughest enemy'],
          [TargetPriority.ClosestToCursor, 'The enemy nearest your cursor'],
        ],
      });
      const cursorRadius = context.settings.range('cursorRadiusTiles', {
        label: 'Cursor radius (tiles)',
        default: 4,
        min: 0.5,
        max: 15,
        step: 0.5,
        visibleWhen: { key: 'priority', equals: [TargetPriority.ClosestToCursor] },
      });
      // **A tier over the priority above, not another entry in it.** The two
      // answer different questions — which class of enemy is worth the mana,
      // and which one out of that class — and the rule holds for everything
      // this plugin looks for an enemy for: where the ability the player fires
      // lands, and whether a combat aura is worth putting up at all. Somebody
      // who set "only bosses" and then watched their seal go up for two bats is
      // owed the reading of the words.
      const bosses = context.settings.select<BossRule>('bosses', {
        label: 'Bosses',
        default: BossRule.Any,
        options: [
          [BossRule.Any, 'Treat like any other enemy'],
          [BossRule.Prefer, 'Prefer bosses'],
          [BossRule.Only, 'Only bosses'],
        ],
      });
      const rangeTiles = context.settings.range('rangeTiles', {
        label: 'Look for enemies within (tiles)',
        default: 8,
        min: 3,
        max: 20,
        step: 1,
      });
      // The two thresholds that are the player's to set, and the only ones:
      // whether a berserk aura needs an enemy nearby is not a preference, it is
      // what a berserk aura is, and the data file already says so.
      const healthPercent = context.settings.range('healthPercent', {
        label: 'Cast healing abilities at or below (% health)',
        default: 80,
        min: 10,
        max: 100,
        step: 5,
      });
      const manaPercent = context.settings.range('manaPercent', {
        label: 'Cast mana abilities at or below (% mana)',
        default: 50,
        min: 10,
        max: 100,
        step: 5,
      });
      const utilityOutOfCombat = context.settings.boolean('utilityOutOfCombat', {
        label: 'Keep speed and stealth up outside combat',
        default: false,
      });
      const mpReservePercent = context.settings.range('mpReservePercent', {
        label: 'Keep at least (% mana)',
        default: 0,
        min: 0,
        max: 90,
        step: 5,
      });
      // A floor under everything the data file says, not the interval itself:
      // what an ability costs and how long it lasts already pace it. This is
      // what stops a free, instant ability from being sent on every tick.
      const minIntervalMs = context.settings.number('minIntervalMs', {
        label: 'Wait between casts (ms)',
        advanced: true,
        default: 700,
        min: 250,
        max: 5000,
        step: 50,
      });

      const isBoss = (enemy: EntityView): boolean => inputs.isBoss(enemy.objectType);

      const readTuning = (): Tuning => ({
        aimAttacks: aimAttacks.get(),
        support: castSupport.get(),
        rangeTiles: rangeTiles.get(),
        priority: priority.get(),
        cursorRadiusTiles: cursorRadius.get(),
        bosses: { rule: bosses.get(), isBoss },
        // Kept as a fraction rather than the percentage the control shows, so
        // the per-tick arithmetic is one multiply.
        manaReserve: mpReservePercent.get() / 100,
        minIntervalMs: minIntervalMs.get(),
        hpPercent: healthPercent.get(),
        mpPercent: manaPercent.get(),
        utilityOutOfCombat: utilityOutOfCombat.get(),
      });

      let tuning = readTuning();
      const refresh = (): void => {
        tuning = readTuning();
      };
      for (const handle of [
        aimAttacks,
        castSupport,
        rangeTiles,
        priority,
        cursorRadius,
        bosses,
        healthPercent,
        manaPercent,
        utilityOutOfCombat,
        mpReservePercent,
        minIntervalMs,
      ] as readonly SettingHandle<SettingValue>[]) {
        context.onDispose(handle.onChange(refresh));
      }

      const rules: ShootableRules = {
        ...SHOOTABLE,
        isObstacle: inputs.isObstacle,
        isInvincible: inputs.isInvincible,
      };

      const bySession = new Map<string, SessionState>();

      /** This session's state, with its safe-zone verdict current. */
      const stateFor = (session: SessionView): SessionState => {
        const mapName = session.world.mapName;
        const held = bySession.get(session.id);
        if (held === undefined) {
          const fresh: SessionState = {
            nextAtMs: Number.NEGATIVE_INFINITY,
            mapName,
            safeZone: isSafeZone(mapName),
          };
          bySession.set(session.id, fresh);
          return fresh;
        }
        if (held.mapName !== mapName) {
          held.mapName = mapName;
          held.safeZone = isSafeZone(mapName);
        }
        return held;
      };

      /**
       * How long to wait after a cast before the next one is worth sending.
       *
       * An aimed ability is not slowed to the length of a buff it also happens
       * to grant: a knight's shield raises a damage aura and its point is still
       * the shot, so pacing it to the aura would be pacing an attack by
       * something that is not the attack. What holds one of those back is mana
       * and {@link Tuning.minIntervalMs}.
       */
      const intervalOf = (ability: AbilityFacts, aimed: boolean): number => {
        const refreshMs = aimed ? 0 : (ability.refreshMs ?? 0);
        return Math.max(tuning.minIntervalMs, ability.cooldownMs ?? 0, refreshMs);
      };

      // Built once rather than per search: the rules behind it are settled in
      // `setup` and a fresh closure per tick is a fresh closure per tick.
      const worthCastingAt = (enemy: EntityView): boolean => isShootable(enemy, rules);

      /**
       * The best enemy in range under a given ordering.
       *
       * The cursor is read here rather than passed in because a search can
       * happen between two ticks — the player's own key press is one — and a
       * cursor that has moved since the last tick has moved.
       */
      const search = (session: SessionView, priority: TargetPriority): EntityView | undefined =>
        selectTarget(session.world.enemies(), {
          shooterX: session.self.x,
          shooterY: session.self.y,
          maxRangeTiles: tuning.rangeTiles,
          priority,
          cursorPoint:
            priority === TargetPriority.ClosestToCursor ? inputs.cursorPoint() : undefined,
          cursorRadiusTiles: tuning.cursorRadiusTiles,
          bosses: tuning.bosses,
          accept: worthCastingAt,
        });

      /** Where an ability that is pointed should land: the player's own choice. */
      const targetEnemy = (session: SessionView): EntityView | undefined =>
        search(session, tuning.priority);

      /**
       * Whether there is anything here to put a combat aura up for.
       *
       * **The pointing preference is deliberately not asked.** Which enemy to
       * point at is a preference about aiming; whether a berserk aura is worth
       * 90 mana is a question about the room, and a paladin surrounded by
       * monsters with the cursor resting on empty floor is in a fight. Only the
       * boss rule crosses over, because that one *is* about what the mana is
       * worth spending on.
       */
      const enemyToFight = (session: SessionView): EntityView | undefined =>
        search(session, TargetPriority.Closest);

      // Cheapest test first, and each one is a test the next would have been
      // wasted work without. Nothing on this path allocates until a cast is
      // actually going out, bar the reading below under the one priority that
      // asks for it.
      context.packets.on('NEWTICK', (_packet, session) => {
        // **Asked for and thrown away, ahead of every reason to stop below.**
        // The module measures the cursor only while somebody keeps asking, and
        // the search that wants it runs elsewhere: the player's key press lands
        // between ticks, and an attack ability never reaches the cast path here
        // at all. Waiting to ask until a search needs one would mean the first
        // search after a quiet spell — which is the key press — got no reading.
        if (tuning.priority === TargetPriority.ClosestToCursor) inputs.cursorPoint();

        const self = session.self;
        if (!self.alive) return;

        const state = stateFor(session);
        if (state.safeZone) return;

        const nowMs = session.world.gameTimeMs;
        if (nowMs < state.nextAtMs) return;

        const slot = self.inventory.at(ABILITY_SLOT);
        if (slot === undefined || slot.objectType <= 0) return;

        const ability = inputs.ability(slot.objectType);
        if (ability === undefined || ability.use === AbilityUse.Never) return;

        // **Only what an ability *gives* is ever cast from here.** An attack
        // ability gives nothing this build can name, and there is no moment
        // that makes one worth firing — only a player who decided to fire it.
        // Those are handled on the way past in the `USEITEM` handler below.
        if (!tuning.support || ability.benefits.length === 0) return;

        // Whether it is also pointed at something, which a tome can be.
        const aimed = ability.use === AbilityUse.Aimed;

        // The cost first, then the reserve on top of it: a cast that leaves the
        // bar under what the player asked to keep is one they did not want, and
        // a cast the server refuses for want of mana is a packet sent for
        // nothing. An unstated maximum reserves nothing rather than everything.
        const reserve = self.maxMp > 0 ? self.maxMp * tuning.manaReserve : 0;
        if (self.mp < ability.mpCost + reserve) return;

        // Looked up at most once per tick, and often not at all: a pass over
        // every visible enemy is by far the most expensive thing here, and a
        // priest at full health is turned down before anything needs to know
        // whether the room is empty.
        //
        // **Something to fight is whatever the boss rule allows**, so a player
        // who asked for bosses only gets a combat aura for a boss and not for
        // the two bats that walked in — which is the sentence the setting is
        // written in.
        let enemy: EntityView | undefined;
        let searched = false;
        const hasEnemy = (): boolean => {
          if (!searched) {
            searched = true;
            enemy = enemyToFight(session);
          }
          return enemy !== undefined;
        };

        // **What the ability gives decides whether to cast; being aimed decides
        // only where.** Several support abilities carry an attack as a rider —
        // `pD Tome` heals and also fires a shot — and treating that rider as the
        // reason is how a 180-mana heal went off every 700 ms for as long as
        // anything was on screen.
        const reason = castReason(
          ability.benefits,
          {
            hpPercent: percentOf(self.hp, self.maxHp),
            mpPercent: percentOf(self.mp, self.maxMp),
            conditions: self.conditions,
            enemyNear: hasEnemy,
          },
          tuning,
        );
        if (reason === undefined) return;

        // An aimed ability is pointed at the enemy so its attack lands, and at
        // the character when there is nobody to point it at — which happens
        // exactly when a support ability with an attack rider is being cast for
        // the support, or when the player is pointing away from the room. A
        // buff ignores the point either way: the game centres it on the
        // character whatever the client sent.
        //
        // Its own search, and asked once because this is the only line that
        // wants it: what is worth casting for above and what is worth pointing
        // at here are two orderings of the same room, and only a support
        // ability that both needed the room *and* carries an attack pays for
        // both — `pD Tome` and its handful of neighbours.
        const at: Position = aimed ? (targetEnemy(session) ?? self) : self;

        session.sendToServer('USEITEM', {
          // **The client's clock, not the one this plugin schedules against.**
          // The server checks this field against the time the game client has
          // been stamping its own packets with, and throws the packet away when
          // it does not match — no error, no effect, and the ability sound the
          // player hears is the client reacting to a use it never made. It cost
          // a session of a priest's tome firing every 700 ms and healing
          // nothing. `gameTimeMs` below is a different quantity for a different
          // job: a monotonic proxy-side clock to measure intervals with.
          time: Math.trunc(session.world.clientTimeMs),
          slotObject: {
            objectId: self.objectId,
            slotId: ABILITY_SLOT,
            objectType: slot.objectType,
          },
          itemUsePos: { x: at.x, y: at.y },
          useType: USE_TYPE_SELF,
          unknownInt: 0,
        });
        state.nextAtMs = nowMs + intervalOf(ability, aimed);
      });

      // `USEITEM` only ever flows from the client, and our own casts are
      // injected past the pipeline — so anything seen here is the player's own
      // key press.
      context.packets.on('USEITEM', (packet, session) => {
        if (packet.opaque) return;
        const objectType = abilityInUse(packet.get('slotObject'));
        if (objectType === undefined) return;

        const state = stateFor(session);
        state.nextAtMs = Math.max(state.nextAtMs, session.world.gameTimeMs + MANUAL_PAUSE_MS);

        if (!tuning.aimAttacks) return;
        // **Only what the game points at a place.** A buff is centred on the
        // character whatever this field says, so moving it would change
        // nothing; an ability that also *moves* the character reads it as the
        // place to move to, and pointing one of those at a monster is a
        // teleport into the monster. `Aimed` is exactly the set that is neither.
        const ability = inputs.ability(objectType);
        if (ability?.use !== AbilityUse.Aimed) return;

        const target = targetEnemy(session);
        if (target === undefined) return;
        packet.set('itemUsePos', { x: target.x, y: target.y });
      });

      context.packets.on('MAPINFO', (_packet, session) => {
        stateFor(session).nextAtMs = session.world.gameTimeMs + MAP_SETTLE_MS;
      });

      context.onDispose(
        context.sessions.onDisconnected((session) => {
          bySession.delete(session.id);
        }),
      );
      context.onDispose(() => {
        bySession.clear();
      });
    },
  });
}

/**
 * The item a `USEITEM` is using out of the ability slot, or `undefined` for a
 * packet that is using something else — a potion out of the belt, most often.
 *
 * Takes `unknown` rather than the decoded shape on purpose: a field is only a
 * record here because a schema said so, and a definition that has drifted from
 * the live game is exactly the case worth surviving.
 */
function abilityInUse(slotObject: unknown): number | undefined {
  if (typeof slotObject !== 'object' || slotObject === null || Array.isArray(slotObject)) {
    return undefined;
  }
  const fields = slotObject as Record<string, unknown>;
  if (fields['slotId'] !== ABILITY_SLOT) return undefined;
  const objectType = fields['objectType'];
  return typeof objectType === 'number' ? objectType : undefined;
}
