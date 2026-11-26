// Writes the exact path of server/index.js (and the full command that starts it) into
// extension/server-path.json, so the extension popup can put it in the copied "claude mcp add"
// command. Chrome does not tell an extension
// where its folder is on disk. Runs on `npm install` and every time the server starts.
//
// The file also lists the extension ids Chrome gives the extension folder when it is loaded
// unpacked (the id is a hash of the folder path). The extension only trusts the file when its own
// id is in that list, so a copy of this project made on another machine, or moved to another
// folder, never shows a stale path.
//
//   node extension-path.js
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_SCRIPT = path.join(here, 'index.js');
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));

/**
 * The extension folder that belongs to this server: ../extension in a clone of the project,
 * ./extension in the npm package (copied there on `npm pack`).
 */
export function extensionDir() {
  for (const d of [path.join(here, '..', 'extension'), path.join(here, 'extension')]) {
    if (existsSync(path.join(d, 'manifest.json'))) return path.resolve(d);
  }
  return null;
}

/** True when this copy runs from npx's temporary cache, a path that can vanish at any time. */
export const IN_NPX_CACHE = /[\\/]_npx[\\/]/.test(here);

/** What follows "claude mcp add --scope user chrome-bridge --" to start this server. */
export function serverCommand() {
  return IN_NPX_CACHE ? `npx -y ${pkg.name}@${pkg.version}` : `node "${SERVER_SCRIPT.replace(/\\/g, '/')}"`;
}

/** The id Chrome gives an unpacked extension loaded from `dir` (manifest without a "key"). */
export function unpackedExtensionId(dir) {
  let p = path.resolve(dir);
  let bytes;
  if (process.platform === 'win32') {
    // Chrome upper-cases the drive letter and hashes the UTF-16 path.
    p = p.replace(/^[a-z]:/, (d) => d.toUpperCase());
    bytes = Buffer.from(p, 'utf16le');
  } else {
    bytes = Buffer.from(p, 'utf8');
  }
  const hex = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return hex.replace(/./g, (h) => String.fromCharCode(97 + parseInt(h, 16)));
}

export function writeExtensionPath() {
  const extDir = extensionDir();
  if (!extDir) return false;
  // The folder can be reached by more than one spelling (letter case, links), and Chrome
  // hashes the one picked in "Load unpacked", so list the id of each.
  const dirs = new Set([path.resolve(extDir)]);
  try { dirs.add(realpathSync.native(extDir)); } catch (_) { /* ignore */ }
  try { dirs.add(realpathSync(extDir)); } catch (_) { /* ignore */ }
  const file = path.join(extDir, 'server-path.json');
  const body = JSON.stringify({
    script: SERVER_SCRIPT.replace(/\\/g, '/'),
    command: serverCommand(),
    extensionIds: [...new Set([...dirs].map(unpackedExtensionId))],
  }, null, 2) + '\n';
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === body) return true;
    writeFileSync(file, body);
    return true;
  } catch (_) {
    return false; // read-only folder etc.; the extension falls back to the path a session reported
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(writeExtensionPath() ? `Wrote the server path to extension/server-path.json: ${SERVER_SCRIPT}` : 'extension/ folder not found; skipped.');
}
