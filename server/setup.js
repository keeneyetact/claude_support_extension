// One-command install for people who are not developers:
//
//   npx -y claude-browser-bridge-mcp setup      (from npm)
//   node server/index.js setup                  (from a clone of the project)
//
// 1. Puts the server and the extension in a folder that stays put (~/.claude-browser-bridge when
//    run through npx, whose cache can be cleared at any time; the current folder otherwise).
// 2. Registers the MCP server with Claude Code for every project ("claude mcp add --scope user").
// 3. Opens chrome://extensions and the extension folder, copies the folder path to the clipboard,
//    and says exactly what to click.
//
//   ... setup --help | uninstall
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extensionDir, writeExtensionPath, serverCommand, IN_NPX_CACHE } from './extension-path.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
const MCP_NAME = 'chrome-bridge';
const HOME_DIR = process.env.CHROME_BRIDGE_HOME || path.join(os.homedir(), '.claude-browser-bridge');
// Set this once the extension is listed on the Chrome Web Store; setup then sends people there
// instead of to "Load unpacked".
const WEB_STORE_URL = '';

const isWin = process.platform === 'win32';
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const step = (n, s) => console.log(`\n${bold(`${n}.`)} ${bold(s)}`);
const ok = (s) => console.log(`   ${green('✓')} ${s}`);
const warn = (s) => console.log(`   ${yellow('!')} ${s}`);
const info = (s) => console.log(`     ${s}`);

function run(cmd, args, opts = {}) {
  // .cmd/.bat files (npm, claude shims) need a shell on Windows.
  const base = { encoding: 'utf8', windowsHide: true, ...opts };
  if (!isWin || /\.exe$/i.test(cmd)) return spawnSync(cmd, args, base);
  const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return spawnSync([cmd, ...args].map(q).join(' '), { ...base, shell: true });
}

