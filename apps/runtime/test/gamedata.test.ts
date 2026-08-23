import { describe, expect, it } from 'vitest';
import {
  GameObjectCatalog,
  GameTileCatalog,
  readObjectDefinitions,
  readTileDefinitions,
} from '../src/gamedata/GameCatalogs.js';
import { EquippedWeapon } from '../src/gamedata/EquippedWeapon.js';
import { reachTiles, type ProjectileDefinition } from '../src/gamedata/projectiles.js';
import { PotionKind } from '../src/gamedata/items.js';
import {
  GameDataError,
  attribute,
  childText,
  elementText,
  hasChild,
  parseGameNumber,
  scanElements,
} from '../src/gamedata/xml.js';
import { EMPTY_CATALOG } from '../src/state/ObjectCatalog.js';

/** Feeds a document to the scanner in chunks of a given size. */
function chunked(text: string, size = text.length): AsyncIterable<string> {
  return {
    // A hand-written async iterable rather than an async generator: there is
    // nothing to await here, and a generator that never awaits is a promise of
    // asynchrony the source does not have.
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let at = 0;
      return {
        next: (): Promise<IteratorResult<string>> => {
          if (at >= text.length) return Promise.resolve({ done: true, value: undefined });
          const value = text.slice(at, at + size);
          at += size;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

async function collect(text: string, tag: string, chunkSize?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const element of scanElements(chunked(text, chunkSize), tag)) out.push(element);
  return out;
}

const OBJECTS = `<?xml version="1.0" encoding="utf-8"?>
<Objects>
  <Object type="0x30e" id="Wizard">
    <Class>Player</Class>
    <Description>A wizard.</Description>
  </Object>
  <Object type="0x0d59" id="Oryx the Mad God 3">
    <Class>Character</Class>
    <Enemy />
    <MaxHitPoints>200000</MaxHitPoints>
  </Object>
  <Object type="0xc0ee" id="KSW Drone Spawner">
    <Class>Character</Class>
    <Enemy />
    <Invincible />
    <NoMiniMap />
  </Object>
  <Object type="0xc85" id="Common Feline Egg">
    <Class>Equipment</Class>
    <Item />
  </Object>
  <Object type="0x1234" id="Rock &amp; Roll" />
</Objects>`;

const TILES = `<?xml version="1.0" encoding="utf-8"?>
<GroundTypes>
  <Ground type="0x222f" id="Spider Dirt">
    <RandomTexture><Texture><File>x</File><Index>0x3c</Index></Texture></RandomTexture>
  </Ground>
  <Ground type="0x70" id="Lava">
    <MinDamage>10</MinDamage>
    <MaxDamage>20</MaxDamage>
    <Push />
  </Ground>
  <Ground type="0x71" id="Space">
    <NoWalk />
  </Ground>
</GroundTypes>`;

describe('scanElements', () => {
  it('yields each element, including a self-closing one', async () => {
    const elements = await collect(OBJECTS, 'Object');
    expect(elements).toHaveLength(5);
    expect(elements[4]).toBe('<Object type="0x1234" id="Rock &amp; Roll" />');
  });

  it('gives the same answer however the file is chunked', async () => {
    const whole = await collect(OBJECTS, 'Object');
    for (const size of [1, 3, 7, 64, 4096]) {
      expect(await collect(OBJECTS, 'Object', size), `chunks of ${String(size)}`).toEqual(whole);
    }
  });

  it('does not confuse a nested element for the one it is looking for', async () => {
    const elements = await collect(TILES, 'Ground');
    expect(elements).toHaveLength(3);
    expect(elements[0]).toContain('Spider Dirt');
    expect(elements[0]).toContain('</Ground>');
  });

  it('refuses a file that ends inside an element', async () => {
    await expect(collect('<Objects><Object type="1" id="x"><Class>', 'Object')).rejects.toThrow(
      GameDataError,
    );
  });

  it('finds nothing in a document that has none', async () => {
    expect(await collect('<Objects></Objects>', 'Object')).toEqual([]);
  });
});

describe('element readers', () => {
  const element = '<Object type="0x30e" id="Wizard"><Class>Player</Class><Item /></Object>';

  it('reads attributes and scalar children', () => {
    expect(attribute(element, 'type')).toBe('0x30e');
    expect(attribute(element, 'id')).toBe('Wizard');
    expect(attribute(element, 'missing')).toBeUndefined();
    expect(childText(element, 'Class')).toBe('Player');
    expect(childText(element, 'Nope')).toBeUndefined();
  });

  it('decodes the entities the file actually uses', () => {
    expect(attribute('<Object id="Rock &amp; Roll" />', 'id')).toBe('Rock & Roll');
    expect(childText('<D>a &lt; b</D>', 'D')).toBe('a < b');
  });

  it('tells a marker child from one that merely starts the same way', () => {
    expect(hasChild('<Object><Enemy /></Object>', 'Enemy')).toBe(true);
    expect(hasChild('<Object><EnemyOccupySquare /></Object>', 'Enemy')).toBe(false);
    expect(hasChild('<Object><Item /></Object>', 'Enemy')).toBe(false);
  });

  it('reads both the hexadecimal and decimal forms the file mixes', () => {
    expect(parseGameNumber('0x30e')).toBe(782);
    expect(parseGameNumber('0X30E')).toBe(782);
    expect(parseGameNumber('200000')).toBe(200000);
    expect(parseGameNumber('  42 ')).toBe(42);
    expect(parseGameNumber('')).toBeUndefined();
    expect(parseGameNumber(undefined)).toBeUndefined();
    expect(parseGameNumber('not a number')).toBeUndefined();
  });
});

describe('object catalog', () => {
  it('classifies players and enemies from what the game says, not from id ranges', async () => {
    const catalog = new GameObjectCatalog(await readObjectDefinitions(chunked(OBJECTS)));

    expect(catalog.size).toBe(5);
    expect(catalog.isPlayer(0x30e)).toBe(true);
    expect(catalog.isEnemy(0x30e)).toBe(false);
    expect(catalog.isEnemy(0x0d59)).toBe(true);
    expect(catalog.isPlayer(0x0d59)).toBe(false);
    expect(catalog.isPlayer(0xc85)).toBe(false);
    expect(catalog.isEnemy(0xc85)).toBe(false);
    expect(catalog.displayName(0x0d59)).toBe('Oryx the Mad God 3');
  });

  it('marks the enemies that can never be hurt', async () => {
    const catalog = new GameObjectCatalog(await readObjectDefinitions(chunked(OBJECTS)));

    // A spawner is an enemy by every test the wire offers — and shooting one
    // is a shot that does nothing for as long as the fight lasts.
    expect(catalog.isEnemy(0xc0ee)).toBe(true);
    expect(catalog.isInvincible(0xc0ee)).toBe(true);
    expect(catalog.isInvincible(0x0d59)).toBe(false);
  });

  // A breakable wall is an enemy with hit points *and* a wall, and the game
  // refuses to let a character into its square. Reading only the other two
  // markers left 2244 of the file's objects looking like open floor, so a plan
  // walked into one and the server put the character straight back.
  it('counts a destructible wall among the things that own their square', async () => {
    const catalog = new GameObjectCatalog(
      await readObjectDefinitions(
        chunked(`<Objects>
  <Object type="0x01" id="Wall"><OccupySquare /></Object>
  <Object type="0x02" id="Statue"><FullOccupy /></Object>
  <Object type="0x03" id="Breakable Pillar"><Enemy /><EnemyOccupySquare /></Object>
  <Object type="0x04" id="Grass" />
</Objects>`),
      ),
    );

    expect(catalog.occupies(0x01)).toBe(true);
    expect(catalog.occupies(0x02)).toBe(true);
    expect(catalog.occupies(0x03)).toBe(true);
    expect(catalog.occupies(0x04)).toBe(false);
  });

  it('says "no" about a type it has never heard of', async () => {
    const catalog = new GameObjectCatalog(await readObjectDefinitions(chunked(OBJECTS)));
    expect(catalog.isPlayer(0xffff)).toBe(false);
    expect(catalog.isEnemy(0xffff)).toBe(false);
    expect(catalog.isInvincible(0xffff)).toBe(false);
    expect(catalog.displayName(0xffff)).toBeUndefined();
  });

  // What the spacing band keeps its distance from. `<Size>` is a percentage of
  // the standard one-tile sprite, and a body four times the width has to be
  // kept four times as far off its middle to leave the same room.
  it('reads how big one is, and refuses a decorative one', async () => {
    const catalog = new GameObjectCatalog(
      await readObjectDefinitions(
        chunked(`<Objects>
          <Object type="0x1" id="ordinary"><Enemy /></Object>
          <Object type="0x2" id="boss"><Enemy /><Size>400</Size></Object>
          <Object type="0x3" id="varied"><Enemy /><MinSize>80</MinSize><MaxSize>160</MaxSize></Object>
          <Object type="0x4" id="backdrop"><Size>4000</Size></Object>
          <Object type="0x5" id="nonsense"><Size>not a number</Size></Object>
        </Objects>`),
      ),
    );

    // No statement means the size the game draws it at.
    expect(catalog.bodyTiles(0x1)).toBe(1);
    expect(catalog.bodyTiles(0x2)).toBe(4);
    // Randomised: the larger, because guessing small here means being stood on.
    expect(catalog.bodyTiles(0x3)).toBeCloseTo(1.6, 6);
    // A backdrop as a keep-away distance would push the planner off the screen.
    expect(catalog.bodyTiles(0x4)).toBe(6);
    expect(catalog.bodyTiles(0x5)).toBe(1);
    // Told apart from a type nobody has heard of, so a caller can fall back.
    expect(catalog.bodyTiles(0xffff)).toBeUndefined();
  });

  // What a lever is, and the game's own answer for it: a health bar, no attack,
  // and a death that goes on the structure counter rather than a monster one.
  it('tells the scenery from the monsters, and a dangerous structure from both', async () => {
    const catalog = new GameObjectCatalog(
      await readObjectDefinitions(
        chunked(`<Objects>
          <Object type="0x1" id="lever"><Enemy /><MaxHitPoints>5000</MaxHitPoints><KillStat stat="StructureKills" /></Object>
          <Object type="0x2" id="tower"><Enemy /><KillStat stat="StructureKills" /><Projectile id="0"><Speed>100</Speed></Projectile></Object>
          <Object type="0x3" id="monster"><Enemy /><KillStat stat="UndeadKills" /></Object>
          <Object type="0x4" id="uncounted"><Enemy /></Object>
        </Objects>`),
      ),
    );

    expect(catalog.isScenery(0x1)).toBe(true);
    // A structure is allowed to be a fight: a tower that shoots is one.
    expect(catalog.isScenery(0x2)).toBe(false);
    expect(catalog.isScenery(0x3)).toBe(false);
    // Most of the file counts no kill at all, and saying nothing is not a claim
    // to be scenery — the marker has to be there.
    expect(catalog.isScenery(0x4)).toBe(false);
    expect(catalog.isScenery(0xffff)).toBe(false);
  });

  it('skips a malformed entry instead of losing the catalog over it', async () => {
    const document = `<Objects>
      <Object id="no type"><Class>Player</Class></Object>
      <Object type="not a number" id="bad type" />
      <Object type="0x1" id="fine"><Enemy /></Object>
    </Objects>`;
    const catalog = new GameObjectCatalog(await readObjectDefinitions(chunked(document)));

    expect(catalog.size).toBe(1);
    expect(catalog.isEnemy(1)).toBe(true);
  });
});

describe('tile catalog', () => {
  it('reads damage and walkability', async () => {
    const catalog = new GameTileCatalog(await readTileDefinitions(chunked(TILES)));

    expect(catalog.size).toBe(3);
    expect(catalog.isDamaging(0x70)).toBe(true);
    expect(catalog.isBlocking(0x70)).toBe(false);
    expect(catalog.isBlocking(0x71)).toBe(true);
    expect(catalog.isDamaging(0x222f)).toBe(false);
    expect(catalog.get(0x70)?.id).toBe('Lava');
  });

  it('reads the push marker, which is what makes a conveyor a conveyor', async () => {
    const catalog = new GameTileCatalog(await readTileDefinitions(chunked(TILES)));

    expect(catalog.isPushing(0x70)).toBe(true);
    expect(catalog.isPushing(0x222f)).toBe(false);
  });

  it('answers "no" for an unknown tile, which is the safe direction', async () => {
    const catalog = new GameTileCatalog(await readTileDefinitions(chunked(TILES)));
    // A feature that avoids damaging tiles avoids none, rather than the wrong ones.
    expect(catalog.isDamaging(0xdead)).toBe(false);
    expect(catalog.isBlocking(0xdead)).toBe(false);
    expect(catalog.isPushing(0xdead)).toBe(false);
  });

  it('treats damage on either bound as damaging', async () => {
    const document = `<GroundTypes>
      <Ground type="1" id="min only"><MinDamage>5</MinDamage></Ground>
      <Ground type="2" id="max only"><MaxDamage>5</MaxDamage></Ground>
      <Ground type="3" id="zero"><MinDamage>0</MinDamage><MaxDamage>0</MaxDamage></Ground>
    </GroundTypes>`;
    const catalog = new GameTileCatalog(await readTileDefinitions(chunked(document)));

    expect(catalog.isDamaging(1)).toBe(true);
    expect(catalog.isDamaging(2)).toBe(true);
    expect(catalog.isDamaging(3)).toBe(false);
  });
});

describe('projectiles', () => {
  const SHOOTER = `<Object type="0x1" id="Shooter">
    <Enemy />
    <Projectile id="0">
      <Speed>100</Speed>
      <LifetimeMS>1000</LifetimeMS>
      <Damage>60</Damage>
      <Acceleration>80</Acceleration>
    </Projectile>
    <Projectile id="1">
      <Speed>50</Speed>
      <LifetimeMS>2000</LifetimeMS>
      <Damage>30</Damage>
      <Wavy />
    </Projectile>
  </Object>`;

  it('reads every shot an object declares, by the index the game names it with', async () => {
    const catalog = new GameObjectCatalog(
      await readObjectDefinitions(chunked(`<Objects>${SHOOTER}</Objects>`)),
    );

    expect(catalog.projectile(1, 0)?.speed).toBe(100);
    expect(catalog.projectile(1, 0)?.damage).toBe(60);
    expect(catalog.projectile(1, 1)?.wavy).toBe(true);
    expect(catalog.projectile(1, 1)?.lifetimeMs).toBe(2000);
    expect(catalog.projectile(1, 2)).toBeUndefined();
    expect(catalog.projectile(99, 0)).toBeUndefined();
  });

  it('keeps acceleration even though the motion model does not apply it', async () => {
    const catalog = new GameObjectCatalog(
      await readObjectDefinitions(chunked(`<Objects>${SHOOTER}</Objects>`)),
    );
    // Parsed so the model can learn about it without a data change; stated in
    // `positionAt` so nothing treats an accelerating shot's path as exact.
    expect(catalog.projectile(1, 0)?.acceleration).toBe(80);
  });
});

describe('how far a shot gets', () => {
  // The game's own encoding: speed is ten-thousandths of a tile a millisecond,
  // so a bow at 160 for 440 ms reaches just over seven tiles — which is what
  // the item does in the game.
  const BOW = `<Object type="0xb06" id="Bow of Covert Havens">
    <Projectile id="0"><Speed>160</Speed><LifetimeMS>440</LifetimeMS></Projectile>
  </Object>`;
  // A fixed-arc weapon: no speed at all, and the arc is the reach.
  const SWORD = `<Object type="0xb0b" id="Sword of Acclaim">
    <Projectile id="0"><Parametric /><Magnitude>3.5</Magnitude><LifetimeMS>350</LifetimeMS></Projectile>
  </Object>`;

  async function catalogOf(...objects: string[]): Promise<GameObjectCatalog> {
    return new GameObjectCatalog(
      await readObjectDefinitions(chunked(`<Objects>${objects.join('')}</Objects>`)),
    );
  }

  it('is speed times life for an ordinary shot', async () => {
    const catalog = await catalogOf(BOW);
    const definition = catalog.projectile(0xb06, 0);
    expect(definition).toBeDefined();
    expect(reachTiles(definition as ProjectileDefinition)).toBeCloseTo(7.04, 6);
  });

  // Reading a parametric weapon as speed × life gives nought, which would read
  // as "this weapon has no range" for every sword and dagger in the game.
  it('is the magnitude for a fixed-arc weapon', async () => {
    const catalog = await catalogOf(SWORD);
    const definition = catalog.projectile(0xb0b, 0);
    expect(definition).toBeDefined();
    expect(reachTiles(definition as ProjectileDefinition)).toBeCloseTo(3.5, 6);
  });

  describe('resolved once per weapon', () => {
    it('names the item and works out its reach', async () => {
      const catalog = await catalogOf(BOW);
      const shot = new EquippedWeapon(() => catalog).of(0xb06);

      expect(shot?.name).toBe('Bow of Covert Havens');
      expect(shot?.speedTilesPerMs).toBeCloseTo(0.016, 9);
      expect(shot?.lifetimeMs).toBe(440);
      expect(shot?.reachTiles).toBeCloseTo(7.04, 6);
    });

    it('answers the second time without reading the catalog again', async () => {
      const catalog = await catalogOf(BOW);
      let reads = 0;
      const weapon = new EquippedWeapon(() => {
        reads += 1;
        return catalog;
      });

      const first = weapon.of(0xb06);
      expect(weapon.of(0xb06)).toBe(first);
      expect(reads).toBe(1);
    });

    // The catalogs are read from disk while the proxy is already serving, so a
    // miss during the first seconds of a session means "not yet".
    it('does not remember that it did not know', async () => {
      const catalog = await catalogOf(BOW);
      let loaded = false;
      const weapon = new EquippedWeapon(() => (loaded ? catalog : EMPTY_CATALOG));

      expect(weapon.of(0xb06)).toBeUndefined();
      loaded = true;
      expect(weapon.of(0xb06)?.name).toBe('Bow of Covert Havens');
    });

    it('has nothing to say about an empty hand', async () => {
      const catalog = await catalogOf(BOW);
      expect(new EquippedWeapon(() => catalog).of(-1)).toBeUndefined();
    });
  });
});

/**
 * The item, container and class facts the two item features read.
 *
 * Every fixture below is copied verbatim out of the shipped `objects.xml`,
 * trimmed of the parts nothing here reads. The point is to prove the readers
 * against the document's real shape rather than against a shape invented to
 * suit them — the reference implementation's item classifier was written
 * against an older extraction and misread this one.
 */
describe('what the catalog says about items', () => {
  const HEALTH_POTION = `<Object type="0xa22" id="Health Potion">
    <Class>Equipment</Class>
    <Item />
    <SlotType>10</SlotType>
    <Tier>1</Tier>
    <Activate amount="100">Heal</Activate>
    <Consumable />
    <Potion />
    <QuickslotAllowed maxstack="6" />
    <Labels>EQUIPMENT,CONSUMABLE,TIERED,LOOTABLE,T1,TRADEABLE</Labels>
  </Object>`;

  const ATTACK_POTION = `<Object type="0xa1f" id="Potion of Attack">
    <Class>Equipment</Class>
    <Item />
    <SlotType>10</SlotType>
    <Tier>2</Tier>
    <Activate stat="ATT" amount="1">IncrementStat</Activate>
    <Consumable />
    <Potion />
    <Labels>EQUIPMENT,CONSUMABLE,STATPOTION</Labels>
  </Object>`;

  const LIFE_POTION = `<Object type="0xae9" id="Potion of Life">
    <Class>Equipment</Class>
    <Item />
    <Tier>4</Tier>
    <SlotType>10</SlotType>
    <Activate stat="MAXHP" amount="5">IncrementStat</Activate>
    <Consumable />
    <Potion />
    <Labels>EQUIPMENT,CONSUMABLE,STATPOTION</Labels>
  </Object>`;

  const XP_POTION = `<Object type="0xb28" id="XP Booster">
    <Class>Equipment</Class>
    <Item />
    <SlotType>10</SlotType>
    <Activate stat="XP" amount="1">IncrementStat</Activate>
    <Consumable />
    <Potion />
  </Object>`;

  // Activates `Heal` and is not a potion: a tome is the reason the marker is
  // read rather than the effect alone.
  const HEALING_TOME = `<Object type="0xa5c" id="Tome of Purification">
    <Class>Equipment</Class>
    <Item />
    <SlotType>4</SlotType>
    <Tier>3</Tier>
    <Activate>Heal</Activate>
    <Labels>EQUIPMENT,ABILITY,TIERED</Labels>
  </Object>`;

  const TIERED_BOW = `<Object type="0xb02" id="Bow of Covert Havens">
    <Class>Equipment</Class>
    <Item />
    <SlotType>3</SlotType>
    <Tier>12</Tier>
    <Labels>EQUIPMENT,WEAPON,BOW,TIERED,LOOTABLE,T12,T12_WEAPON</Labels>
  </Object>`;

  const UNTIERED_BOW = `<Object type="0x2301" id="Bow of the Morning Star">
    <Class>Equipment</Class>
    <Item />
    <SlotType>3</SlotType>
    <Labels>EQUIPMENT,WEAPON,BOW,UT,TAB_UT,POWERTIER_B,TRADEABLE</Labels>
  </Object>`;

  const SET_ABILITY = `<Object type="0x2f4a" id="Toxin Sting">
    <Class>Equipment</Class>
    <Item />
    <SlotType>11</SlotType>
    <Labels>EQUIPMENT,ABILITY,POISON,ST,TAB_ST,ST_ABILITY,STGEN_2</Labels>
  </Object>`;

  const SHARED_BAG = `<Object type="0x0500" id="Loot Bag 0">
    <Class>Container</Class>
    <Container />
    <CanPutNormalObjects />
    <Loot />
    <Size>80</Size>
    <SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes>
  </Object>`;

  const SOULBOUND_BAG = `<Object type="0x0503" id="Soulbound Loot Bag">
    <Class>Container</Class>
    <Container />
    <CanPutSoulboundObjects />
    <Loot />
    <Size>80</Size>
    <SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes>
  </Object>`;

  const VAULT_CHEST = `<Object type="0x0504" id="Vault Chest">
    <Class>VaultContainer</Class>
    <Container />
    <CanPutNormalObjects />
    <SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes>
  </Object>`;

  const WIZARD = `<Object type="0x030e" id="Wizard">
    <Class>Player</Class>
    <Player />
    <MaxHitPoints max="700">100</MaxHitPoints>
    <MaxMagicPoints max="400">150</MaxMagicPoints>
    <Attack max="60">23</Attack>
    <Defense max="25">0</Defense>
    <Speed max="50">17</Speed>
    <Dexterity max="75">17</Dexterity>
    <HpRegen max="40">5</HpRegen>
    <MpRegen max="60">23</MpRegen>
  </Object>`;

  const EVERYTHING = [
    HEALTH_POTION,
    ATTACK_POTION,
    LIFE_POTION,
    XP_POTION,
    HEALING_TOME,
    TIERED_BOW,
    UNTIERED_BOW,
    SET_ABILITY,
    SHARED_BAG,
    SOULBOUND_BAG,
    VAULT_CHEST,
    WIZARD,
  ];

  async function catalog(): Promise<GameObjectCatalog> {
    return new GameObjectCatalog(
      await readObjectDefinitions(chunked(`<Objects>${EVERYTHING.join('')}</Objects>`)),
    );
  }

  it('reads a text and an attribute off the same element', () => {
    expect(elementText('<Activate stat="ATT" amount="1">IncrementStat</Activate>')).toBe(
      'IncrementStat',
    );
    expect(elementText('<Potion />')).toBeUndefined();
  });

  it('names what each potion does, and which stat it raises', async () => {
    const objects = await catalog();
    expect(objects.item(0xa22)?.potion).toEqual({ kind: PotionKind.Heal, raises: undefined });
    expect(objects.item(0xa1f)?.potion).toEqual({
      kind: PotionKind.Permanent,
      raises: 'attack',
    });
    expect(objects.item(0xae9)?.potion).toEqual({
      kind: PotionKind.LifeOrMana,
      raises: undefined,
    });
  });

  it('does not call an experience booster a stat potion', async () => {
    // `XP` arrives through the same effect as the six and is not one of them.
    expect((await catalog()).item(0xb28)?.potion).toBeUndefined();
  });

  it('does not mistake a healing ability for a potion', async () => {
    const tome = (await catalog()).item(0xa5c);
    expect(tome).toBeDefined();
    expect(tome?.potion).toBeUndefined();
  });

  it('reads the tier, and the untiered and set markers, from the labels', async () => {
    const objects = await catalog();
    expect(objects.item(0xb02)).toMatchObject({ slotType: 3, tier: 12, untiered: false });
    expect(objects.item(0x2301)).toMatchObject({ slotType: 3, tier: undefined, untiered: true });
    expect(objects.item(0x2f4a)).toMatchObject({ setItem: true, untiered: false });
  });

  it('reads how many of an item the potion belt will hold', async () => {
    const objects = await catalog();
    expect(objects.item(0xa22)?.beltStack).toBe(6);
    // Everything the belt refuses says so by carrying no marker at all.
    expect(objects.item(0xa1f)?.beltStack).toBe(0);
    expect(objects.item(0xb02)?.beltStack).toBe(0);
  });

  it('says nothing about an object that is not an item', async () => {
    const objects = await catalog();
    expect(objects.item(0x0500)).toBeUndefined();
    expect(objects.item(0x030e)).toBeUndefined();
  });

  it('counts a container"s slots and knows who may take from it', async () => {
    const objects = await catalog();
    expect(objects.container(0x0500)).toEqual({ slots: 8, shared: true });
    expect(objects.container(0x0503)).toEqual({ slots: 8, shared: false });
  });

  it('leaves the vault chest out, because the file classes it apart', async () => {
    // Anything looting containers would otherwise empty the vault.
    expect((await catalog()).container(0x0504)).toBeUndefined();
  });

  it('reads a class"s stat ceilings, mapping vitality and wisdom to the regens', async () => {
    expect((await catalog()).statMaxima(0x030e)).toEqual({
      attack: 60,
      defense: 25,
      speed: 50,
      dexterity: 75,
      vitality: 40,
      wisdom: 60,
    });
  });

  it('has no ceilings for anything that is not a playable class', async () => {
    expect((await catalog()).statMaxima(0xb02)).toBeUndefined();
  });

  it('answers nothing for everything before a data file is read', () => {
    expect(EMPTY_CATALOG.item(0xa22)).toBeUndefined();
    expect(EMPTY_CATALOG.container(0x0500)).toBeUndefined();
    expect(EMPTY_CATALOG.statMaxima(0x030e)).toBeUndefined();
  });
});
