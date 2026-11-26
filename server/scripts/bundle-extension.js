// Copies ../extension into server/extension before `npm pack` / `npm publish`, so the npm package
// carries the extension that matches its server. `--clean` removes the copy again (postpack).
import path from 'node:path';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(server, '..', 'extension');
const dest = path.join(server, 'extension');

rmSync(dest, { recursive: true, force: true });
if (!process.argv.includes('--clean')) {
  if (!existsSync(path.join(src, 'manifest.json'))) throw new Error(`No extension at ${src}`);
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => path.basename(p) !== 'server-path.json', // machine-specific
  });
  console.log(`Bundled the extension into ${dest}`);
}
