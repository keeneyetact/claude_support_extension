// Service worker: maintains WebSocket connections to local Claude bridge servers and runs their commands.
import { handleCommand, releaseSession, configure } from './commands.js';
import { detachAll, attachedTabIds } from './cdp.js';

const PROTOCOL_VERSION = 1;
const DEFAULTS = {
  enabled: true,
  profileLabel: '',
  token: '',
  portStart: 18765,
  portCount: 10,
  groupTabs: true,
};
// Per-session colours: tab-group colour name + matching badge colour.
const PALETTE = [
  ['blue', '#1a73e8'], ['orange', '#e8710a'], ['green', '#1e8e3e'], ['purple', '#a142f4'],
  ['pink', '#d01884'], ['cyan', '#007b83'], ['red', '#d93025'], ['yellow', '#f9ab00'],
];
const SCAN_INTERVAL_MS = 3000;
const PING_INTERVAL_MS = 20000;
const LOG_SIZE = 100;
const SESSION_LOG_SIZE = 30;

let settings = { ...DEFAULTS };
let profileId = null;
let email = '';
/** Path of server/index.js, learned from the last session that connected (for the copied prompt). */
let serverScript = '';
/** port -> connection; once open it is also the session context used by commands.js */
const conns = new Map();
const activity = [];
let initPromise = null;
let loopsStarted = false;

// ------------------------------------------------------------------ init

function init() {
  if (!initPromise) {
    initPromise = (async () => {
      const stored = await chrome.storage.local.get(['settings', 'profileId', 'serverScript']);
      serverScript = stored.serverScript || '';
      settings = { ...DEFAULTS, ...(stored.settings || {}) };
      configure({ groupTabs: settings.groupTabs });
      profileId = stored.profileId;
      if (!profileId) {
        profileId = crypto.randomUUID();
        await chrome.storage.local.set({ profileId });
      }
      try {
        const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
        email = info?.email || '';
      } catch (_) { email = ''; }
      startLoops();
      updateBadge();
      scan();
    })().catch((e) => {
      logActivity(null, { method: 'init-failed', ok: false, detail: String(e && e.message || e) });
      initPromise = null;
    });
  }
  return initPromise;
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;
  setInterval(scan, SCAN_INTERVAL_MS);
  setInterval(() => {
    for (const c of conns.values()) if (c.state === 'open') safeSend(c, { type: 'ping', t: Date.now() });
  }, PING_INTERVAL_MS);
  // Calling an extension API periodically keeps the MV3 service worker alive (Chrome 110+),
  // so new Claude sessions are discovered within seconds.
  setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('claude-bridge-keepalive', { periodInMinutes: 0.5 });
  init();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('claude-bridge-keepalive', { periodInMinutes: 0.5 });
  init();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'claude-bridge-keepalive') init().then(scan);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const prev = settings;
  settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
  configure({ groupTabs: settings.groupTabs });
  const reconnect = prev.token !== settings.token || prev.portStart !== settings.portStart ||
    prev.portCount !== settings.portCount || prev.profileLabel !== settings.profileLabel || !settings.enabled;
  if (reconnect) closeAll('settings changed');
  updateBadge();
  scan();
});
init();

// ------------------------------------------------------------------ connections

function ports() {
  const start = Number(settings.portStart) || DEFAULTS.portStart;
  const count = Math.max(1, Math.min(Number(settings.portCount) || DEFAULTS.portCount, 50));
  return Array.from({ length: count }, (_, i) => start + i);
}

function scan() {
  if (!settings.enabled || !profileId) return;
  const wanted = new Set(ports());
  for (const [port, c] of conns) if (!wanted.has(port)) { closeConn(c, 'port range changed'); conns.delete(port); }
  for (const port of wanted) if (!conns.has(port)) connect(port);
}

// Close without triggering Chrome's "WebSocket is closed before the connection is established" error.
function closeConn(c, reason) {
  c.cancelled = true;
  const ws = c.ws;
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => { try { ws.close(1000, reason); } catch (_) { /* ignore */ } };
    else if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason);
  } catch (_) { /* ignore */ }
}