function openDetached(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------------ 1. a folder that stays put

/** Installs this exact version into HOME_DIR with npm and returns the installed package folder. */
function installToHome() {
  mkdirSync(HOME_DIR, { recursive: true });
  const manifest = path.join(HOME_DIR, 'package.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: 'claude-browser-bridge-home', private: true }, null, 2) + '\n');
  // CHROME_BRIDGE_INSTALL_FROM: install from a local tarball instead of the registry (testing).
  const spec = process.env.CHROME_BRIDGE_INSTALL_FROM || `${pkg.name}@${pkg.version}`;
  const r = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', spec], { cwd: HOME_DIR, stdio: 'inherit' });
  const dir = path.join(HOME_DIR, 'node_modules', pkg.name);
  if (r.status !== 0 || !existsSync(path.join(dir, 'index.js'))) {
    throw new Error(`npm could not install ${pkg.name}@${pkg.version} into ${HOME_DIR}.`);
  }
  return dir;
}

// ------------------------------------------------------------------ 2. Claude Code

/** The claude CLI: on PATH, or the copy bundled with the VS Code / Cursor / Windsurf extension. */
function findClaude() {
  const probe = run(isWin ? 'where' : 'which', ['claude']);
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Prefer an .exe/.cmd on Windows ("where" also lists the extension-less shell script).
    const pick = isWin ? first.find((p) => /\.(exe|cmd)$/i.test(p)) || first[0] : first[0];
    if (pick) return pick;
  }
  const bin = isWin ? 'claude.exe' : 'claude';
  const found = [];
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const extRoot = path.join(os.homedir(), editor, 'extensions');
    let names = [];
    try { names = readdirSync(extRoot); } catch (_) { continue; }
    for (const n of names) {
      if (!n.startsWith('anthropic.claude-code-')) continue;
      const p = path.join(extRoot, n, 'resources', 'native-binary', bin);
      if (existsSync(p)) found.push(p);
    }
  }
  // Newest version last in a plain sort is good enough for "x.y.z" folders of the same length;
  // compare numerically to be safe.
  const ver = (p) => (p.match(/claude-code-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  found.sort((a, b) => {
    const [x, y] = [ver(a), ver(b)];
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  });
  return found.pop() || null;
}

/** Splits `node "C:/a b/index.js"` into command and args. */
function splitCommand(s) {
  const parts = [];
  s.replace(/"([^"]*)"|(\S+)/g, (_, q, w) => { parts.push(q ?? w); return ''; });
  return parts;
}

/** Fallback when there is no claude CLI: write the user-scope server into ~/.claude.json. */
function registerInConfigFile(command, env) {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch (_) { return null; }
    copyFileSync(file, file + '.bak-chrome-bridge');
  }
  const [cmd, ...args] = splitCommand(command);
  cfg.mcpServers = { ...(cfg.mcpServers || {}), [MCP_NAME]: { type: 'stdio', command: cmd, args, env } };
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

function register(command) {
  const env = {};
  if (process.env.CHROME_BRIDGE_TOKEN) env.CHROME_BRIDGE_TOKEN = process.env.CHROME_BRIDGE_TOKEN;
  const claude = findClaude();
  if (claude) {
    run(claude, ['mcp', 'remove', '--scope', 'user', MCP_NAME]); // re-running setup replaces it
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    const r = run(claude, ['mcp', 'add', '--scope', 'user', ...envArgs, MCP_NAME, '--', ...splitCommand(command)]);
    if (r.status === 0) return { how: 'cli', claude };
    warn(`"claude mcp add" failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
  }
  const file = registerInConfigFile(command, env);
  return file ? { how: 'file', file } : null;
}

// ------------------------------------------------------------------ 3. Chrome

function copyToClipboard(text) {
  const [cmd, args] = isWin ? ['clip', []] : process.platform === 'darwin' ? ['pbcopy', []] : ['xclip', ['-selection', 'clipboard']];
  const r = spawnSync(cmd, args, { input: text, windowsHide: true });
  return r.status === 0;
}

function openChrome(url) {
  if (isWin) {
    // Chrome registers its location under App Paths; "start chrome" uses the same key.
    let exe = '';
    for (const hive of ['HKCU', 'HKLM']) {
      const r = spawnSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'], { encoding: 'utf8', windowsHide: true });
      const m = r.status === 0 && r.stdout.match(/REG_SZ\s+(.+)/);
      if (m && existsSync(m[1].trim().replace(/^"|"$/g, ''))) { exe = m[1].trim().replace(/^"|"$/g, ''); break; }
    }
    return exe ? openDetached(exe, [url]) : false;
  }
  if (process.platform === 'darwin') return spawnSync('open', ['-a', 'Google Chrome', url]).status === 0;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (spawnSync('which', [c]).status === 0) return openDetached(c, [url]);
  }
  return false;
}

function openFolder(dir) {
  if (isWin) return openDetached('explorer', [dir]);
  return openDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir]);
}

// ------------------------------------------------------------------ commands

function help() {
  console.log(`Claude Browser Bridge ${pkg.version} - lets Claude Code use your real Chrome.

  npx -y ${pkg.name} setup       Install, register with Claude Code, and open Chrome's extension page
                                 (add --no-open to only print the steps)
  npx -y ${pkg.name} uninstall   Unregister the MCP server from Claude Code
  npx -y ${pkg.name}             Run the MCP server (Claude Code does this for you)

Environment: CHROME_BRIDGE_TOKEN (optional shared secret, also set it in the extension),
CHROME_BRIDGE_HOME (install folder, default ~/.claude-browser-bridge).`);
}

async function setup({ open = true } = {}) {
  console.log(bold(`Claude Browser Bridge ${pkg.version} setup`));

  step(1, 'Installing');
  let pkgDir = here;
  if (IN_NPX_CACHE) {
    info(`Copying to ${HOME_DIR} so it keeps working after npx clears its cache…`);
    pkgDir = installToHome();
  } else if (!existsSync(path.join(here, 'node_modules')) && !existsSync(path.join(here, '..', 'node_modules', 'ws'))) {
    info('Installing dependencies…');
    if (run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: here, stdio: 'inherit' }).status !== 0) {
      throw new Error(`"npm install" failed in ${here}.`);
    }
  }
  // Ask the installed copy for its own paths (they differ from ours when we just installed it).
  const mod = pkgDir === here
    ? { extensionDir, writeExtensionPath, serverCommand }
    : await import(new URL('extension-path.js', `file:///${pkgDir.replace(/\\/g, '/')}/`).href);
  mod.writeExtensionPath();
  const extDir = mod.extensionDir();
  const command = mod.serverCommand();
  if (!extDir) throw new Error(`The extension folder is missing next to ${pkgDir}.`);
  ok(`Server: ${command}`);
  ok(`Extension folder: ${extDir}`);

  step(2, 'Connecting it to Claude Code');
  const reg = register(command);
  if (!reg) {
    warn('Could not find Claude Code. Install it (https://claude.com/claude-code), then run this command:');
    info(`claude mcp add --scope user ${MCP_NAME} -- ${command}`);
  } else if (reg.how === 'cli') {
    ok(`Registered "${MCP_NAME}" for all your projects (${path.basename(reg.claude)} mcp add --scope user).`);
  } else {
    ok(`Registered "${MCP_NAME}" for all your projects in ${reg.file}.`);
  }
  info('Already-open Claude Code sessions pick it up after a restart (or start a new session).');

  step(3, 'Adding the extension to Chrome');
  if (WEB_STORE_URL) {
    if (open) openChrome(WEB_STORE_URL);
    info(`Click "Add to Chrome" on the page that just opened: ${WEB_STORE_URL}`);
    info('Do this once in every Chrome profile you want Claude to use.');
  } else {
    const copied = open && copyToClipboard(extDir);
    const opened = open && openChrome('chrome://extensions');
    if (open) openFolder(extDir);
    info(opened ? 'Chrome is now showing chrome://extensions. There:' : 'In Chrome, open chrome://extensions. There:');
    info(`  a. Turn on ${bold('Developer mode')} (top right).`);
    info(`  b. Click ${bold('Load unpacked')} and choose this folder${copied ? ' (its path is on your clipboard; paste it into the folder box)' : ''}:`);
    info(`     ${extDir}`);
    info('  c. Pin the extension (puzzle icon → pin) so you can see when Claude is connected.');
    info('Do this once in every Chrome profile you want Claude to use. Updates: run setup again, then click Reload on the extension.');
  }

  step(4, 'Try it');
  info('In Chrome, click the extension icon → "Copy prompt for Claude", and paste it into Claude Code.');
  info('Or just ask Claude: "Open my Chrome and summarise the page I have open."');
  console.log(`\n${green('Done.')}`);
}

function uninstall() {
  const claude = findClaude();
  if (claude && run(claude, ['mcp', 'remove', '--scope', 'user', MCP_NAME]).status === 0) {
    ok(`Removed "${MCP_NAME}" from Claude Code.`);
  } else {
    warn(`Run this to remove it: claude mcp remove --scope user ${MCP_NAME}`);
  }
  info('To remove the extension, click Remove on its card in chrome://extensions in each profile.');
  if (existsSync(HOME_DIR)) info(`You can also delete ${HOME_DIR}.`);
}

export async function runCli(cmd, args = []) {
  try {
    if (cmd === 'setup' || cmd === 'install') await setup({ open: !args.includes('--no-open') });
    else if (cmd === 'uninstall') uninstall();
    else help();
  } catch (e) {
    console.error(`\n${yellow('Setup failed:')} ${e.message}`);
    process.exitCode = 1;
  }
}

// `node setup.js setup` (npm run setup) works before "npm install": it needs no dependencies.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv[2] || 'setup', process.argv.slice(3));
}
