// Service worker: maintains WebSocket connections to local Claude bridge servers and runs their commands.
import { handleCommand, getCurrentTabId } from './commands.js';
import { detachAll, attachedTabIds } from './cdp.js';

const PROTOCOL_VERSION = 1;
const DEFAULTS = {
  enabled: true,
  profileLabel: '',
  token: '',
  portStart: 18765,
  portCount: 10,
};
const SCAN_INTERVAL_MS = 3000;
const PING_INTERVAL_MS = 20000;
const LOG_SIZE = 50;

let settings = { ...DEFAULTS };
let profileId = null;
let email = '';
/** port -> { port, ws, state: 'connecting'|'handshake'|'open', server, connectedAt, clientNonce } */
const conns = new Map();
const activity = [];
let initPromise = null;
let loopsStarted = false;

// ------------------------------------------------------------------ init

function init() {
  if (!initPromise) {
    initPromise = (async () => {
      const stored = await chrome.storage.local.get(['settings', 'profileId']);
      settings = { ...DEFAULTS, ...(stored.settings || {}) };
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
      logActivity({ method: 'init-failed', ok: false, detail: String(e && e.message || e) });
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
  const c = { port, ws: null, state: 'probing', server: null, connectedAt: null, clientNonce: null, cancelled: false };
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
    onMessage(c, msg).catch((e) => logActivity({ method: 'internal-error', ok: false, detail: String(e && e.message || e) }));
  };
  ws.onclose = () => {
    clearTimeout(handshakeTimer);
    if (conns.get(port) === c) conns.delete(port);
    if (c.state === 'open') logActivity({ method: 'disconnected', ok: true, detail: serverLabel(c) });
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
    logActivity({ method: 'send-failed', ok: false, detail: String(e && e.message || e) });
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
          logActivity({ method: 'token-mismatch', ok: false, detail: `Server on port ${c.port} does not know the shared token; disconnected.` });
          try { c.ws.close(4003, 'server token mismatch'); } catch (_) { /* ignore */ }
          return;
        }
      }
      c.state = 'open';
      c.server = msg.server || {};
      c.connectedAt = Date.now();
      logActivity({ method: 'connected', ok: true, detail: serverLabel(c) });
      updateBadge();
      break;
    }
    case 'request': {
      if (c.state !== 'open') return;
      const started = Date.now();
      try {
        const result = await handleCommand(msg.method, msg.params);
        safeSend(c, { type: 'response', id: msg.id, result });
        logActivity({ method: msg.method, ok: true, ms: Date.now() - started, detail: brief(msg.params) });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        safeSend(c, { type: 'response', id: msg.id, error: { message } });
        logActivity({ method: msg.method, ok: false, ms: Date.now() - started, detail: message.slice(0, 160) });
      }
      break;
    }
    case 'error':
      logActivity({ method: 'server-error', ok: false, detail: msg.message });
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

function brief(params) {
  if (!params) return '';
  const p = { ...params };
  if (typeof p.text === 'string' && p.text.length > 40) p.text = p.text.slice(0, 40) + '…';
  if (typeof p.expression === 'string' && p.expression.length > 60) p.expression = p.expression.slice(0, 60) + '…';
  const s = JSON.stringify(p);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function logActivity(entry) {
  activity.unshift({ time: Date.now(), ...entry });
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
        const current = getCurrentTabId();
        let currentTab = null;
        if (current != null) currentTab = await chrome.tabs.get(current).catch(() => null);
        return {
          settings,
          profileId,
          email,
          label: profileLabel(),
          ports: ports(),
          connections: openConns().map((c) => ({ port: c.port, server: c.server, connectedAt: c.connectedAt })),
          attachedTabs: attachedTabIds().length,
          agentTab: currentTab ? { id: currentTab.id, title: currentTab.title, url: currentTab.url } : null,
          activity,
        };
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
        logActivity({ method: 'release-tabs', ok: true, detail: `${n} tab(s)` });
        return { ok: true, count: n };
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
