/**
 * Special game-location / realm ids, as used in `HELLO` and reconnect packets.
 *
 * Ported from the reference implementation. Unlike class or object ids these
 * are protocol constants — they are not in the game-data files — so code is
 * their proper home. Nothing reads it yet; it is here for the features that
 * route between worlds.
 */
export const GameId = {
  Tutorial: -1,
  Nexus: -2,
  RandomRealm: -3,
  Vault: -5,
  MapTest: -6,
  VaultExplanation: -8,
  NexusExplanation: -9,
  QuestRoom: -11,
  CheatersQuarantine: -13,
} as const;

export type GameIdName = keyof typeof GameId;
export type GameId = (typeof GameId)[GameIdName];
