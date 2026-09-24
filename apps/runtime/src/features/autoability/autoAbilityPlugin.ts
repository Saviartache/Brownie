/**
 * Auto-ability: casts the support half of the ability slot, points the other
 * half at an enemy instead of at the mouse, and — where the player asked for
 * it — fires that half at a boss.
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
 * **An attack ability is cast at a boss, and at nothing else, and only because
 * the player switched that on.** A quiver, a spell, a trap and a scepter give
 * nothing this build can name, so there is no bar to read and no buff to renew
 * — no moment that makes one worth firing on this plugin's own judgement. The
 * one decision a player can hand over whole is "a boss is in range", because a
 * boss is what the mana is unambiguously for; that is the switch, off until
 * they say otherwise. With it off — or with no boss in range — the ability
 * waits for the key press, and all this does with it is point it: the client is
 * handed the enemy in place of the cursor, so the ability lands on the enemy
 * rather than wherever the mouse happened to be. When to spend the mana on
 * everything else stays the player's decision; the only thing taken off them is
 * the aiming.
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
 * **It sends nothing to the server. The game client presses the key.** Both
 * halves go through the native module to the client's own ability code — the
 * method the key calls with the cursor — so a cast is the client using its
 * ability at a point this plugin chose, and a pointed press is the client using
 * it at the enemy instead of the mouse. Everything the server hears is what the
 * client builds from that: its own checks first (silenced, paralysed, on
 * cooldown, out of mana), its own `USEITEM`, the shots an item with projectiles
 * fires behind it, and the cooldown and mana it then charges itself.
 *
 * **That is a correction, and a costly one to have needed.** This used to
 * write the `USEITEM` itself and rewrite the player's. The client knew nothing
 * of a use it had not made, so it sent its own a moment later on the player's
 * press while the server still had the first on cooldown; a use of a quiver or
 * a spell arrived with no shots behind it, a rewritten one with its shots
 * flying at the mouse; and a use went out while the client would have refused
 * it. None of that is a thing the real client sends — and with this plugin on,
 * sessions ended. A press made through the client cannot be any of those.
 *
 * **So this plugin sees its own casts**, as the client's `USEITEM` coming past
 * like any other — which is how it learns a cast happened at all, and when:
 * the interval starts there. A use of the ability slot shortly after one was
 * asked for is that one; any other is the player's own key.
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
  type SelfView,
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

/**
 * The native module's two ways into the client's ability key — the one thing
 * here a plugin cannot do alone, handed over by the composition root.
 *
 * Both name a place on the map, and both leave the rest to the client: it
 * makes whatever checks it makes, sends its own `USEITEM`, and fires whatever
 * shots the item fires, from that place. Neither is ever answered: a cast is
 * seen happening in the client's own `USEITEM`, and a pointing in nothing at
 * all until the player presses the key.
 */
export interface AbilityOutput {
  /**
   * Presses the ability key once, pointed here, as the key would with the
   * cursor on this spot.
   *
   * `holdMs` is how long the module may wait for a frame that can make the
   * press. A press it could not make in that time is dropped rather than made
   * late: what it was aimed at has moved.
   */
  cast(at: Position, holdMs: number): void;
  /**
   * Points the presses the player makes here instead of at the mouse, until
   * `holdMs` runs out.
   *
   * A *standing* target, like auto-aim's: saying nothing is how the runtime
   * says the cursor is theirs again, so there is no cancel.
   */
  aimAt(at: Position, holdMs: number): void;
}

