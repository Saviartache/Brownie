import { readTextAssets, type TextAsset } from './unity/SerializedFile.js';

/**
 * The XML documents the runtime reads, and how to recognise them.
 *
 * The game does not name these assets: it ships dozens of `TextAsset`s whose
 * names are internal, and the only reliable way to tell an object catalog from
 * a tile catalog is the root element inside it. Recognising by content rather
 * than by name is what survives the game renaming or re-splitting a file, which
 * it does.
 */
const XML_DOCUMENTS = [
  { file: 'objects.xml', rootTag: 'Objects' },
  { file: 'tiles.xml', rootTag: 'GroundTypes' },
] as const;

/**
 * Assets taken verbatim, by name.
 *
 * These are single documents rather than fragments, so there is nothing to
 * merge and nothing to recognise.
 */
const NAMED_DOCUMENTS = new Set(['enchantments', 'enchantmentLists', 'enchanterSettings']);

export interface ExtractedFile {
  readonly name: string;
  readonly content: Buffer;
  /** How many assets went into it — one for a named file, many for a merged one. */
  readonly parts: number;
}

export interface ExtractionResult {
  readonly files: readonly ExtractedFile[];
  readonly unityVersion: string;
  readonly assetsSeen: number;
}

/**
 * Pulls the game's data documents out of a `resources.assets` buffer.
 *
 * The catalogs arrive **in fragments**: the game splits `<Objects>` across many
 * text assets, and each is a complete little XML document. They are concatenated
 * inside one root element, in the order the file lists them — which is the order
 * the game itself reads them in, and therefore the order in which a later
 * definition overrides an earlier one.
 */
export function extractGameData(assets: Buffer): ExtractionResult {
  const fragments = new Map<string, Buffer[]>(XML_DOCUMENTS.map((doc) => [doc.file, []]));
  const named = new Map<string, Buffer>();
  let assetsSeen = 0;

  const iterator = readTextAssets(assets);
  let unityVersion = 'unknown';
  for (;;) {
    const step = iterator.next();
    if (step.done === true) {
      unityVersion = step.value.unityVersion;
      break;
    }
    assetsSeen++;
    collect(step.value, fragments, named);
  }

  const files: ExtractedFile[] = [];
  for (const { file, rootTag } of XML_DOCUMENTS) {
    const parts = fragments.get(file) ?? [];
    if (parts.length === 0) continue;
    files.push({ name: file, content: mergeFragments(parts, rootTag), parts: parts.length });
  }
  for (const [name, content] of named) {
    files.push({ name: `${name}.xml`, content, parts: 1 });
  }

  return { files, unityVersion, assetsSeen };
}

function collect(
  asset: TextAsset,
  fragments: Map<string, Buffer[]>,
  named: Map<string, Buffer>,
): void {
  if (NAMED_DOCUMENTS.has(asset.name)) {
    named.set(asset.name, asset.data);
    return;
  }
  // Anything that is not XML at all — sprite sheets, binary blobs — is skipped
  // by looking at its first bytes rather than by parsing it.
  if (asset.data.length < 10 || asset.data.toString('ascii', 0, 5) !== '<?xml') return;

  // The root element appears in the first few hundred bytes; reading more of a
  // multi-megabyte fragment to find it would be the whole file, twice.
  const head = asset.data.toString('utf8', 0, 256);
  for (const { file, rootTag } of XML_DOCUMENTS) {
    if (head.includes(`<${rootTag}>`)) {
      fragments.get(file)?.push(asset.data);
      return;
    }
  }
}

/**
 * Joins fragments into one document under a single root element.
 *
 * A fragment whose root element cannot be found is dropped rather than
 * concatenated raw: emitting it would produce a document with two roots, which
 * nothing downstream could read at all.
 */
function mergeFragments(parts: readonly Buffer[], rootTag: string): Buffer {
  const open = `<${rootTag}>`;
  const close = `</${rootTag}>`;

  const inner = parts
    .map((part) => {
      const text = part.toString('utf8');
      const start = text.indexOf(open);
      const end = text.lastIndexOf(close);
      if (start === -1 || end === -1 || end < start) return '';
      return text.slice(start + open.length, end).trim();
    })
    .filter((body) => body !== '')
    .join('\n');

  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n${open}\n${inner}\n${close}\n`,
    'utf8',
  );
}
