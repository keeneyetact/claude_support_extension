#!/usr/bin/env node
// Claude Browser Bridge — MCP server (stdio) that relays browser tools to the Chrome extension
// running in your real Chrome profile(s) over a localhost WebSocket.
//
// stdout is reserved for MCP traffic; all logs go to stderr.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const PORT_START = Number(process.env.CHROME_BRIDGE_PORT_START || 18765);
const PORT_COUNT = Number(process.env.CHROME_BRIDGE_PORT_COUNT || 10);
const TOKEN = process.env.CHROME_BRIDGE_TOKEN || '';
const CONNECT_WAIT_MS = Number(process.env.CHROME_BRIDGE_CONNECT_WAIT_MS || 12000);
const PROTOCOL_VERSION = 1;

const log = (...a) => console.error('[chrome-bridge]', ...a);
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ------------------------------------------------------------------ bridge (WebSocket side)

class Bridge {
  constructor() {
    /** profileId -> conn */
    this.profiles = new Map();
    this.port = null;
    this.seq = 0;
    this.waiters = new Set();
    this.selectedProfileId = null;
  }

  async listen() {
    for (let port = PORT_START; port < PORT_START + PORT_COUNT; port++) {
      try {
        await this.listenOn(port);
        this.port = port;
        log(`listening on ws://127.0.0.1:${port} (pid ${process.pid})`);
        return port;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      }
    }
    throw new Error(`No free port in ${PORT_START}-${PORT_START + PORT_COUNT - 1}. Too many Claude sessions? Raise CHROME_BRIDGE_PORT_COUNT (and the extension's port count).`);
  }

