/**
 * `@brownie/gamedata-tool` — extracting the game's data files, as a library.
 *
 * The command line is the usual way in, but the runtime imports the staleness
 * check: it has to be able to say "your game data is from before the last
 * patch" at startup, and two implementations of that question would drift.
 */
export { extractGameData, type ExtractedFile, type ExtractionResult } from './extract.js';
export {
  ASSETS_FILE,
  describeInstall,
  findGameInstall,
  searchedLocations,
  type GameInstall,
} from './install.js';
export {
  MANIFEST_FILE,
  buildManifest,
  checkStaleness,
  describeFile,
  readManifest,
  writeManifest,
  type GameDataManifest,
  type ManifestFile,
  type Staleness,
} from './manifest.js';
export { runCli, type CliResult } from './cli.js';
export {
  CLASS_TEXT_ASSET,
  SerializedFileError,
  readTextAssets,
  type TextAsset,
} from './unity/SerializedFile.js';
