// Regenerates the proxy's export list from the real DLL we stand in for.
//
// **Ordinals are the point.** A proxy must answer on the same ordinal as the
// library it stands in for, not merely under the same name: system components
// import by ordinal, and a `.def` without them gets ordinals assigned
// alphabetically by the linker. Every one is then a different function than the
// caller asked for. That is not a subtle degradation — it crashed the game
// during startup, every time, in a way that looked like half a dozen other
// things first.
//
// Run when Windows changes the DLL:
//
//   node scripts/refresh-proxy-exports.mjs
//
// The list is committed, not generated at build time, so a build cannot depend
// on which Windows the machine happens to run.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  process.env['BROWNIE_PROXY_TARGET'] ?? 'd3d11.dll',
);
const OUT = join(REPO, 'apps', 'native', 'defs', 'exports.inc');

/** Every named export of a PE image, with the ordinal it answers on. */
function readExports(path) {
  const buf = readFileSync(path);
  const peOff = buf.readUInt32LE(0x3c);
  const magic = buf.readUInt16LE(peOff + 24);
  const optSize = buf.readUInt16LE(peOff + 20);
  const sectionCount = buf.readUInt16LE(peOff + 6);
  const exportRva = buf.readUInt32LE(peOff + 24 + (magic === 0x20b ? 112 : 96));

  const sections = [];
  for (let i = 0; i < sectionCount; i += 1) {
    const o = peOff + 24 + optSize + i * 40;
    sections.push({
      va: buf.readUInt32LE(o + 12),
      size: buf.readUInt32LE(o + 8),
      raw: buf.readUInt32LE(o + 20),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.size, 1)) return rva - s.va + s.raw;
    }
    return -1;
  };

  const dir = toOffset(exportRva);
  // IMAGE_EXPORT_DIRECTORY: +16 Base, +24 NumberOfNames, +32 AddressOfNames,
  // +36 AddressOfNameOrdinals. The stored ordinal is relative to Base.
  const base = buf.readUInt32LE(dir + 16);
  const count = buf.readUInt32LE(dir + 24);
  const namesAt = toOffset(buf.readUInt32LE(dir + 32));
  const ordinalsAt = toOffset(buf.readUInt32LE(dir + 36));

  const exports = [];
  for (let i = 0; i < count; i += 1) {
    const at = toOffset(buf.readUInt32LE(namesAt + i * 4));
    let end = at;
    while (buf[end] !== 0) end += 1;
    exports.push({
      name: buf.toString('ascii', at, end),
      ordinal: buf.readUInt16LE(ordinalsAt + i * 2) + base,
    });
  }
  return exports.sort((a, b) => a.ordinal - b.ordinal);
}

const exports = readExports(TARGET);
const header = `// Every export of the real DLL this module stands in for, with its ordinal.
//
// An X-macro rather than three parallel lists: the stubs, the resolution table
// and the linker's export list all come from this file, so a name cannot be
// present in one and missing from another.
//
// **The ordinals are load-bearing.** Callers import by ordinal as well as by
// name, and a proxy that answers the right name on the wrong ordinal hands them
// a different function. Generated from ${TARGET} — regenerate with
// scripts/refresh-proxy-exports.mjs, do not edit by hand.
//
// BrownieShutdown is not here: it is ours, not winhttp's, and the build appends
// it after the last real ordinal.

`;

writeFileSync(
  OUT,
  header + exports.map((e) => `BROWNIE_EXPORT(${e.name}, ${e.ordinal})`).join('\n') + '\n',
);
process.stdout.write(
  `wrote ${String(exports.length)} exports (ordinals ${String(exports[0]?.ordinal)}..${String(exports[exports.length - 1]?.ordinal)}) to ${OUT}\n`,
);