  listenOn(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('Claude Browser Bridge: WebSocket endpoint for the Chrome extension.\n');
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (e) => log('http server error', e.message));
        const wss = new WebSocketServer({
          server,
          maxPayload: 64 * 1024 * 1024,
          verifyClient: ({ origin, req }, cb) => {
            // Only Chrome extensions may connect: web pages cannot forge the Origin header.
            const ok = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
            const host = (req.headers.host || '').split(':')[0];
            if (!ok || !['127.0.0.1', 'localhost'].includes(host)) {
              log(`rejected connection from origin=${origin} host=${req.headers.host}`);
              return cb(false, 403, 'Forbidden');
            }
            cb(true);
          },
        });
        wss.on('connection', (ws, req) => this.onConnection(ws, req));
        // Detect dead connections (e.g. browser closed without a FIN).
        const hb = setInterval(() => {
          for (const ws of wss.clients) {
            if (ws.isAlive === false) { ws.terminate(); continue; }
            ws.isAlive = false;
            try { ws.ping(); } catch (_) { /* ignore */ }
          }
        }, 30000);
        hb.unref();
        this.server = server;
        this.wss = wss;
        resolve();
      });
    });
  }

  onConnection(ws, req) {
    const conn = { ws, info: null, pending: new Map(), origin: req.headers.origin, connectedAt: Date.now() };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const nonce = crypto.randomBytes(16).toString('hex');
    const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    conn.send = send;
    const helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), 10000);
    send({ type: 'challenge', nonce, protocol: PROTOCOL_VERSION });

    ws.on('message', (data) => {
      ws.isAlive = true;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (msg.type === 'hello') {
        clearTimeout(helloTimer);
        if (TOKEN && !safeEqual(msg.proof, hmac(TOKEN, 'client:' + nonce))) {
          send({ type: 'error', message: 'Token mismatch: set the same token in the extension popup and CHROME_BRIDGE_TOKEN.' });
          log(`rejected profile "${msg.label}": token mismatch`);
          return ws.close(4001, 'token mismatch');
        }
        if (!msg.profileId) return ws.close(4002, 'missing profileId');
        conn.info = {
          profileId: String(msg.profileId),
          label: String(msg.label || 'Chrome profile'),
          email: msg.email || '',
          userAgent: msg.userAgent || '',
          extensionVersion: msg.extensionVersion || '?',
          protocol: msg.protocol,
        };
        const prev = this.profiles.get(conn.info.profileId);
        if (prev && prev !== conn) {
          this.profiles.delete(conn.info.profileId);
          try { prev.ws.close(4004, 'replaced by new connection'); } catch (_) { /* ignore */ }
        }
        this.profiles.set(conn.info.profileId, conn);
        send({
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          proof: TOKEN ? hmac(TOKEN, 'server:' + msg.clientNonce) : null,
          server: { name: 'claude-browser-bridge', version: pkg.version, pid: process.pid, cwd: process.cwd(), port: this.port },
        });
        log(`profile connected: "${conn.info.label}" (${conn.info.profileId.slice(0, 8)}, ext v${conn.info.extensionVersion})`);
        for (const w of this.waiters) w();
        return;
      }
      if (msg.type === 'response') {
        const p = conn.pending.get(msg.id);
        if (!p) return;
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'Extension error'));
        else p.resolve(msg.result);
        return;
      }
      if (msg.type === 'ping') send({ type: 'pong', t: msg.t });
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (conn.info && this.profiles.get(conn.info.profileId) === conn) {
        this.profiles.delete(conn.info.profileId);
        log(`profile disconnected: "${conn.info.label}"`);
      }
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('The Chrome profile disconnected while the command was running (browser closed, extension reloaded, or bridge disabled).'));
      }
      conn.pending.clear();
    });
    ws.on('error', (e) => log('socket error', e.message));
  }

  list() {
    return [...this.profiles.values()].filter((c) => c.info);
  }

  waitForAny(ms) {
    if (this.list().length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); this.waiters.delete(w); resolve(v); };
      const w = () => done(true);
      const t = setTimeout(() => done(false), ms);
      this.waiters.add(w);
    });
  }

  describe(c) {
    const i = c.info;
    return `"${i.label}"${i.email && i.email !== i.label ? ` <${i.email}>` : ''} (id ${i.profileId.slice(0, 8)})`;
  }

  match(selector) {
    const s = String(selector).trim().toLowerCase();
    const all = this.list();
    const exact = all.filter((c) => c.info.profileId.toLowerCase() === s || c.info.profileId.slice(0, 8).toLowerCase() === s ||
      c.info.label.toLowerCase() === s || (c.info.email && c.info.email.toLowerCase() === s));
    if (exact.length) return exact;
    return all.filter((c) => c.info.label.toLowerCase().includes(s) || (c.info.email && c.info.email.toLowerCase().includes(s)));
  }

  async getConn(selector) {
    if (!this.list().length) await this.waitForAny(CONNECT_WAIT_MS);
    const all = this.list();
    if (!all.length) {
      throw new Error(
        `No Chrome profile is connected to this Claude session (listening on 127.0.0.1:${this.port}). ` +
        'Make sure Chrome is open, the "Claude Browser Bridge" extension is installed and enabled in that profile, ' +
        `and its port range includes ${this.port} (open the extension popup to check).`,
      );
    }
    if (selector) {
      const m = this.match(selector);
      if (m.length === 1) return m[0];
      if (m.length > 1) throw new Error(`Profile "${selector}" is ambiguous; matches: ${m.map((c) => this.describe(c)).join(', ')}`);
      throw new Error(`No connected profile matches "${selector}". Connected: ${all.map((c) => this.describe(c)).join(', ')}`);
    }
    if (this.selectedProfileId) {
      const c = this.profiles.get(this.selectedProfileId);
      if (c) return c;
    }
    if (all.length === 1) return all[0];
    throw new Error(
      `${all.length} Chrome profiles are connected: ${all.map((c) => this.describe(c)).join(', ')}. ` +
      'Pass "profile" with one of these names, or call select_profile first.',
    );
  }

  call(conn, method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`Browser command "${method}" timed out after ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.send({ type: 'request', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(e);
      }
    });
  }
}

const bridge = new Bridge();

// ------------------------------------------------------------------ MCP side

const INSTRUCTIONS = `Controls the user's REAL Chrome browser profile(s) — their actual logins, cookies and tabs — via the "Claude Browser Bridge" extension.

Workflow:
1. tabs_list to see open tabs (or tab_new to open your own tab — preferred, so you don't disturb tabs the user is using).
2. snapshot (or find) to read the page as text; interactive elements get refs like [ref=e12].
3. Act with click / type / select_option / press_key / scroll / hover using those refs (refs beat coordinates).
4. Re-snapshot after the page changes; refs from old snapshots can go stale.
Use screenshot when layout/visuals matter or for canvas/cross-origin-iframe content (then click by x,y).
Commands without tabId act on the "agent tab": the last tab you opened/selected/used (initially the active tab).
If several Chrome profiles are connected, pass "profile" or call select_profile.
This is the user's real browser: don't close their tabs, submit forms, make purchases, send messages, or change account settings unless asked.`;

const mcp = new McpServer({ name: 'claude-browser-bridge', version: pkg.version }, { instructions: INSTRUCTIONS });

const profileArg = z.string().optional().describe('Chrome profile to use (name, email or id from list_profiles). Optional when only one profile is connected or one was selected.');
const tabIdArg = z.number().int().optional().describe('Tab id (from tabs_list). Defaults to the agent tab.');
const refArg = z.string().optional().describe('Element ref from snapshot/find, e.g. "e12".');
const selectorArg = z.string().optional().describe('CSS selector (alternative to ref; pierces open shadow roots and same-origin iframes).');

function toContent(result, conn) {
  const content = [];
  const prefix = bridge.list().length > 1 ? `[profile ${conn.info.label}] ` : '';
  if (result && typeof result === 'object') {
    if (result.text != null) content.push({ type: 'text', text: prefix + String(result.text) });
    for (const img of result.images || []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' });
  } else if (result != null) {
    content.push({ type: 'text', text: prefix + String(result) });
  }
  if (!content.length) content.push({ type: 'text', text: prefix + 'OK' });
  return { content };
}

function errorResult(e) {
  return { isError: true, content: [{ type: 'text', text: e && e.message ? e.message : String(e) }] };
}

/** Register a tool that is forwarded to the extension. */
function browserTool(name, description, shape, { timeout, annotations } = {}) {
  mcp.registerTool(
    name,
    { description, inputSchema: { ...shape, profile: profileArg }, annotations },
    async (args) => {
      const { profile, ...params } = args || {};
      try {
        const conn = await bridge.getConn(profile);
        const ms = typeof timeout === 'function' ? timeout(params) : timeout || 60000;
        const result = await bridge.call(conn, name, params, ms);
        return toContent(result, conn);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

const RO = { readOnlyHint: true, openWorldHint: true };
const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

// --- profiles (handled locally)
mcp.registerTool('list_profiles', {
  description: 'List the Chrome profiles currently connected to this Claude session through the extension.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  await bridge.waitForAny(Math.min(CONNECT_WAIT_MS, 5000));
  const all = bridge.list();
  if (!all.length) {
    return { content: [{ type: 'text', text: `No Chrome profiles connected yet (server listening on 127.0.0.1:${bridge.port}). Open Chrome with the Claude Browser Bridge extension enabled.` }] };
  }
  const lines = all.map((c) => {
    const sel = bridge.selectedProfileId === c.info.profileId ? '  <- selected' : '';
    const ua = /Chrome\/([\d.]+)/.exec(c.info.userAgent);
    return `- ${bridge.describe(c)}, ${ua ? 'Chrome ' + ua[1] : 'browser'}, extension v${c.info.extensionVersion}${sel}`;
  });
  return { content: [{ type: 'text', text: `${all.length} connected profile(s):\n${lines.join('\n')}` }] };
});

mcp.registerTool('select_profile', {
  description: 'Choose the default Chrome profile for subsequent browser commands (when more than one is connected).',
  inputSchema: { profile: z.string().describe('Profile name, email or id from list_profiles.') },
}, async ({ profile }) => {
  try {
    if (!bridge.list().length) await bridge.waitForAny(CONNECT_WAIT_MS);
    const m = bridge.match(profile);
    if (m.length !== 1) {
      throw new Error(m.length ? `Ambiguous: ${m.map((c) => bridge.describe(c)).join(', ')}` : `No connected profile matches "${profile}". Connected: ${bridge.list().map((c) => bridge.describe(c)).join(', ') || 'none'}`);
    }
    bridge.selectedProfileId = m[0].info.profileId;
    return { content: [{ type: 'text', text: `Selected ${bridge.describe(m[0])}.` }] };
  } catch (e) {
    return errorResult(e);
  }
});

// --- tabs
browserTool('tabs_list', 'List all windows and tabs in the profile, with tab ids, titles, URLs, which is active and which is the agent tab.', {}, { annotations: RO });

browserTool('tab_new', 'Open a new tab (optionally at a URL) and make it the agent tab. Prefer this over taking over a tab the user is using.', {
  url: z.string().optional().describe('URL to open; "https://" is added if no scheme.'),
  active: z.boolean().optional().describe('Bring the tab to the front (default true). Background tabs may need brief activation for screenshots.'),
  newWindow: z.boolean().optional().describe('Open in a new window (default false).'),
}, { timeout: 45000, annotations: ACT });

browserTool('tab_select', 'Make a tab the agent tab (target of later commands) and by default bring it to the front.', {
  tabId: z.number().int().describe('Tab id from tabs_list.'),
  activate: z.boolean().optional().describe('Bring the tab to the front in its window (default true).'),
  focusWindow: z.boolean().optional().describe('Also focus its window (default false).'),
}, { annotations: ACT });

browserTool('tab_close', 'Close a tab (default: the agent tab). Do not close the user\'s own tabs unless asked.', {
  tabId: tabIdArg,
}, { annotations: { ...ACT, destructiveHint: true } });

// --- navigation & reading
browserTool('navigate', 'Navigate the tab to a URL, or "back", "forward", "reload". Waits for the page to load.', {
  url: z.string().describe('URL, or "back" / "forward" / "reload".'),
  tabId: tabIdArg,
  timeoutMs: z.number().int().optional().describe('Max time to wait for load (default 30000).'),
}, { timeout: (p) => (p.timeoutMs || 30000) + 15000, annotations: ACT });

browserTool('snapshot', 'Read the page as an accessibility-style outline (headings, text, links, buttons, inputs with values/states). Interactive elements get [ref=eN] for use with click/type/etc. Best first step to understand a page.', {
  tabId: tabIdArg,
  interactiveOnly: z.boolean().optional().describe('Only list interactive elements and headings (much shorter).'),
  viewportOnly: z.boolean().optional().describe('Only include what is currently visible in the viewport.'),
  ref: refArg.describe('Limit the snapshot to this element subtree.'),
  selector: selectorArg.describe('Limit the snapshot to the element matching this CSS selector.'),
  maxChars: z.number().int().optional().describe('Truncate output (default 25000).'),
}, { annotations: RO });

browserTool('find', 'Find visible elements whose accessible name / label / placeholder / text contains the query. Returns refs. Faster than a full snapshot on big pages.', {
  query: z.string().describe('Text to look for (case-insensitive substring).'),
  tabId: tabIdArg,
  limit: z.number().int().optional().describe('Max results (default 20).'),
}, { annotations: RO });

browserTool('get_text', 'Get the visible text (innerText) of the page or of one element, paginated.', {
  tabId: tabIdArg,
  ref: refArg,
  selector: selectorArg,
  offset: z.number().int().optional().describe('Character offset to start at (for pagination).'),
  maxChars: z.number().int().optional().describe('Max characters to return (default 20000).'),
}, { annotations: RO });

browserTool('screenshot', 'Capture a screenshot of the viewport (default), the full page, or one element. Returns an image plus how image pixels map to click coordinates.', {
  tabId: tabIdArg,
  fullPage: z.boolean().optional().describe('Capture the whole scrollable page.'),
  ref: refArg.describe('Capture only this element.'),
  selector: selectorArg.describe('Capture only the element matching this selector.'),
  format: z.enum(['jpeg', 'png']).optional().describe('Image format (default jpeg).'),
  quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (default 80).'),
  maxDimension: z.number().int().optional().describe('Downscale so the longest side is at most this many px (default 1568).'),
}, { timeout: 60000, annotations: RO });

// --- interaction
browserTool('click', 'Click an element (by ref or selector) or a viewport point (x,y in CSS px) with a real mouse event. Reports navigation, new tabs and dialogs that result.', {
  ref: refArg,
  selector: selectorArg,
  x: z.number().optional().describe('Viewport x in CSS px (use with y when no ref/selector).'),
  y: z.number().optional().describe('Viewport y in CSS px.'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  doubleClick: z.boolean().optional(),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional().describe('Modifier keys held during the click.'),
  tabId: tabIdArg,
}, { timeout: 45000, annotations: ACT });

browserTool('hover', 'Move the mouse over an element or point (to reveal menus/tooltips).', {
  ref: refArg, selector: selectorArg,
  x: z.number().optional(), y: z.number().optional(),
  tabId: tabIdArg,
}, { annotations: ACT });

browserTool('drag', 'Drag from one element/point to another with real mouse events.', {
  fromRef: z.string().optional(), fromSelector: z.string().optional(), fromX: z.number().optional(), fromY: z.number().optional(),
  toRef: z.string().optional(), toSelector: z.string().optional(), toX: z.number().optional(), toY: z.number().optional(),
  tabId: tabIdArg,
}, { timeout: 45000, annotations: ACT });

browserTool('type', 'Type text like a user. With ref/selector, focuses that field first (optionally clearing it); otherwise types into the focused element.', {
  text: z.string().describe('Text to type. Use "\\n" only in multi-line fields.'),
  ref: refArg,
  selector: selectorArg,
  clear: z.boolean().optional().describe('Replace the field\'s current content (default false = append at cursor).'),
  submit: z.boolean().optional().describe('Press Enter afterwards.'),
  slowly: z.boolean().optional().describe('Type one key at a time (for fields that react to each keystroke, e.g. autocomplete). Default inserts the text at once.'),
  tabId: tabIdArg,
}, { timeout: 120000, annotations: ACT });

browserTool('press_key', 'Press a key or key combination in the tab, e.g. "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+A", "Shift+Tab", "Meta+Enter".', {
  keys: z.union([z.string(), z.array(z.string())]).describe('A key/combo, or a list pressed in sequence.'),
  repeat: z.number().int().optional().describe('Repeat the sequence N times (default 1).'),
  tabId: tabIdArg,
}, { annotations: ACT });

browserTool('select_option', 'Choose option(s) in a native <select> by value or visible text. For custom dropdowns, use click instead.', {
  values: z.union([z.string(), z.array(z.string())]).describe('Option value(s) or label(s).'),
  ref: refArg, selector: selectorArg,
  tabId: tabIdArg,
}, { annotations: ACT });

browserTool('scroll', 'Scroll with the mouse wheel. With only ref/selector: scroll that element into view. Default: one screen down.', {
  deltaY: z.number().optional().describe('Pixels to scroll down (negative = up).'),
  deltaX: z.number().optional().describe('Pixels to scroll right (negative = left).'),
  ref: refArg.describe('Scroll inside / to this element.'),
  selector: selectorArg,
  x: z.number().optional().describe('Viewport point to scroll at (for nested scroll areas).'),
  y: z.number().optional(),
  tabId: tabIdArg,
}, { annotations: ACT });

browserTool('upload_file', 'Set local file(s) on an <input type="file"> (absolute paths on this computer).', {
  paths: z.union([z.string(), z.array(z.string())]).describe('Absolute file path(s).'),
  ref: refArg, selector: selectorArg,
  tabId: tabIdArg,
}, { annotations: ACT });

browserTool('handle_dialog', 'Accept or dismiss a JavaScript alert/confirm/prompt/beforeunload dialog that is blocking the tab.', {
  accept: z.boolean().optional().describe('true = OK/accept (default), false = Cancel/dismiss.'),
  promptText: z.string().optional().describe('Text to enter for prompt() dialogs.'),
  tabId: tabIdArg,
}, { annotations: ACT });

browserTool('wait_for', 'Wait until text appears/disappears or a selector becomes visible/hidden; or just wait "time" ms.', {
  text: z.string().optional(), textGone: z.string().optional(),
  selector: z.string().optional(), selectorGone: z.string().optional(),
  time: z.number().optional().describe('Milliseconds to wait when no condition is given (max 60000).'),
  timeoutMs: z.number().int().optional().describe('Max wait for a condition (default 15000).'),
  tabId: tabIdArg,
}, { timeout: (p) => Math.max(p.timeoutMs || 15000, p.time || 0) + 15000, annotations: RO });

// --- developer tools
browserTool('evaluate', 'Run JavaScript in the page (main world, bypasses CSP) and return the JSON-serializable result. Supports top-level await; multi-statement code may use "return". Use for reading data or actions other tools can\'t do.', {
  expression: z.string().describe('JavaScript expression or statements.'),
  tabId: tabIdArg,
  timeoutMs: z.number().int().optional().describe('Default 30000.'),
}, { timeout: (p) => (p.timeoutMs || 30000) + 10000, annotations: ACT });

browserTool('console_messages', 'Get console messages, uncaught exceptions and navigations captured on the tab (capture starts the first time the agent touches the tab).', {
  level: z.string().optional().describe('Filter: log, info, warning, error, debug, exception, navigation.'),
  clear: z.boolean().optional().describe('Clear the buffer after reading.'),
  limit: z.number().int().optional().describe('Max messages (default 100, newest last).'),
  tabId: tabIdArg,
}, { annotations: RO });

// ------------------------------------------------------------------ start

async function main() {
  await bridge.listen();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log(`MCP server ready (v${pkg.version}); waiting for the Chrome extension to connect…`);
  const shutdown = () => {
    try { bridge.wss?.close(); bridge.server?.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});
