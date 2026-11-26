// Zips the extension for upload to the Chrome Web Store: dist/claude-browser-bridge-<version>.zip
// (manifest.json at the root of the zip, machine-specific files left out). No dependencies.
//
//   npm run pack-extension
import path from 'node:path';
import zlib from 'node:zlib';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extDir = path.join(root, 'extension');
const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const SKIP = new Set(['server-path.json', '.DS_Store', 'Thumbs.db']);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, data: readFileSync(full) });
  }
  return out;
}

const files = walk(extDir);
const local = [];
const central = [];
let offset = 0;
// DOS date/time for 1980-01-01 00:00, so the zip is the same on every build.
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;
for (const { rel, data } of files) {
  const name = Buffer.from(rel, 'utf8');
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
  h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
  local.push(h, name, packed);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
  c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
  c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += h.length + name.length + packed.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);

const outDir = path.join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `claude-browser-bridge-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(`${out} (${files.length} files). Upload it at https://chrome.google.com/webstore/devconsole`);