// Is a bridge server listening on this port? Uses fetch because a refused fetch fails silently,
// whereas a refused WebSocket handshake is reported by Chrome as an extension error.
async function probe(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/claude-bridge/info`, { cache: 'no-store', signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return false;
    const info = await res.json();
    return info && info.name === 'claude-browser-bridge';
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function connect(port) {
  const c = {
    port, ws: null, state: 'probing', server: null, connectedAt: null, clientNonce: null, cancelled: false,
    // session context (see commands.js)
    number: 0, label: '', color: 'grey', badge: '', badgeColor: '#777', connected: false,
    currentTabId: null, groups: new Map(), running: new Map(), activity: [], lastActionAt: null,
  };
  conns.set(port, c);
  const alive = await probe(port);
  if (!alive || c.cancelled || conns.get(port) !== c || !settings.enabled) {
    if (conns.get(port) === c) conns.delete(port);
    return;
  }
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/claude-bridge`);
  } catch (_) {
    conns.delete(port);
    return;
  }
  c.ws = ws;
  c.state = 'connecting';
  const handshakeTimer = setTimeout(() => { if (c.state !== 'open') closeConn(c, 'handshake timeout'); }, 8000);
  ws.onopen = () => { c.state = 'handshake'; };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    onMessage(c, msg).catch((e) => logActivity(c, { method: 'internal-error', ok: false, detail: String(e && e.message || e) }));
  };
  ws.onclose = () => {
    clearTimeout(handshakeTimer);
    if (conns.get(port) === c) conns.delete(port);
    if (c.state === 'open') {
      logActivity(c, { method: 'session ended', ok: true, detail: serverLabel(c) });
      endSession(c);
    }
    updateBadge();
  };
  ws.onerror = () => { /* onclose follows */ };
}

function closeAll(reason) {
  for (const c of conns.values()) closeConn(c, reason);
  conns.clear();
  updateBadge();
}

