// Functions injected into controlled tabs with chrome.scripting.executeScript({ func }). Each is
// serialized on its own, so it must not use anything from this module's scope.

/**
 * MAIN world (the page's own JavaScript world), injected as early as possible on each page:
 * - records console messages and uncaught errors;
 * - answers alert / confirm / prompt itself, so a dialog can never freeze the tab. confirm and
 *   prompt are dismissed (Cancel) unless handle_dialog said how to answer the next one;
 * - reports window.open calls that Chrome's popup blocker refused (synthetic clicks carry no user
 *   activation), so the extension can open the page in a tab instead.
 * Everything is sent to the isolated-world relay as JSON strings on a per-tab random event name.
 */
export function pageHook(channel, policy) {
  const KEY = '__claudeBridgeHook_' + channel;
  if (window[KEY]) { window[KEY].setPolicy(policy); return true; }
  let live = true;
  const restore = []; // [object, name, original] to put back when the tab is released
  const swap = (obj, name, fn) => { restore.push([obj, name, obj[name]]); obj[name] = fn; };
  const send = (entry) => {
    if (!live) return;
    try { document.dispatchEvent(new CustomEvent(channel, { detail: JSON.stringify(entry) })); } catch (_) { /* ignore */ }
  };
  const fmt = (v, depth = 0) => {
    try {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
      if (v === undefined) return 'undefined';
      if (typeof v === 'function') return `[function ${v.name || 'anonymous'}]`;
      if (typeof Node !== 'undefined' && v instanceof Node) {
        return v.nodeType === 1 ? `<${v.tagName.toLowerCase()}${v.id ? '#' + v.id : ''}>` : `[${v.nodeName}]`;
      }
      if (typeof v === 'object' && v !== null && depth < 1) {
        const s = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x + 'n' : x));
        return s && s.length > 2000 ? s.slice(0, 2000) + '…' : s;
      }
      return String(v);
    } catch (_) {
      return Object.prototype.toString.call(v);
    }
  };
  const where = () => {
    const line = (new Error().stack || '').split('\n')[3] || '';
    const m = line.match(/\(?((?:https?|file|chrome-extension):[^)\s]+)\)?\s*$/);
    return m ? m[1] : '';
  };
  const LEVEL = { log: 'log', info: 'info', warn: 'warning', error: 'error', debug: 'debug' };
  for (const name of Object.keys(LEVEL)) {
    const orig = console[name];
    if (typeof orig !== 'function') continue;
    swap(console, name, function (...args) {
      send({ kind: 'console', level: LEVEL[name], text: args.map((a) => fmt(a)).join(' '), source: where(), time: Date.now() });
      return orig.apply(this, args);
    });
  }
  window.addEventListener('error', (e) => {
    if (e.error || e.message) {
      send({ kind: 'console', level: 'exception', text: e.error ? fmt(e.error) : e.message, source: e.filename ? `${e.filename}:${e.lineno}` : '', time: Date.now() });
    }
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    send({ kind: 'console', level: 'exception', text: 'Unhandled promise rejection: ' + fmt(e.reason), source: '', time: Date.now() });
  });

  let pol = policy || {};
  const answer = (type, message, def) => {
    const once = pol.next;
    pol = { ...pol, next: null };
    let accept = false, text = null;
    if (type === 'alert') accept = true;
    else if (once) { accept = !!once.accept; text = once.promptText != null ? String(once.promptText) : def; }
    send({ kind: 'dialog', type, message: String(message ?? ''), accepted: accept, promptText: type === 'prompt' && accept ? text : null, preset: !!once, time: Date.now() });
    if (type === 'confirm') return accept;
    if (type === 'prompt') return accept ? (text ?? '') : null;
    return undefined;
  };
  swap(window, 'alert', function (message) { answer('alert', message); });
  swap(window, 'confirm', function (message) { return answer('confirm', message); });
  swap(window, 'prompt', function (message, def) { return answer('prompt', message, def == null ? '' : String(def)); });
  // Leaving a page Claude controls must not stop at "Leave site?".
  window.addEventListener('beforeunload', (e) => { if (live) e.stopImmediatePropagation(); }, true);

  const open = window.open;
  swap(window, 'open', function (url, ...rest) {
    const w = open.call(this, url, ...rest);
    if (!w) {
      let href = '';
      try { href = new URL(url == null ? 'about:blank' : String(url), location.href).href; } catch (_) { href = String(url); }
      send({ kind: 'popup', url: href, time: Date.now() });
    }
    return w;
  });

  const api = {
    setPolicy: (p) => { pol = p || {}; },
    // The tab was released: give the page its own console, dialogs and window.open back.
    remove: () => {
      live = false;
      for (const [obj, name, orig] of restore.reverse()) { try { obj[name] = orig; } catch (_) { /* ignore */ } }
      delete window[KEY];
    },
  };
  Object.defineProperty(window, KEY, { value: api, enumerable: false, configurable: true });
  return true;
}

/** MAIN world: undo pageHook when the tab is released. */
export function pageUnhook(channel) {
  const h = window['__claudeBridgeHook_' + channel];
  if (h) h.remove();
  return true;
}

/**
 * ISOLATED world: forwards what pageHook sends to the extension, batched, and before the page
 * unloads. Only events on this tab's secret channel name are forwarded.
 */
export function pageRelay(channel) {
  const KEY = '__claudeBridgeRelay_' + channel;
  if (window[KEY]) return true;
  window[KEY] = true;
  let queue = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!queue.length) return;
    const entries = queue;
    queue = [];
    try { chrome.runtime.sendMessage({ type: 'pageEvents', channel, url: location.href, top: window === window.top, entries }).catch(() => {}); } catch (_) { /* extension reloaded */ }
  };
  document.addEventListener(channel, (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 20000) return;
    try { queue.push(JSON.parse(e.detail)); } catch (_) { return; }
    if (queue.length > 200) queue.splice(0, queue.length - 200);
    // dialogs and popups are reported at once: the action that caused them is waiting
    const urgent = queue[queue.length - 1].kind !== 'console';
    if (urgent) { clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, 300);
  });
  window.addEventListener('pagehide', flush);
  return true;
}
