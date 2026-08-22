import { describe, expect, it } from 'vitest';
import {
  GameObjectCatalog,
  GameTileCatalog,
  readObjectDefinitions,
  readTileDefinitions,
} from '../src/gamedata/GameCatalogs.js';
import {
  GameDataError,
  attribute,
  childText,
  hasChild,
  parseGameNumber,
  scanElements,
} from '../src/gamedata/xml.js';

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

  it('says "no" about a type it has never heard of', async () => {
    const catalog = new GameObjectCatalog(await readObjectDefinitions(chunked(OBJECTS)));
    expect(catalog.isPlayer(0xffff)).toBe(false);
    expect(catalog.isEnemy(0xffff)).toBe(false);
    expect(catalog.isInvincible(0xffff)).toBe(false);
    expect(catalog.displayName(0xffff)).toBeUndefined();
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

  it('answers "no" for an unknown tile, which is the safe direction', async () => {
    const catalog = new GameTileCatalog(await readTileDefinitions(chunked(TILES)));
    // A feature that avoids damaging tiles avoids none, rather than the wrong ones.
    expect(catalog.isDamaging(0xdead)).toBe(false);
    expect(catalog.isBlocking(0xdead)).toBe(false);
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