function safeSend(c, obj) {
  try {
    if (c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(obj));
  } catch (e) {
    logActivity(null, { method: 'send-failed', ok: false, detail: String(e && e.message || e) });
  }
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(n = 16) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function profileLabel() {
  return settings.profileLabel || email || `Chrome profile ${profileId.slice(0, 8)}`;
}

async function onMessage(c, msg) {
  switch (msg.type) {
    case 'challenge': {
      c.clientNonce = randomHex();
      const manifest = chrome.runtime.getManifest();
      const hello = {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        profileId,
        label: profileLabel(),
        email,
        userAgent: navigator.userAgent,
        extensionVersion: manifest.version,
        clientNonce: c.clientNonce,
        proof: settings.token ? await hmac(settings.token, 'client:' + msg.nonce) : null,
      };
      safeSend(c, hello);
      break;
    }
    case 'welcome': {
      if (settings.token) {
        const expected = await hmac(settings.token, 'server:' + c.clientNonce);
        if (msg.proof !== expected) {
          logActivity(c, { method: 'token-mismatch', ok: false, detail: `Server on port ${c.port} does not know the shared token; disconnected.` });
          try { c.ws.close(4003, 'server token mismatch'); } catch (_) { /* ignore */ }
          return;
        }
      }
      c.server = msg.server || {};
      startSession(c);
      logActivity(c, { method: 'session started', ok: true, detail: serverLabel(c) });
      updateBadge();
      break;
    }
    case 'request': {
      if (c.state !== 'open') return;
      const started = Date.now();
      c.running.set(msg.id, { method: msg.method, since: started, detail: brief(msg.params) });
      c.lastActionAt = started;
      try {
        const result = await handleCommand(msg.method, msg.params, c);
        safeSend(c, { type: 'response', id: msg.id, result });
        logActivity(c, { method: msg.method, ok: true, ms: Date.now() - started, detail: brief(msg.params), tabId: c.currentTabId });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        safeSend(c, { type: 'response', id: msg.id, error: { message } });
        logActivity(c, { method: msg.method, ok: false, ms: Date.now() - started, detail: message.slice(0, 200), tabId: c.currentTabId });
      } finally {
        c.running.delete(msg.id);
        c.lastActionAt = Date.now();
      }
      break;
    }
    case 'error':
      logActivity(c, { method: 'server-error', ok: false, detail: msg.message });
      break;
    case 'pong':
    default:
      break;
  }
}

function serverLabel(c) {
  const s = c.server || {};
  return `port ${c.port}${s.cwd ? ` — ${s.cwd}` : ''}`;
}

function basename(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

function startSession(c) {
  const used = new Set(openConns().map((o) => o.number));
  let n = 1;
  while (used.has(n)) n++;
  const [color, hex] = PALETTE[(n - 1) % PALETTE.length];
  Object.assign(c, {
    state: 'open',
    connected: true,
    connectedAt: Date.now(),
    number: n,
    label: c.server.label || basename(c.server.cwd) || `session ${n}`,
    color,
    badge: 'C' + n,
    badgeColor: hex,
  });
  const script = typeof c.server.script === 'string' ? c.server.script : '';
  if (script && script !== serverScript) {
    serverScript = script;
    chrome.storage.local.set({ serverScript }).catch(() => {});
  }
}

function endSession(c) {
  releaseSession(c);
  // Mark the session's tab groups as finished.
  for (const gid of c.groups.values()) {
    chrome.tabGroups.update(gid, { title: `Claude · ${c.label} (ended)`, color: 'grey' }).catch(() => {});
  }
}

function brief(params) {
  if (!params) return '';
  const p = { ...params };
  if (typeof p.text === 'string' && p.text.length > 40) p.text = p.text.slice(0, 40) + '…';
  if (typeof p.expression === 'string' && p.expression.length > 60) p.expression = p.expression.slice(0, 60) + '…';
  const s = JSON.stringify(p);
  return s.length > 600 ? s.slice(0, 600) + '…' : s;
}

function logActivity(session, entry) {
  const e = { time: Date.now(), ...entry };
  if (session && session.number) {
    e.session = session.number;
    e.sessionLabel = session.label;
    e.color = session.badgeColor;
    session.activity.unshift(e);
    if (session.activity.length > SESSION_LOG_SIZE) session.activity.length = SESSION_LOG_SIZE;
  }
  activity.unshift(e);
  if (activity.length > LOG_SIZE) activity.length = LOG_SIZE;
}

function openConns() {
  return [...conns.values()].filter((c) => c.state === 'open');
}

function updateBadge() {
  if (!settings.enabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#777' });
    chrome.action.setTitle({ title: 'Claude Browser Bridge — disabled' });
    return;
  }
  const n = openConns().length;
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  chrome.action.setTitle({
    title: n ? `Claude Browser Bridge — ${n} Claude session(s) connected` : 'Claude Browser Bridge — waiting for a Claude session',
  });
}

// ------------------------------------------------------------------ popup API

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await init();
    switch (msg && msg.type) {
      case 'getStatus': {
        const sessions = [];
        for (const c of openConns().sort((a, b) => a.number - b.number)) {
          let tab = null;
          if (c.currentTabId != null) {
            const t = await chrome.tabs.get(c.currentTabId).catch(() => null);
            if (t) tab = { id: t.id, windowId: t.windowId, title: t.title, url: t.pendingUrl || t.url, favIconUrl: t.favIconUrl, active: t.active, status: t.status };
          }
          sessions.push({
            number: c.number,
            label: c.label,
            color: c.badgeColor,
            cwd: c.server.cwd,
            pid: c.server.pid,
            port: c.port,
            connectedAt: c.connectedAt,
            lastActionAt: c.lastActionAt,
            running: [...c.running.values()],
            tab,
            activity: c.activity.slice(0, 8),
          });
        }
        return {
          settings,
          profileId,
          email,
          label: profileLabel(),
          serverScript,
          ports: ports(),
          sessions,
          attachedTabs: attachedTabIds().length,
          activity,
        };
      }
      case 'focusTab': {
        const t = await chrome.tabs.update(Number(msg.tabId), { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
        return { ok: true };
      }
      case 'saveSettings': {
        const next = { ...settings, ...(msg.settings || {}) };
        next.portStart = Number(next.portStart) || DEFAULTS.portStart;
        next.portCount = Math.max(1, Math.min(Number(next.portCount) || DEFAULTS.portCount, 50));
        await chrome.storage.local.set({ settings: next });
        return { ok: true };
      }
      case 'reconnect':
        closeAll('manual reconnect');
        scan();
        return { ok: true };
      case 'detachAll': {
        const n = await detachAll();
        logActivity(null, { method: 'release-tabs', ok: true, detail: `${n} tab(s)` });
        return { ok: true, count: n };
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