export interface AutoAbilityInputs {
  readonly output: AbilityOutput;
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
 * How long the module may wait to make a press before dropping it.
 *
 * A frame is a few milliseconds away, so this only bites while the game cannot
 * find the player — a map loading, a stall — and a mana-priced heal made at
 * the end of one would be made at where the fight used to be. A dropped press
 * goes unanswered, and is asked for again on the room as it stands then.
 */
const CAST_HOLD_MS = 250;

/**
 * How long after asking a use of the ability slot is the press that was asked
 * for, rather than the player's own.
 *
 * The client makes it on the next frame and the proxy sees it a moment later,
 * so anything in this window is the answer; anything after it is a key press.
 * The rare press of the player's that lands inside is read as the plugin's own,
 * which costs nothing but the interval it starts.
 */
const CAST_ANSWER_MS = 500;

/**
 * How long to wait before asking again when the client made nothing, doubling
 * with each press in a row that went unanswered, up to the ceiling.
 *
 * **Unanswered is the client's decision more often than not** — silenced, on a
 * cooldown this side does not see, somewhere abilities are not allowed — and it
 * says so on screen every time it is asked. Asking at the tick rate would put
 * that notice up five times a second; backing off keeps a refusal that lasts
 * from becoming a stream of them. The same wait covers a module that is not
 * there to ask at all.
 */
const CAST_RETRY_MS = 1000;
const CAST_RETRY_MAX_MS = 8000;

/**
 * How long a pointing stands, which is two server ticks.
 *
 * Renewed on every tick while there is an enemy to point at, so this is only
 * how long the player's presses keep going to the last one after the room says
 * nothing — a tick that arrived late, or an enemy that died.
 */
const AIM_HOLD_MS = 400;

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

/** Section headings on the tab, in the order the settings below declare them. */
const ATTACKS_GROUP = 'Attack abilities';
const SUPPORT_GROUP = 'Support abilities';
const TARGETING_GROUP = 'Targeting';
const LIMITS_GROUP = 'Limits';

/**
 * Every setting, folded into one record when one of them moves.
 *
 * Read rather than looked up, which is the same reason Oryx's Sanctuary folds
 * its switches: a handle's `get` is a map lookup, there are a dozen of them on
 * this path, and none of the answers changed between one server tick and the
 * next. It extends {@link CastPreferences} so the three the decision wants can
 * be handed straight to it instead of built into a fresh object per tick.
 */
interface Tuning extends CastPreferences {
  /** Point an attack ability the player fires, rather than leave it on the mouse. */
  readonly aimAttacks: boolean;
  /** Fire an attack ability at a boss without waiting for the key press. */
  readonly autoCastAttacks: boolean;
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
  /**
   * Until when a use of the ability slot is the press last asked for. Minus
   * infinity while nothing is outstanding.
   */
  askedUntilMs: number;
  /** The interval that press starts once the client makes it. */
  askedIntervalMs: number;
  /** Presses asked for in a row that the client did not make. */
  unanswered: number;
  mapName: string;
  safeZone: boolean;
}

export function createAutoAbilityPlugin(inputs: AutoAbilityInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-ability',
      name: 'Auto Ability',
      category: PluginCategory.Combat,
      description:
        'Casts support abilities when they are worth it, aims the attacks you fire, and can fire those at a boss for you.',
    },

