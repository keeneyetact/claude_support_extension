// Writes the exact path of server/index.js into extension/server-path.json, so the extension
// popup can put it in the copied "claude mcp add" command. Chrome does not tell an extension
// where its folder is on disk. Runs on `npm install` and every time the server starts.
//
//   node extension-path.js
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_SCRIPT = path.join(here, 'index.js');

export function writeExtensionPath() {
  const extDir = path.join(here, '..', 'extension');
  if (!existsSync(path.join(extDir, 'manifest.json'))) return false;
  const file = path.join(extDir, 'server-path.json');
  const body = JSON.stringify({ script: SERVER_SCRIPT.replace(/\\/g, '/') }, null, 2) + '\n';
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === body) return true;
    writeFileSync(file, body);
    return true;
  } catch (_) {
    return false; // read-only checkout etc.; the extension falls back to the path a session reported
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(writeExtensionPath() ? `Wrote the server path to extension/server-path.json: ${SERVER_SCRIPT}` : 'extension/ folder not found; skipped.');
}
