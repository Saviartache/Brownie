import { childText, hasChild, parseGameNumber } from './xml.js';

/** One client-renderable character skin offered to a player. */
export interface PlayerSkin {
  readonly type: number;
  readonly name: string;
}

/** The catalog entry, including the class compatibility used to index it. */
export interface SkinDefinition extends PlayerSkin {
  readonly playerClassType: number;
}

export interface CosmeticCatalog {
  skinsForClass(objectType: number): readonly PlayerSkin[];
  mainAppearances(): readonly AppearanceChoice[];
  accessoryAppearances(): readonly AppearanceChoice[];
  arcaneStyles(): readonly string[];
}

export const EMPTY_COSMETIC_CATALOG: CosmeticCatalog = {
  skinsForClass: () => [],
  mainAppearances: () => [],
  accessoryAppearances: () => [],
  arcaneStyles: () => [],
};

export type AppearanceKind = 'color' | 'effect';
export type AppearanceLayer = 'main' | 'accessory';

/** One distinct value the client accepts for a dye texture stat. */
export interface AppearanceChoice {
  readonly value: number;
  readonly name: string;
  readonly kind: AppearanceKind;
}

export interface AppearanceDefinition extends AppearanceChoice {
  readonly layer: AppearanceLayer;
}

export function readSkin(
  element: string,
  type: number,
  name: string,
  objectClass: string | undefined,
): SkinDefinition | undefined {
  if (objectClass !== 'Skin' || !hasChild(element, 'Skin')) return undefined;
  const playerClassType = parseGameNumber(childText(element, 'PlayerClassType'));
  return playerClassType === undefined ? undefined : { type, name, playerClassType };
}

/** Reads only purchasable dyes and cloths, not unrelated objects with texture-like fields. */
export function readAppearance(
  element: string,
  name: string,
  objectClass: string | undefined,
): AppearanceDefinition | undefined {
  if (objectClass !== 'Dye') return undefined;

  const main = parseGameNumber(childText(element, 'Tex1'));
  const accessory = parseGameNumber(childText(element, 'Tex2'));
  if ((main === undefined) === (accessory === undefined)) return undefined;

  const layer: AppearanceLayer = main === undefined ? 'accessory' : 'main';
  const value = main ?? accessory;
  if (value === undefined) return undefined;

  const colorSuffix = layer === 'main' ? ' Clothing Dye' : ' Accessory Dye';
  if (name.endsWith(colorSuffix)) {
    return { layer, value, name: name.slice(0, -colorSuffix.length), kind: 'color' };
  }

  const effectPrefix = layer === 'main' ? 'Large ' : 'Small ';
  const effectSuffix = ' Cloth';
  if (!name.startsWith(effectPrefix) || !name.endsWith(effectSuffix)) return undefined;
  return {
    layer,
    value,
    name: name.slice(effectPrefix.length, -effectSuffix.length),
    kind: 'effect',
  };
}

/** Reads the consumable shader definitions the client exposes as Arcane Styles. */
export function readArcaneStyle(
  element: string,
  name: string,
  objectClass: string | undefined,
): string | undefined {
  if (objectClass !== 'Equipment' || !hasChild(element, 'Shader')) return undefined;
  if (childText(element, 'Activate') !== 'Shader') return undefined;
  return childText(element, 'Description') === 'Applies an Arcane Style to your character.'
    ? name
    : undefined;
}