    setup(context) {
      // The two halves of the feature, and they are not the same offer: one
      // decides when to spend the mana, the other only decides where what the
      // player already spent lands. The third is the one decision the player
      // can hand over whole — spend it on the boss, now, without me.
      const aimAttacks = context.settings.boolean('aimAttacks', {
        label: 'Aim the attack abilities you use — quivers, spells, traps, scepters',
        default: true,
        group: ATTACKS_GROUP,
      });
      const autoCastAttacks = context.settings.boolean('autoCastAttacks', {
        label: 'Auto-cast attack abilities at bosses — never at anything else',
        default: false,
        group: ATTACKS_GROUP,
      });
      const castSupport = context.settings.boolean('castSelf', {
        label: 'Use support abilities — heals, buffs, auras, cleanses',
        default: true,
        group: SUPPORT_GROUP,
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
        group: SUPPORT_GROUP,
      });
      const utilityOutOfCombat = context.settings.boolean('utilityOutOfCombat', {
        label: 'Keep speed and stealth up outside combat',
        default: false,
        group: SUPPORT_GROUP,
      });
      // Mana abilities are the rare item — a handful of tomes — and the
      // threshold is settled once and left alone, so it is out of the everyday
      // half of the tab rather than in the way of the health bar next to it.
      const manaPercent = context.settings.range('manaPercent', {
        label: 'Cast mana abilities at or below (% mana)',
        default: 50,
        min: 10,
        max: 100,
        step: 5,
        group: SUPPORT_GROUP,
        advanced: true,
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
        group: TARGETING_GROUP,
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
        group: TARGETING_GROUP,
      });
      // **A tier over the priority above, not another entry in it.** The two
      // answer different questions — which class of enemy is worth the mana,
      // and which one out of that class — and the rule holds for everything
      // this plugin looks for an enemy for: where the ability the player fires
      // lands, and whether a combat aura is worth putting up at all. Somebody
      // who set "only bosses" and then watched their seal go up for two bats is
      // owed the reading of the words. The auto-cast above is bosses by
      // definition and does not read this one.
      const bosses = context.settings.select<BossRule>('bosses', {
        label: 'Bosses',
        default: BossRule.Any,
        group: TARGETING_GROUP,
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
        group: TARGETING_GROUP,
      });
      // The two limits that hold every cast back whatever half made it, and
      // neither is an everyday knob: the reserve is set once around a class's
      // mana pool, and the interval is a floor under pacing the data file
      // already does — what an ability costs and how long it lasts.
      const mpReservePercent = context.settings.range('mpReservePercent', {
        label: 'Keep at least (% mana)',
        default: 0,
        min: 0,
        max: 90,
        step: 5,
        group: LIMITS_GROUP,
        advanced: true,
      });
      const minIntervalMs = context.settings.number('minIntervalMs', {
        label: 'Wait between casts (ms)',
        advanced: true,
        default: 700,
        min: 250,
        max: 5000,
        step: 50,
        group: LIMITS_GROUP,
      });

      const isBoss = (enemy: EntityView): boolean => inputs.isBoss(enemy.objectType);

      const readTuning = (): Tuning => ({
        aimAttacks: aimAttacks.get(),
        autoCastAttacks: autoCastAttacks.get(),
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
        autoCastAttacks,
        castSupport,
        healthPercent,
        utilityOutOfCombat,
        manaPercent,
        rangeTiles,
        priority,
        cursorRadius,
        bosses,
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
            askedUntilMs: Number.NEGATIVE_INFINITY,
            askedIntervalMs: 0,
            unanswered: 0,
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
       * The cursor is read here rather than passed in, so only a search that
       * ranks by it pays for the reading.
       *
       * `preference` defaults to the panel's boss rule, because every search
       * shares it but one: the attack half, whose rule is bosses by definition.
       */
      const search = (
        session: SessionView,
        priority: TargetPriority,
        preference: BossPreference = tuning.bosses,
      ): EntityView | undefined =>
        selectTarget(session.world.enemies(), {
          shooterX: session.self.x,
          shooterY: session.self.y,
          maxRangeTiles: tuning.rangeTiles,
          priority,
          cursorPoint:
            priority === TargetPriority.ClosestToCursor ? inputs.cursorPoint() : undefined,
          cursorRadiusTiles: tuning.cursorRadiusTiles,
          bosses: preference,
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

      /**
       * Asks the client to press the ability key, pointed at `at`.
       *
       * **The interval starts when the client makes the press, not here** —
       * see the `USEITEM` listener below. Until then this holds the next ask
       * back by the retry wait, so a press the client turned down, or one
       * nobody was there to make, is asked for again later rather than on the
       * very next tick. One press outstanding, ever.
       */
      const askToCast = (
        session: SessionView,
        at: Position,
        ability: AbilityFacts,
        aimed: boolean,
        state: SessionState,
      ): void => {
        const nowMs = session.world.gameTimeMs;
        if (state.unanswered > 0) {
          context.log.debug(
            `the client made none of the last ${String(state.unanswered)} casts asked of it — ` +
              'it refused them, or the native module is not there to ask',
          );
        }
        inputs.output.cast(at, CAST_HOLD_MS);
        state.askedUntilMs = nowMs + CAST_ANSWER_MS;
        state.askedIntervalMs = intervalOf(ability, aimed);
        state.nextAtMs = nowMs + Math.min(CAST_RETRY_MS * 2 ** state.unanswered, CAST_RETRY_MAX_MS);
        state.unanswered += 1;
      };

      /**
       * The support half: cast only when what the ability gives is worth
       * having right now.
       *
       * Everything both halves share — the gates, the cost, the reserve — is
       * settled before this is reached, so all that is left is the question
       * this half exists to ask.
       */
      const castIfWorthHaving = (
        session: SessionView,
        self: SelfView,
        ability: AbilityFacts,
        state: SessionState,
        pointed: EntityView | undefined,
      ): void => {
        if (!tuning.support) return;

        // Whether it is also pointed at something, which a tome can be.
        const aimed = ability.use === AbilityUse.Aimed;

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
        // character whatever the client was handed.
        //
        // The enemy the player's own presses are going to this tick, where
        // that was looked for — the same search, so asking it twice would be a
        // second pass over the room for the same answer. Searched here only
        // when pointing is switched off. What is worth casting for above and
        // what is worth pointing at here are two orderings of the same room,
        // and only a support ability that both needed the room *and* carries
        // an attack pays for both — `pD Tome` and its handful of neighbours.
        const at: Position = aimed
          ? (pointed ?? (tuning.aimAttacks ? undefined : targetEnemy(session)) ?? self)
          : self;

        askToCast(session, at, ability, aimed, state);
      };

      /**
       * The attack half: fire at a boss, and only at a boss, and only when the
       * player switched that on.
       *
       * **The boss rule here is not the setting — it is the feature.** The
       * `Bosses` choice on the tab says what the *aiming* prefers; this half
       * has no preference to state, because "attack abilities fire at bosses"
       * is the whole of what was asked for, and a minion nearer than the boss
       * is the exact thing it exists to ignore. The priority still decides
       * among bosses, out of the same setting the aimed half reads, so "aim at"
       * keeps one meaning wherever it appears.
       *
       * **And a hybrid never comes here.** A tome that heals and shoots has
       * benefits, so it took the support branch, and the shot on it is still a
       * rider: casting one at full health because a boss walked in is the
       * 700 ms spam the split exists to prevent.
       */
      const castIfBossInReach = (
        session: SessionView,
        ability: AbilityFacts,
        state: SessionState,
      ): void => {
        if (!tuning.autoCastAttacks) return;
        const boss = search(session, tuning.priority, { rule: BossRule.Only, isBoss });
        if (boss === undefined) return;
        askToCast(session, boss, ability, true, state);
      };

      // Cheapest test first, and each one is a test the next would have been
      // wasted work without. Nothing on this path allocates until a cast is
      // actually asked for, bar the reading below under the one priority that
      // asks for it.
      context.packets.on('NEWTICK', (_packet, session) => {
        // **Asked for and thrown away, ahead of every reason to stop below.**
        // The module measures the cursor only while somebody keeps asking, and
        // a pointing chosen by it has to be current when the player presses
        // the key. Waiting to ask until a search needs one would mean the first
        // search after a quiet spell got no reading.
        if (tuning.priority === TargetPriority.ClosestToCursor) inputs.cursorPoint();

        const self = session.self;
        if (!self.alive) return;

        const state = stateFor(session);
        if (state.safeZone) return;

        const slot = self.inventory.at(ABILITY_SLOT);
        if (slot === undefined || slot.objectType <= 0) return;

        const ability = inputs.ability(slot.objectType);
        if (ability === undefined || ability.use === AbilityUse.Never) return;

        // **The player's own presses, pointed on every tick and ahead of every
        // reason not to cast.** Whether this plugin spends mana has nothing to
        // do with where the player's spending lands, and the pointing has to be
        // standing *before* the key goes down — the press never comes past
        // here, it goes straight into the client's own ability code.
        //
        // **Only what the game points at a place.** A buff is centred on the
        // character whatever the client is handed, so pointing one changes
        // nothing; an ability that also *moves* the character reads the point
        // as the place to move to, and pointing one of those at a monster is a
        // teleport into the monster. `Aimed` is exactly the set that is
        // neither.
        let pointed: EntityView | undefined;
        if (tuning.aimAttacks && ability.use === AbilityUse.Aimed) {
          pointed = targetEnemy(session);
          if (pointed !== undefined) inputs.output.aimAt(pointed, AIM_HOLD_MS);
        }

        const nowMs = session.world.gameTimeMs;
        if (nowMs < state.nextAtMs) return;

        // The cost first, then the reserve on top of it: a cast that leaves the
        // bar under what the player asked to keep is one they did not want, and
        // one the client would refuse for want of mana is a notice on their
        // screen for nothing. An unstated maximum reserves nothing rather than
        // everything.
        const reserve = self.maxMp > 0 ? self.maxMp * tuning.manaReserve : 0;
        if (self.mp < ability.mpCost + reserve) return;

        // **The slot holds one item, and an item is one of two halves.** What
        // it gives the character is the support half, aimed or not; what it
        // does to an enemy and gives nothing back is the attack half. The two
        // are decided by different questions — "is any of this worth having"
        // against "is there a boss to spend it on" — so they part here and
        // share everything above it.
        if (ability.benefits.length > 0) {
          castIfWorthHaving(session, self, ability, state, pointed);
          return;
        }
        if (ability.use === AbilityUse.Aimed) {
          castIfBossInReach(session, ability, state);
        }
      });

      // Every use of the ability slot comes past here — the player's and the
      // ones this plugin asked for alike, since both are the client's own.
      // Which it is decides what it holds the next cast back by.
      context.packets.on('USEITEM', (packet, session) => {
        if (packet.opaque) return;
        if (!usesAbilitySlot(packet.get('slotObject'))) return;

        const state = stateFor(session);
        const nowMs = session.world.gameTimeMs;
        if (nowMs <= state.askedUntilMs) {
          // The press asked for, made. **The interval starts here** — measured
          // from the asking it would be a cooldown against a moment the server
          // never saw.
          state.askedUntilMs = Number.NEGATIVE_INFINITY;
          state.unanswered = 0;
          state.nextAtMs = nowMs + state.askedIntervalMs;
          return;
        }
        state.nextAtMs = Math.max(state.nextAtMs, nowMs + MANUAL_PAUSE_MS);
      });

      context.packets.on('MAPINFO', (_packet, session) => {
        const state = stateFor(session);
        state.nextAtMs = session.world.gameTimeMs + MAP_SETTLE_MS;
        // A press asked for on the last map is not one this map answers, and
        // whatever refused the last ones may not be here.
        state.askedUntilMs = Number.NEGATIVE_INFINITY;
        state.unanswered = 0;
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
 * Whether a `USEITEM` is using the ability slot, rather than something else — a
 * potion out of the belt, most often.
 *
 * Takes `unknown` rather than the decoded shape on purpose: a field is only a
 * record here because a schema said so, and a definition that has drifted from
 * the live game is exactly the case worth surviving.
 */
function usesAbilitySlot(slotObject: unknown): boolean {
  if (typeof slotObject !== 'object' || slotObject === null || Array.isArray(slotObject)) {
    return false;
  }
  return (slotObject as Record<string, unknown>)['slotId'] === ABILITY_SLOT;
}
