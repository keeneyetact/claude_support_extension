// chrome.debugger (Chrome DevTools Protocol) session management.
// Attaching shows Chrome's "… started debugging this browser" bar; that is expected and is your visual
// indicator that the agent is in control. Use the popup's "Release all tabs" button to detach.

const PROTOCOL = '1.3';
const MAX_LOG = 500;

/** tabId -> { console: [], dialog: null, attachedAt } */
const sessions = new Map();
const attaching = new Map();

export function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message || `Timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

export function sessionFor(tabId) {
  return sessions.get(tabId) || null;
}

export function attachedTabIds() {
  return [...sessions.keys()];
}

export async function ensureAttached(tabId) {
  if (sessions.has(tabId)) return sessions.get(tabId);
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
    } catch (e) {
      const msg = e?.message || String(e);
      if (/already attached/i.test(msg)) {
        // Possibly our own stale session from a previous service-worker lifetime: re-take it.
        try { await chrome.debugger.detach({ tabId }); } catch (_) { /* ignore */ }
        try {
          await chrome.debugger.attach({ tabId }, PROTOCOL);
        } catch (e2) {
          throw new Error(`Another debugger (e.g. DevTools or another extension) is attached to tab ${tabId}: ${e2.message}`);
        }
      } else if (/cannot access|cannot attach|chrome:\/\//i.test(msg)) {
        throw new Error(`Chrome does not allow controlling this page (tab ${tabId}): ${msg}`);
      } else {
        throw new Error(`Could not attach to tab ${tabId}: ${msg}`);
      }
    }
    const st = { console: [], dialog: null, attachedAt: Date.now() };
    sessions.set(tabId, st);
    await Promise.all([
      raw(tabId, 'Page.enable'),
      raw(tabId, 'Runtime.enable'),
      raw(tabId, 'Log.enable').catch(() => {}),
    ]).catch(() => {});
    return st;
  })();
  attaching.set(tabId, p);
  try {
    return await p;
  } finally {
    attaching.delete(tabId);
  }
}

function raw(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// Input events that trigger alert()/confirm()/prompt() don't complete until the dialog is closed.
// Resolve early as soon as a dialog opens so the caller can report it (and handle_dialog can close it).
function raceDialog(tabId, promise) {
  promise.catch(() => {}); // may settle after we've moved on
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setInterval(() => {
      const st = sessions.get(tabId);
      if (!done && st && st.dialog) { done = true; clearInterval(timer); resolve({ dialogOpened: true }); }
    }, 50);
    promise.then(
      (v) => { if (!done) { done = true; clearInterval(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearInterval(timer); reject(e); } },
    );
  });
}

function send(tabId, method, params, timeoutMs) {
  const p = withTimeout(raw(tabId, method, params), timeoutMs, `CDP ${method} timed out after ${timeoutMs} ms`);
  return method.startsWith('Input.') ? raceDialog(tabId, p) : p;
}

/** Send a CDP command, attaching first if needed. */
export async function cdp(tabId, method, params, timeoutMs = 30000) {
  await ensureAttached(tabId);
  const st = sessions.get(tabId);
  if (st && st.dialog && method.startsWith('Input.')) return { dialogOpened: true };
  try {
    return await send(tabId, method, params, timeoutMs);
  } catch (e) {
    const msg = e?.message || String(e);
    if (/not attached|detached/i.test(msg)) {
      sessions.delete(tabId);
      await ensureAttached(tabId);
      return await send(tabId, method, params, timeoutMs);
    }
    throw e;
  }
}

export async function detach(tabId) {
  sessions.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (_) { /* ignore */ }
}

export async function detachAll() {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map(detach));
  // also release targets we may have attached in an earlier service-worker lifetime
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null && !ids.includes(t.tabId)) {
        try { await chrome.debugger.detach({ tabId: t.tabId }); } catch (_) { /* not ours */ }
      }
    }
  } catch (_) { /* ignore */ }
  return ids.length;
}

function formatRemoteObject(o) {
  if (!o) return '';
  if ('value' in o) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.preview && o.preview.properties) {
    const props = o.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(', ');
    return o.subtype === 'array' ? `[${props}${o.preview.overflow ? ', …' : ''}]` : `{${props}${o.preview.overflow ? ', …' : ''}}`;
  }
  return o.description || `[${o.type}]`;
}

function pushLog(st, entry) {
  st.console.push(entry);
  if (st.console.length > MAX_LOG) st.console.splice(0, st.console.length - MAX_LOG);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const st = source.tabId != null ? sessions.get(source.tabId) : null;
  if (!st) return;
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const frame = params.stackTrace?.callFrames?.[0];
      pushLog(st, {
        time: params.timestamp || Date.now(),
        level: params.type,
        text: (params.args || []).map(formatRemoteObject).join(' '),
        source: frame ? `${frame.url}:${frame.lineNumber + 1}` : '',
      });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      pushLog(st, {
        time: params.timestamp || Date.now(),
        level: 'exception',
        text: d.exception?.description || d.text || 'Uncaught exception',
        source: d.url ? `${d.url}:${(d.lineNumber || 0) + 1}` : '',
      });
      break;
    }
    case 'Log.entryAdded': {
      const e = params.entry || {};
      pushLog(st, { time: e.timestamp || Date.now(), level: e.level, text: e.text, source: e.url || e.source || '' });
      break;
    }
    case 'Page.javascriptDialogOpening':
      st.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url };
      break;
    case 'Page.javascriptDialogClosed':
      st.dialog = null;
      break;
    case 'Page.frameNavigated':
      if (params.frame && !params.frame.parentId) {
        pushLog(st, { time: Date.now(), level: 'navigation', text: `Navigated to ${params.frame.url}`, source: '' });
      }
      break;
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) sessions.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
});

// ------------------------------------------------------------------ input helpers

const BUTTON_BITS = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };

export async function mouseMove(tabId, x, y, modifiers = 0) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, button: 'none' });
}

export async function mouseClick(tabId, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await mouseMove(tabId, x, y, modifiers);
  const buttons = BUTTON_BITS[button] || 1;
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i, modifiers });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers });
  }
}

export async function mouseWheel(tabId, x, y, deltaX, deltaY) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none' });
}

export async function mouseDrag(tabId, from, to, steps = 12) {
  await mouseMove(tabId, from.x, from.y);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
}
