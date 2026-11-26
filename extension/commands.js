// Command handlers invoked by the local MCP server. Each returns { text, images? }.
// No chrome.debugger: input is dispatched as DOM events by content/agent.js, screenshots come from
// chrome.tabs.captureVisibleTab, and pagehook.js watches console output and dialogs in the page.
import { comboEvent, modifierFlags } from './keys.js';
import { pageHook, pageRelay, pageUnhook } from './pagehook.js';

const AGENT_VERSION = 7; // must match VERSION in content/agent.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message || `Timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

let isMac = false;
chrome.runtime.getPlatformInfo().then((p) => { isMac = p.os === 'mac'; }).catch(() => {});

// ------------------------------------------------------------------ sessions & tab ownership
// Every connected Claude session has a context object (created by background.js):
//   { label, color, badge, badgeColor, connected, currentTabId, groups: Map<windowId, groupId>, onChange? }
// Each session works in its own "agent tab"; a tab can be controlled by only one session at a time.

/** tabId -> session ctx that currently controls it */
const tabOwner = new Map();
let options = { groupTabs: true };

export function configure(o) {
  options = { ...options, ...o };
}

export function ownerOf(tabId) {
  return tabOwner.get(tabId) || null;
}

function setTabBadge(tabId, ctx) {
  chrome.action.setBadgeText({ tabId, text: ctx.badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: ctx.badgeColor }).catch(() => {});
  chrome.action.setTitle({ tabId, title: `This tab is controlled by Claude session "${ctx.label}"` }).catch(() => {});
}

function clearTabBadge(tabId) {
  // null resets the tab-specific value back to the global one
  chrome.action.setBadgeText({ tabId, text: null }).catch(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}));
  chrome.action.setTitle({ tabId, title: 'Claude Browser Bridge' }).catch(() => {});
}

// ------------------------------------------------------------------ on-page "controlled by Claude" marker

/** Inject (or refresh) content/indicator.js; it polls the background for who controls the tab. */
function showIndicator(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['content/indicator.js'] }).catch(() => {});
}

function removeIndicator(tabId) {
  chrome.scripting.executeScript({
    target: { tabId }, world: 'ISOLATED', func: () => window.__claudeBridgeIndicator?.remove(),
  }).catch(() => {});
}

/** Hide the marker so it does not show up in screenshots. */
async function setIndicatorHidden(tabId, hidden) {
  await withTimeout(chrome.scripting.executeScript({
    target: { tabId }, world: 'ISOLATED', func: (h) => window.__claudeBridgeIndicator?.setHidden(h), args: [hidden],
  }), 1000, 'indicator').catch(() => {});
}

// ------------------------------------------------------------------ console, dialogs, popups
// Each controlled tab gets pagehook.js in every frame: it records console output, answers
// alert/confirm/prompt (so a dialog never freezes the tab) and reports blocked popups.

const MAX_LOG = 500;
/** tabId -> { channel, console: [], dialogs: [], policy: { next } } */
const tabState = new Map();

function stateFor(tabId) {
  let st = tabState.get(tabId);
  if (!st) {
    const rnd = new Uint8Array(12);
    crypto.getRandomValues(rnd);
    st = { channel: 'claude-bridge-' + [...rnd].map((b) => b.toString(16).padStart(2, '0')).join(''), console: [], dialogs: [], policy: { next: null } };
    tabState.set(tabId, st);
  }
  return st;
}

function pushLog(st, entry) {
  st.console.push(entry);
  if (st.console.length > MAX_LOG) st.console.splice(0, st.console.length - MAX_LOG);
}

/** Inject the console/dialog hook (page world) and its relay (extension world). */
async function instrument(tabId, frameId) {
  const st = stateFor(tabId);
  const target = frameId == null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  await Promise.all([
    chrome.scripting.executeScript({ target, world: 'ISOLATED', injectImmediately: true, func: pageRelay, args: [st.channel] }),
    chrome.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, func: pageHook, args: [st.channel, st.policy] }),
  ]).catch(() => { /* restricted page, error page, frame gone */ });
}

function uninstrument(tabId) {
  const st = tabState.get(tabId);
  if (!st) return;
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: pageUnhook, args: [st.channel] }).catch(() => {});
}

// Hook each new document of a controlled tab as early as possible.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (!tabOwner.has(d.tabId)) return;
  instrument(d.tabId, d.frameId);
  if (d.frameId === 0) pushLog(stateFor(d.tabId), { time: Date.now(), level: 'navigation', text: `Navigated to ${d.url}`, source: '' });
});

/** Messages from pageRelay (routed here by background.js). */
export async function onPageEvents(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const st = tabId != null ? tabState.get(tabId) : null;
  if (!st || msg.channel !== st.channel || !Array.isArray(msg.entries)) return { ok: false };
  for (const e of msg.entries.slice(0, 200)) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'console') {
      pushLog(st, { time: Number(e.time) || Date.now(), level: String(e.level || 'log'), text: String(e.text || '').slice(0, 10000), source: String(e.source || '') });
    } else if (e.kind === 'dialog') {
      const d = { time: Date.now(), type: String(e.type), message: String(e.message || '').slice(0, 2000), accepted: !!e.accepted, promptText: e.promptText, preset: !!e.preset, frame: msg.top ? '' : String(msg.url || '') };
      st.dialogs.push(d);
      if (st.dialogs.length > 20) st.dialogs.shift();
      if (e.preset) st.policy = { next: null };
      pushLog(st, { time: d.time, level: 'dialog', text: `${d.type}("${d.message}") -> ${d.accepted ? 'OK' : 'Cancel'}`, source: String(msg.url || '') });
    } else if (e.kind === 'popup' && tabOwner.has(tabId) && /^https?:/i.test(String(e.url))) {
      // window.open from a synthetic click is blocked by Chrome; open the page in a tab instead.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) await openFrom(tab, String(e.url), true);
    }
  }
  return { ok: true };
}

function dialogNote(d) {
  const where = d.frame ? ` (in frame ${d.frame})` : '';
  if (d.type === 'alert') return `The page showed an alert${where}: "${d.message}" (closed with OK).`;
  if (d.preset) return `The page showed a ${d.type} dialog${where}: "${d.message}". It was answered as you asked with handle_dialog: ${d.accepted ? 'OK' : 'Cancel'}${d.type === 'prompt' && d.accepted ? ` with "${d.promptText}"` : ''}.`;
  return `The page showed a ${d.type} dialog${where}: "${d.message}". It was answered Cancel, so nothing it asked for happened. To answer OK, call handle_dialog with accept: true${d.type === 'prompt' ? ' (and promptText)' : ''}, then repeat the action.`;
}

// A navigation wipes the page, so re-add the marker once the new page has loaded.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && tabOwner.has(tabId)) showIndicator(tabId);
});

function setAgentTab(ctx, tabId) {
  if (ctx.currentTabId === tabId) return;
  const old = ctx.currentTabId;
  if (old != null && tabOwner.get(old) === ctx) {
    tabOwner.delete(old);
    clearTabBadge(old);
    removeIndicator(old);
    uninstrument(old);
  }
  ctx.currentTabId = tabId;
  if (tabId != null) {
    const prev = tabOwner.get(tabId);
    if (prev && prev !== ctx) {
      prev.currentTabId = null;
      if (prev.onChange) prev.onChange();
    }
    tabOwner.set(tabId, ctx);
    setTabBadge(tabId, ctx);
    showIndicator(tabId);
    instrument(tabId);
  }
  if (ctx.onChange) ctx.onChange();
}

/** Tabs some session controls right now. */
export function controlledTabIds() {
  return [...tabOwner.keys()];
}

/** "Release all tabs" in the popup: every session lets go of its tab, and the pages go back to normal. */
export function releaseAllTabs() {
  const owners = new Set(tabOwner.values());
  const n = tabOwner.size;
  for (const ctx of owners) setAgentTab(ctx, null);
  return n;
}

/** Called when a session disconnects: its tab becomes free again. */
export function releaseSession(ctx) {
  ctx.connected = false;
  setAgentTab(ctx, null);
}

// Put tabs a session opens into a coloured tab group named after the session.
async function groupTab(ctx, tab) {
  if (!options.groupTabs || !chrome.tabGroups) return;
  try {
    let gid = ctx.groups.get(tab.windowId);
    if (gid != null) {
      try { await chrome.tabGroups.get(gid); } catch (_) { gid = null; }
    }
    gid = await chrome.tabs.group(gid != null ? { tabIds: tab.id, groupId: gid } : { tabIds: tab.id, createProperties: { windowId: tab.windowId } });
    ctx.groups.set(tab.windowId, gid);
    await chrome.tabGroups.update(gid, { title: `Claude · ${ctx.label}`, color: ctx.color, collapsed: false });
  } catch (_) { /* e.g. popup windows can't hold groups */ }
}

function otherOwner(ctx, tabId) {
  const o = tabOwner.get(tabId);
  return o && o !== ctx && o.connected ? o : null;
}

// Track tabs opened by pages (target=_blank, window.open) so actions can report them.
const recentCreated = [];
chrome.tabs.onCreated.addListener((t) => {
  recentCreated.push({ id: t.id, opener: t.openerTabId, at: Date.now(), url: t.pendingUrl || t.url || '' });
  while (recentCreated.length && Date.now() - recentCreated[0].at > 120000) recentCreated.shift();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const owner = tabOwner.get(tabId);
  if (owner) {
    tabOwner.delete(tabId);
    if (owner.currentTabId === tabId) owner.currentTabId = null;
    if (owner.onChange) owner.onChange();
  }
  refCounters.delete(tabId);
  tabState.delete(tabId);
});

/** Open a page in a new tab next to `tab`, on behalf of that tab (settle() reports it). */
async function openFrom(tab, url, active) {
  const t = await chrome.tabs.create({ url, openerTabId: tab.id, index: tab.index + 1, active }).catch(() => null);
  // Chrome sets openerTabId on extension-created tabs only after onCreated, so record it here.
  if (t) {
    const rec = recentCreated.find((r) => r.id === t.id);
    if (rec) rec.opener = tab.id;
    else recentCreated.push({ id: t.id, opener: tab.id, at: Date.now(), url });
  }
  return t;
}

/** tabId -> highest element ref number issued (refs stay unique across navigations). */
const refCounters = new Map();

// ------------------------------------------------------------------ helpers

const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|chrome-extension|chrome-untrusted|chrome-search|devtools|view-source|extension):/i;
const WEBSTORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

function tabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

function checkScriptable(tab) {
  const url = tabUrl(tab);
  if (RESTRICTED.test(url) || WEBSTORE.test(url)) {
    throw new Error(`Chrome does not allow extensions to control ${url}. Navigate this tab to a regular web page (or use another tab).`);
  }
}

function summary(tab) {
  return `[tab ${tab.id}] ${tab.title || '(no title)'} — ${tabUrl(tab)}`;
}

async function resolveTab(ctx, tabId, { takeOver = false } = {}) {
  if (tabId != null) {
    let tab;
    try { tab = await chrome.tabs.get(Number(tabId)); } catch (_) {
      throw new Error(`Tab ${tabId} does not exist. Call tabs_list to see open tabs.`);
    }
    const o = otherOwner(ctx, tab.id);
    if (o && !takeOver) {
      throw new Error(
        `Tab ${tab.id} is being controlled by another Claude session ("${o.label}"). ` +
        'Open your own tab with tab_new, or call tab_select with takeOver: true only if the user asked you to take that tab over.',
      );
    }
    setAgentTab(ctx, tab.id);
    return tab;
  }
  if (ctx.currentTabId != null) {
    try { return await chrome.tabs.get(ctx.currentTabId); } catch (_) { setAgentTab(ctx, null); }
  }
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true });
  if (!tab) throw new Error('No open tab found. Use tab_new to open one.');
  const o = otherOwner(ctx, tab.id);
  if (o) {
    throw new Error(`This session has no tab yet, and the active tab is being controlled by another Claude session ("${o.label}"). Use tab_new to open your own tab (or tabs_list + tab_select).`);
  }
  setAgentTab(ctx, tab.id);
  return tab;
}

function friendlyScriptError(e, tab) {
  const msg = e?.message || String(e);
  if (/Cannot access|cannot be scripted|Missing host permission/i.test(msg)) {
    return new Error(`Cannot access this page (${tabUrl(tab)}): ${msg}. Chrome blocks extensions on some pages (chrome://, the Web Store, other extensions; file:// needs "Allow access to file URLs").`);
  }
  if (/showing error page/i.test(msg)) return new Error(`The tab is showing a browser error page (${tabUrl(tab)}); the page failed to load.`);
  if (/No tab with id|Frame with ID 0 was removed|The tab was closed/i.test(msg)) return new Error('The tab navigated or closed during the operation; try again.');
  return e instanceof Error ? e : new Error(msg);
}

/** Run a method of the in-page helper (content/agent.js) in one frame of the tab (default: top). */
async function page(tab, method, args = {}, timeoutMs = 15000, frameId = 0) {
  checkScriptable(tab);
  const target = { tabId: tab.id, frameIds: [frameId] };
  const run = () => chrome.scripting.executeScript({
    target,
    world: 'ISOLATED',
    func: (m, a, v, c) => {
      const b = window.__claudeBridge;
      if (!b || b.version !== v) return { missing: true };
      return b.call(m, a, c);
    },
    args: [method, args, AGENT_VERSION, refCounters.get(tab.id) || 0],
  });
  try {
    let [res] = await withTimeout(run(), timeoutMs, 'Page did not respond');
    if (res && res.result && res.result.missing) {
      await withTimeout(
        chrome.scripting.executeScript({ target, world: 'ISOLATED', files: ['content/agent.js'] }),
        timeoutMs, 'Page did not respond',
      );
      [res] = await withTimeout(run(), timeoutMs, 'Page did not respond');
    }
    const r = res && res.result;
    if (!r) throw new Error('The page returned no result (it may be navigating). Try again.');
    if (r.missing) throw new Error('Could not inject the page helper. Try again.');
    if (typeof r.counter === 'number' && r.counter > (refCounters.get(tab.id) || 0)) refCounters.set(tab.id, r.counter);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  } catch (e) {
    if (/Page did not respond/.test(e.message)) {
      throw new Error(`The page did not respond within ${timeoutMs} ms (it may be busy or frozen).`);
    }
    throw friendlyScriptError(e, tab);
  }
}

/**
 * Run an input method of the page helper; when the point (or the focused element) is inside a
 * cross-origin iframe, repeat it inside that frame, with the point translated to the frame.
 */
async function framePage(tab, method, args = {}, timeoutMs = 15000) {
  let frameId = 0;
  let a = args;
  for (let depth = 0; depth < 6; depth++) {
    const r = await page(tab, method, a, timeoutMs, frameId);
    if (!r || !r.frame) return r;
    const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) || [];
    const kids = frames.filter((f) => f.parentFrameId === frameId);
    const src = String(r.frame.src || '');
    const pick = kids.find((f) => f.url === src) || kids.find((f) => src && f.url.split('#')[0] === src.split('#')[0]) ||
      kids.find((f) => { try { return new URL(f.url).origin === new URL(src).origin; } catch (_) { return false; } }) ||
      (kids.length === 1 ? kids[0] : null);
    if (!pick) throw new Error(`The target is inside a cross-origin frame (${src || 'no src'}) that could not be matched to a frame of this tab.`);
    frameId = pick.frameId;
    a = r.frame.x != null ? { ...args, x: r.frame.x, y: r.frame.y } : args;
  }
  throw new Error('Frames are nested too deeply.');
}

async function waitForLoad(tabId, timeoutMs = 30000, { expectNavigation = true } = {}) {
  const start = Date.now();
  let sawLoading = false;
  let tab = null;
  while (Date.now() - start < timeoutMs) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('The tab was closed.');
    if (tab.status === 'loading') sawLoading = true;
    else if (tab.status === 'complete' && (sawLoading || !expectNavigation || Date.now() - start > 1500)) {
      return { ok: true, tab };
    }
    await sleep(100);
  }
  return { ok: false, timeout: true, tab };
}

/** After an action: wait for a possible navigation and report what changed. */
async function settle(tabId, since, urlBefore) {
  await sleep(250);
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return 'The tab was closed by the page.';
  const notes = [];
  if (tab.status === 'loading') {
    const r = await waitForLoad(tabId, 15000, { expectNavigation: false });
    tab = r.tab || tab;
    if (r.timeout) notes.push('Page is still loading (waited 15 s).');
  }
  const st = tabState.get(tabId);
  if (st) for (const d of st.dialogs.filter((x) => x.time >= since)) notes.push(dialogNote(d));
  const opened = recentCreated.filter((r) => r.at >= since && r.opener === tabId);
  for (const o of opened) {
    const t = await chrome.tabs.get(o.id).catch(() => null);
    if (t) notes.push(`The page opened a new tab ${summary(t)} — call tab_select with tabId ${t.id} to work in it.`);
  }
  if (urlBefore && tabUrl(tab) !== urlBefore) notes.push(`Navigated to ${tabUrl(tab)}`);
  notes.push(`Current page: ${summary(tab)}`);
  return notes.join('\n');
}

/**
 * Back/forward through the page's own history. chrome.tabs.goBack skips entries of pages that
 * never had a real user gesture, which is every page Claude visits (its input is synthetic).
 */
async function historyGo(tab, delta) {
  let res = null;
  try {
    [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'ISOLATED',
      func: (d) => {
        // Navigation API (Chrome 102+) says whether there is an entry to go to.
        const nav = window.navigation;
        if (nav && (d < 0 ? !nav.canGoBack : !nav.canGoForward)) return false;
        history.go(d);
        return true;
      },
      args: [delta],
    });
  } catch (_) {
    res = null; // restricted page: use the browser's own back/forward
  }
  if (res && res.result === false) throw new Error(`Cannot find a ${delta < 0 ? 'previous' : 'next'} page in history.`);
  if (!res) await (delta < 0 ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id));
}

function normalizeUrl(url) {
  const u = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^(localhost|127\.|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
  return 'https://' + u;
}

async function targetPoint(tab, { ref, selector, x, y }, label = 'target') {
  if (ref || selector) {
    const p = await page(tab, 'point', { ref, selector });
    return { x: p.x, y: p.y, warning: p.warning, description: p.description, editable: p.editable };
  }
  if (x != null && y != null) return { x: Number(x), y: Number(y), description: `point (${x}, ${y})` };
  throw new Error(`Provide the ${label} as "ref" (from snapshot/find), "selector", or "x" and "y" coordinates.`);
}

// ------------------------------------------------------------------ images

function bytesToB64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

// ------------------------------------------------------------------ handlers

const handlers = {
  async tabs_list(_params, ctx) {
    const windows = await chrome.windows.getAll({ populate: true });
    const lines = [];
    for (const w of windows) {
      lines.push(`Window ${w.id}${w.focused ? ' (focused)' : ''}${w.incognito ? ' (incognito)' : ''} [${w.type}, ${w.state}]`);
      for (const t of w.tabs || []) {
        const flags = [];
        if (t.active) flags.push('active');
        if (t.id === ctx.currentTabId) flags.push('YOUR AGENT TAB');
        else if (otherOwner(ctx, t.id)) flags.push(`controlled by other Claude session "${otherOwner(ctx, t.id).label}"`);
        if (t.status === 'loading') flags.push('loading');
        if (t.pinned) flags.push('pinned');
        if (t.audible) flags.push('audible');
        if (t.discarded) flags.push('discarded');
        lines.push(`  ${summary(t)}${flags.length ? '  {' + flags.join(', ') + '}' : ''}`);
      }
    }
    lines.push('', 'Commands without tabId act on YOUR AGENT TAB (the last tab you opened/selected/used; initially the active tab). Tabs controlled by other Claude sessions are off-limits.');
    return { text: lines.join('\n') };
  },

  async tab_new({ url, active = true, newWindow = false } = {}, ctx) {
    const target = url ? normalizeUrl(url) : 'about:blank';
    let tab;
    if (newWindow) {
      const w = await chrome.windows.create({ url: target, focused: active });
      tab = w.tabs[0];
    } else {
      tab = await chrome.tabs.create({ url: target, active });
    }
    setAgentTab(ctx, tab.id);
    await groupTab(ctx, tab);
    let note = '';
    if (url) {
      const r = await waitForLoad(tab.id, 30000);
      tab = r.tab || tab;
      if (r.timeout) note = '\n(Page still loading after 30 s.)';
    }
    return { text: `Opened ${summary(tab)}. It is now the agent tab.${note}` };
  },

  async tab_select({ tabId, activate = true, focusWindow = false, takeOver = false } = {}, ctx) {
    if (tabId == null) throw new Error('tabId is required (see tabs_list).');
    const tab = await resolveTab(ctx, tabId, { takeOver });
    if (activate) await chrome.tabs.update(tab.id, { active: true });
    if (focusWindow) await chrome.windows.update(tab.windowId, { focused: true });
    return { text: `Agent tab is now ${summary(tab)}${activate ? ' (activated)' : ''}.` };
  },

  async tab_close({ tabId } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    await chrome.tabs.remove(tab.id);
    if (ctx.currentTabId === tab.id) setAgentTab(ctx, null);
    return { text: `Closed ${summary(tab)}.` };
  },

  async navigate({ url, tabId, timeoutMs = 30000 } = {}, ctx) {
    if (!url) throw new Error('url is required (or "back", "forward", "reload").');
    let tab = await resolveTab(ctx, tabId);
    const since = Date.now();
    const cmd = String(url).toLowerCase();
    const before = tabUrl(tab);
    try {
      if (cmd === 'back' || cmd === 'forward') await historyGo(tab, cmd === 'back' ? -1 : 1);
      else if (cmd === 'reload') await chrome.tabs.reload(tab.id);
      else await chrome.tabs.update(tab.id, { url: normalizeUrl(url) });
    } catch (e) {
      throw new Error(`Navigation failed: ${e.message}`);
    }
    const r = await waitForLoad(tab.id, timeoutMs, { expectNavigation: cmd !== 'back' && cmd !== 'forward' });
    tab = r.tab || tab;
    const notes = [];
    if (r.timeout) notes.push(`Page still loading after ${timeoutMs} ms (continuing anyway).`);
    const st = tabState.get(tab.id);
    if (st) for (const d of st.dialogs.filter((x) => x.time >= since)) notes.push(dialogNote(d));
    const opened = recentCreated.filter((o) => o.at >= since && o.opener === tab.id);
    if (opened.length) notes.push(`Page opened ${opened.length} new tab(s).`);
    if (cmd === 'back' || cmd === 'forward') {
      if (tabUrl(tab) === before) notes.push('URL unchanged (no history entry, or same-document navigation).');
    }
    return { text: `Loaded ${summary(tab)}${notes.length ? '\n' + notes.join('\n') : ''}` };
  },

  async screenshot({ tabId, format = 'jpeg', quality = 80, fullPage = false, ref, selector, maxDimension = 1568 } = {}, ctx) {
    let tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    const fmt = format === 'png' ? 'png' : 'jpeg';
    const mime = 'image/' + fmt;
    const q = Math.max(1, Math.min(100, quality));
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win && win.state === 'minimized') {
      throw new Error('The Chrome window with this tab is minimized, so Chrome has nothing to capture. Restore the window (or call tab_select with focusWindow: true), then take the screenshot.');
    }
    // Chrome only draws the active tab of a window: switch to it briefly when it is in the background.
    let restoreTab = null;
    if (!tab.active) {
      const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      restoreTab = prev && prev.id !== tab.id ? prev.id : null;
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(400);
    }
    await setIndicatorHidden(tab.id, true);
    let mode = 'viewport', originNote = '', cssW, cssH, canvas, scale;
    try {
      const info = await page(tab, 'scrollInfo');
      const vw = info.viewportWidth, vh = info.viewportHeight;
      const limitFor = (w, h, full) => {
        const longest = Math.max(w, h);
        const limit = full ? Math.max(maxDimension, 8000) : maxDimension;
        let k = longest > limit ? limit / longest : 1;
        if (full && w * k > maxDimension) k = Math.min(k, maxDimension / w);
        return k;
      };
      if (ref || selector) {
        const r = await page(tab, 'rect', { ref, selector });
        await sleep(120);
        const bmp = await captureBitmap(tab.windowId);
        const k = bmp.width / vw; // device pixels per CSS px
        const x1 = Math.max(0, r.x), y1 = Math.max(0, r.y);
        const x2 = Math.min(vw, r.x + r.width), y2 = Math.min(vh, r.y + r.height);
        if (x2 <= x1 || y2 <= y1) { bmp.close(); throw new Error(`Element ${r.description} is not inside the viewport.`); }
        cssW = Math.ceil(x2 - x1); cssH = Math.ceil(y2 - y1);
        scale = limitFor(cssW, cssH, false);
        canvas = new OffscreenCanvas(Math.max(1, Math.round(cssW * scale)), Math.max(1, Math.round(cssH * scale)));
        draw(canvas, bmp, x1 * k, y1 * k, (x2 - x1) * k, (y2 - y1) * k, 0, 0, canvas.width, canvas.height, fmt);
        bmp.close();
        mode = 'element';
        originNote = ` Element ${r.description} at viewport (${Math.round(r.x)}, ${Math.round(r.y)}); image (0,0) = viewport (${Math.round(x1)}, ${Math.round(y1)}).`;
        if (r.height > cssH + 1 || r.width > cssW + 1) originNote += ` Only the part inside the viewport (${cssW}x${cssH} of ${Math.round(r.width)}x${Math.round(r.height)}) is captured.`;
      } else if (fullPage) {
        cssW = vw;
        cssH = Math.min(info.height, 16000);
        scale = limitFor(cssW, cssH, true);
        canvas = new OffscreenCanvas(Math.max(1, Math.round(cssW * scale)), Math.max(1, Math.round(cssH * scale)));
        const start = { x: info.x, y: info.y };
        let hidden = false;
        try {
          for (let y = 0, i = 0; i < 60; i++) {
            const pos = await page(tab, 'scrollToXY', { x: 0, y });
            if (i === 1) { await page(tab, 'hideFixed'); hidden = true; } // keep sticky headers in the first slice only
            await sleep(150);
            const bmp = await captureBitmap(tab.windowId);
            const top = Math.min(pos.y, cssH);
            const h = Math.min(vh, cssH - top);
            if (h > 0) draw(canvas, bmp, 0, 0, bmp.width, (bmp.height * h) / vh, 0, top * scale, cssW * scale, h * scale, fmt);
            bmp.close();
            if (pos.y + vh >= cssH || (i > 0 && pos.y < y)) break; // reached the end (or the page can't scroll further)
            y = pos.y + vh;
          }
        } finally {
          if (hidden) await page(tab, 'restoreFixed').catch(() => {});
          await page(tab, 'scrollToXY', start).catch(() => {});
        }
        mode = 'full page';
        originNote = ` Image coordinates are document coordinates (current scroll ${Math.round(start.x)},${Math.round(start.y)}), not viewport coordinates. Fixed and sticky elements appear only at the top.`;
      } else {
        cssW = vw; cssH = vh;
        scale = limitFor(cssW, cssH, false);
        const bmp = await captureBitmap(tab.windowId);
        canvas = new OffscreenCanvas(Math.max(1, Math.round(cssW * scale)), Math.max(1, Math.round(cssH * scale)));
        draw(canvas, bmp, 0, 0, bmp.width, bmp.height, 0, 0, canvas.width, canvas.height, fmt);
        bmp.close();
      }
    } finally {
      setIndicatorHidden(tab.id, false);
      if (restoreTab != null) await chrome.tabs.update(restoreTab, { active: true }).catch(() => {});
    }
    const blob = await canvas.convertToBlob({ type: mime, quality: q / 100 });
    const data = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
    tab = await chrome.tabs.get(tab.id).catch(() => tab);
    let coordNote;
    if (scale === 1) coordNote = 'Image pixels = CSS pixels.';
    else coordNote = `Image is scaled by ${scale.toFixed(4)}: divide image coordinates by ${scale.toFixed(4)} (i.e. multiply by ${(1 / scale).toFixed(4)}) to get CSS pixels.`;
    if (mode === 'viewport') coordNote += ' Coordinates are viewport coordinates usable for click/hover x,y.';
    return {
      text: `Screenshot (${mode}) of ${summary(tab)}. Image ${canvas.width}x${canvas.height}, area ${cssW}x${cssH} CSS px. ${coordNote}${originNote}\nPrefer refs from snapshot/find over coordinates when possible.`,
      images: [{ data, mimeType: mime }],
    };
  },

  async snapshot({ tabId, interactiveOnly = false, viewportOnly = false, maxChars = 25000, ref, selector } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    const text = await page(tab, 'snapshot', { interactiveOnly, viewportOnly, maxChars, ref, selector }, 30000);
    return { text: `[tab ${tab.id}] ` + text };
  },

  async find({ query, tabId, limit = 20 } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    return { text: await page(tab, 'find', { query, limit }, 30000) };
  },

  async get_text({ tabId, ref, selector, offset = 0, maxChars = 20000 } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    return { text: await page(tab, 'getText', { ref, selector, offset, maxChars }, 30000) };
  },

  async click({ tabId, ref, selector, x, y, button = 'left', doubleClick = false, clickCount, modifiers = [] } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const pt = await targetPoint(tab, { ref, selector, x, y });
    const r = await framePage(tab, 'clickAt', {
      x: pt.x, y: pt.y, button, clickCount: clickCount || (doubleClick ? 2 : 1), modifiers: modifierFlags(modifiers),
    });
    if (r && r.link) {
      // The page helper cancelled a link's own navigation (see fireClick in content/agent.js): a
      // new tab would be blocked, and a same-tab one would leave a skippable history entry.
      if (r.link.newTab) await openFrom(tab, r.link.url, r.link.active);
      else await chrome.tabs.update(tab.id, { url: r.link.url });
    }
    const after = await settle(tab.id, since, urlBefore);
    return {
      text: `Clicked ${pt.description} at (${Math.round(pt.x)}, ${Math.round(pt.y)}).` +
        (pt.warning ? `\nWarning: ${pt.warning}` : '') + '\n' + after,
    };
  },

  async hover({ tabId, ref, selector, x, y } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    const pt = await targetPoint(tab, { ref, selector, x, y });
    await framePage(tab, 'hoverAt', { x: pt.x, y: pt.y });
    await sleep(300);
    return { text: `Hovering over ${pt.description} at (${Math.round(pt.x)}, ${Math.round(pt.y)}).${pt.warning ? '\nWarning: ' + pt.warning : ''}` };
  },

  async drag({ tabId, fromRef, fromSelector, fromX, fromY, toRef, toSelector, toX, toY } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const a = await targetPoint(tab, { ref: fromRef, selector: fromSelector, x: fromX, y: fromY }, 'drag source');
    const b = await targetPoint(tab, { ref: toRef, selector: toSelector, x: toX, y: toY }, 'drop target');
    // Source may have moved if the destination scrolled; recompute when using refs.
    const a2 = fromRef || fromSelector ? await page(tab, 'point', { ref: fromRef, selector: fromSelector, scroll: false }).catch(() => a) : a;
    const r = await page(tab, 'dragAt', { from: { x: a2.x, y: a2.y }, to: { x: b.x, y: b.y } }, 30000);
    const how = r.html5 ? (r.dropped ? ' (HTML drag and drop; the target accepted the drop)' : ' (HTML drag and drop; the target did not accept the drop)') : '';
    return { text: `Dragged ${a.description} to ${b.description}${how}.\n` + (await settle(tab.id, since, urlBefore)) };
  },

  async type({ tabId, text, ref, selector, clear = false, submit = false, slowly = false } = {}, ctx) {
    if (typeof text !== 'string') throw new Error('text is required.');
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const selectAll = isMac ? 'Meta+a' : 'Control+a';
    let desc = 'the focused element';
    if (ref || selector) {
      const f = await page(tab, 'focus', { ref, selector, clear });
      if (!f.focused) {
        // Not directly focusable (e.g. a wrapper) – click it like a user would.
        const pt = await targetPoint(tab, { ref, selector });
        await framePage(tab, 'clickAt', { x: pt.x, y: pt.y });
        await sleep(100);
        if (clear) { await pressCombo(tab, selectAll); await pressCombo(tab, 'Backspace'); }
      } else if (clear && f.hasValue) {
        await pressCombo(tab, selectAll);
        await pressCombo(tab, 'Backspace');
      }
      desc = f.description;
    } else if (clear) {
      await pressCombo(tab, selectAll);
      await pressCombo(tab, 'Backspace');
    }
    let note = '';
    if (text.length) {
      const r = await framePage(tab, 'typeText', { text, slowly }, 120000);
      if (r && r.editable === false) note = '\nNote: the focused element is not a text field, so only key events were sent.';
    }
    if (submit) await pressCombo(tab, 'Enter');
    const after = await settle(tab.id, since, urlBefore);
    return { text: `Typed ${text.length} character(s) into ${desc}${submit ? ' and pressed Enter' : ''}.${note}\n${after}` };
  },

  async press_key({ tabId, keys, repeat = 1 } = {}, ctx) {
    if (!keys) throw new Error('keys is required, e.g. "Enter", "Escape", "Control+A", "Shift+Tab".');
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const list = Array.isArray(keys) ? keys : [keys];
    const notes = new Set();
    for (let i = 0; i < Math.max(1, Math.min(repeat, 200)); i++) {
      for (const k of list) { const n = await pressCombo(tab, k); if (n) notes.add(n); }
    }
    return { text: `Pressed ${list.join(', ')}${repeat > 1 ? ` x${repeat}` : ''}${notes.size ? ` (${[...notes].join('; ')})` : ''}.\n` + (await settle(tab.id, since, urlBefore)) };
  },

  async select_option({ tabId, ref, selector, values } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const selected = await page(tab, 'selectOption', { ref, selector, values });
    return { text: `Selected: ${selected.join(', ')}\n` + (await settle(tab.id, since, urlBefore)) };
  },

  async scroll({ tabId, deltaX, deltaY, ref, selector, x, y } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    if ((ref || selector) && deltaX == null && deltaY == null) {
      const d = await page(tab, 'scrollIntoView', { ref, selector });
      const info = await page(tab, 'scrollInfo');
      return { text: `Scrolled ${d} into view. Page scroll is now ${info.x},${info.y} of ${info.width}x${info.height}.` };
    }
    const before = await page(tab, 'scrollInfo');
    let px = before.viewportWidth / 2, py = before.viewportHeight / 2;
    if (ref || selector) {
      const p = await page(tab, 'point', { ref, selector, scroll: false });
      px = p.x; py = p.y;
    } else if (x != null && y != null) {
      px = Number(x); py = Number(y);
    }
    const dx = Number(deltaX || 0);
    const dy = deltaY == null && deltaX == null ? Math.round(before.viewportHeight * 0.8) : Number(deltaY || 0);
    const r = await framePage(tab, 'wheelAt', { x: px, y: py, dx, dy });
    await sleep(200);
    const after = await page(tab, 'scrollInfo');
    let text = `Scrolled by (${dx}, ${dy}) at (${Math.round(px)}, ${Math.round(py)}). Page scroll is now ${after.x},${after.y} of ${after.width}x${after.height} (viewport ${after.viewportWidth}x${after.viewportHeight}).`;
    if (r && r.prevented) text += ' The page handled the wheel event itself (e.g. a map, carousel or custom scroller).';
    else if (r && r.scrolled && r.scrolled !== 'page') text += ` The scrollable area ${r.scrolled} scrolled.`;
    else if (after.x === before.x && after.y === before.y) text += ' Nothing moved: the page (and any scroll area under that point) is already at its edge.';
    return { text };
  },

  async evaluate({ tabId, expression, timeoutMs = 30000 } = {}, ctx) {
    if (!expression) throw new Error('expression is required.');
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    const out = await runInPage(tab.id, String(expression), timeoutMs);
    return { text: out && out.length > 50000 ? out.slice(0, 50000) + `\n… [truncated, ${out.length} chars total]` : out };
  },

  async wait_for({ tabId, text, textGone, selector, selectorGone, time, timeoutMs = 15000 } = {}, ctx) {
    if (text == null && textGone == null && selector == null && selectorGone == null) {
      const ms = Math.max(0, Math.min(Number(time ?? 1000), 60000));
      await sleep(ms);
      return { text: `Waited ${ms} ms.` };
    }
    const tab = await resolveTab(ctx, tabId);
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const t = await chrome.tabs.get(tab.id);
        if (await page(t, 'check', { text, textGone, selector, selectorGone }, 5000)) {
          return { text: `Condition met after ${Date.now() - start} ms.\nCurrent page: ${summary(t)}` };
        }
        lastErr = null;
      } catch (e) {
        if (/dialog is open/.test(e.message)) throw e;
        lastErr = e; // page may be navigating
      }
      await sleep(250);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${JSON.stringify({ text, textGone, selector, selectorGone })}.${lastErr ? ' Last error: ' + lastErr.message : ''}`);
  },

  async console_messages({ tabId, level, clear = false, limit = 100 } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    const existed = tabState.has(tab.id) && tabState.get(tab.id).console.length > 0;
    const st = stateFor(tab.id);
    let msgs = st.console;
    if (level) {
      const lv = String(level).toLowerCase();
      msgs = msgs.filter((m) => m.level === lv || (lv === 'error' && (m.level === 'exception' || m.level === 'error')) || (lv === 'warn' && m.level === 'warning'));
    }
    const shown = msgs.slice(-limit);
    const lines = shown.map((m) => {
      const t = new Date(m.time > 1e12 ? m.time : Date.now()).toISOString().slice(11, 23);
      return `[${t}] ${m.level}: ${m.text}${m.source ? `  (${m.source})` : ''}`;
    });
    if (clear) st.console.length = 0;
    let head = `${shown.length} of ${msgs.length} message(s) for ${summary(tab)}`;
    if (!existed && !shown.length) head += '\nCapture starts when a session takes the tab; messages logged before that are not available. Reproduce the action, then call again.';
    return { text: head + (lines.length ? '\n' + lines.join('\n') : '') };
  },

  async handle_dialog({ tabId, accept = true, promptText } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    const st = stateFor(tab.id);
    st.policy = { next: { accept: !!accept, promptText: promptText != null ? String(promptText) : null } };
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, world: 'MAIN', func: pageHook, args: [st.channel, st.policy],
    }).catch(() => {});
    const how = accept ? `OK${promptText != null ? ` with "${promptText}"` : ''}` : 'Cancel';
    const last = st.dialogs[st.dialogs.length - 1];
    let text = `The next alert/confirm/prompt on this tab will be answered ${how}.`;
    if (last && !last.preset && last.type !== 'alert' && Date.now() - last.time < 120000) {
      text = `The ${last.type} "${last.message}" was already answered Cancel when it appeared (dialogs never stay open, so they can't freeze the tab). ` +
        `The next one will be answered ${how}: repeat the action that showed it.`;
    }
    return { text };
  },

  // Reload an UNPACKED extension from disk (turn it off and on), e.g. after
  // its source was edited. Packed (store) extensions and this bridge itself
  // are refused. Without name/id, lists the unpacked extensions.
  async extension_reload({ name, id } = {}) {
    if (!chrome.management) throw new Error('This bridge extension lacks the "management" permission — reload it on chrome://extensions once.');
    const all = (await chrome.management.getAll()).filter((e) => e.type === 'extension' && e.id !== chrome.runtime.id);
    const unpacked = all.filter((e) => e.installType === 'development');
    const list = (arr) => arr.map((e) => `- ${e.name} v${e.version} (${e.id})${e.enabled ? '' : ' [disabled]'}`).join('\n') || '(none)';
    if (!name && !id) return { text: `Unpacked extensions that can be reloaded:\n${list(unpacked)}` };
    const want = String(name || '').toLowerCase();
    const match = all.filter((e) => (id && e.id === id) || (!id && e.name.toLowerCase().includes(want)));
    if (!match.length) throw new Error(`No extension matches ${id ? `id "${id}"` : `"${name}"`}. Unpacked extensions:\n${list(unpacked)}`);
    if (match.length > 1) throw new Error(`Several extensions match "${name}" — pass id:\n${list(match)}`);
    const ext = match[0];
    if (ext.installType !== 'development') throw new Error(`"${ext.name}" is not an unpacked extension (${ext.installType}); only unpacked extensions are reloaded.`);
    if (ext.enabled) await chrome.management.setEnabled(ext.id, false);
    await chrome.management.setEnabled(ext.id, true);
    const now = await chrome.management.get(ext.id);
    return { text: `Reloaded "${now.name}" v${now.version} (${now.id}) from disk${now.enabled ? '' : ' — but it is now DISABLED (check chrome://extensions for errors)'}.\nTabs it already injected into still run the old content scripts: reload those tabs (navigate "reload") to use the new code.` };
  },

  async upload_file({ tabId, ref, selector, paths, files } = {}, ctx) {
    const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
    if (!list.length) throw new Error('paths (absolute file paths on this computer) is required.');
    if (!Array.isArray(files) || !files.length) {
      throw new Error('This bridge server is too old to send file contents. Update it (run the setup command again) and restart Claude Code.');
    }
    const tab = await resolveTab(ctx, tabId);
    const since = Date.now();
    const r = await page(tab, 'setFiles', { ref, selector, files }, 60000);
    return { text: `Set ${r.names.length} file(s) on ${r.description}: ${list.join(', ')}\n` + (await settle(tab.id, since, null)) };
  },
};

/** Press a key or combo in the focused element (forwarded into cross-origin frames). */
async function pressCombo(tab, combo) {
  const r = await framePage(tab, 'pressKey', comboEvent(combo));
  return r && r.note ? r.note : '';
}

// ------------------------------------------------------------------ screenshots

let lastCapture = 0;

/** captureVisibleTab of the window's active tab, as an ImageBitmap (Chrome allows ~2 captures per second). */
async function captureBitmap(windowId) {
  const wait = lastCapture + 550 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCapture = Date.now();
  let url;
  try {
    url = await withTimeout(chrome.tabs.captureVisibleTab(windowId, { format: 'png' }), 15000, 'capture timed out');
  } catch (e) {
    const msg = e?.message || String(e);
    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(msg)) {
      await sleep(1000);
      lastCapture = Date.now();
      url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } else if (/timed out/.test(msg)) {
      throw new Error('Chrome did not draw the page in time. If the Chrome window is hidden behind other windows or on a locked screen, bring it to the front and try again.');
    } else {
      throw new Error(`Screenshot failed: ${msg}`);
    }
  }
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob);
}

function draw(canvas, bmp, sx, sy, sw, sh, dx, dy, dw, dh, fmt) {
  const c = canvas.getContext('2d');
  c.imageSmoothingQuality = 'high';
  if (fmt === 'jpeg' && dx === 0 && dy === 0) { c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height); }
  c.drawImage(bmp, sx, sy, sw, sh, dx, dy, dw, dh);
}

// ------------------------------------------------------------------ evaluate

// Turns the value of the user's code into something that survives the trip back (JSON text, or a
// description for DOM nodes, functions and other values JSON can't hold).
const SER = `(v) => {
  if (v === undefined) return { t: 'u' };
  if (typeof v === 'function') return { t: 'd', d: '[function ' + (v.name || 'anonymous') + ']' };
  if (typeof v === 'bigint') return { t: 'd', d: v + 'n' };
  if (typeof v === 'number' && !isFinite(v)) return { t: 'd', d: String(v) };
  if (typeof Node !== 'undefined' && v instanceof Node) return { t: 'd', d: v.nodeType === 1 ? v.outerHTML.slice(0, 5000) : String(v.textContent).slice(0, 5000) };
  try {
    const s = JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x + 'n' : (typeof Node !== 'undefined' && x instanceof Node) ? '<' + x.nodeName.toLowerCase() + '>' : x);
    return s === undefined ? { t: 'd', d: String(v) } : { t: 'j', j: s };
  } catch (e) { return { t: 'd', d: String(v) }; }
}`;
const wrap = (fn) => `(async () => { const __ser = ${SER}; try { return __ser(await (${fn})()); } catch (e) { return { e: e && e.stack ? String(e.stack) : String(e) }; } })()`;

async function userScriptsReady() {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.execute !== 'function') return false;
    await chrome.userScripts.getScripts();
    return true;
  } catch (_) {
    return false; // "Allow User Scripts" is off for this extension
  }
}

/**
 * Run code in the page's own JavaScript world and describe the result. chrome.userScripts runs
 * code even where the page's Content-Security-Policy forbids eval; without it (the user hasn't
 * turned on "Allow User Scripts"), the code is eval'ed in the page, which strict pages refuse.
 */
async function runInPage(tabId, src, timeoutMs) {
  const viaUserScripts = await userScriptsReady();
  const exec = async (code) => {
    let res;
    if (viaUserScripts) {
      [res] = await withTimeout(chrome.userScripts.execute({ target: { tabId }, js: [{ code }], world: 'MAIN', injectImmediately: true }), timeoutMs, `The code did not finish within ${timeoutMs} ms.`);
    } else {
      [res] = await withTimeout(chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', injectImmediately: true, args: [code],
        func: (c) => { try { return (0, eval)(c); } catch (e) { return { e: (e && e.name === 'SyntaxError' ? 'SyntaxError: ' : '') + (e && e.message ? e.message : String(e)), evalBlocked: e instanceof EvalError || /unsafe-eval|Content Security Policy/i.test(String(e && e.message)) }; } },
      }), timeoutMs, `The code did not finish within ${timeoutMs} ms.`);
    }
    if (!res) throw new Error('The page returned no result (it may be navigating).');
    if (res.error) return { e: String(res.error) };
    return res.result;
  };
  const isSyntax = (r) => r && r.e && /SyntaxError/.test(r.e);
  const hasReturn = /(^|[;{}\n])\s*return\b/.test(src);
  // 1. a function body when the code returns; 2. an expression (await allowed); 3. statements
  // (their last value); 4. statements with await.
  const attempts = hasReturn
    ? [wrap(`async () => {\n${src}\n}`)]
    : [wrap(`async () => (\n${src}\n)`), src, wrap(`async () => {\n${src}\n}`)];
  let r;
  for (const code of attempts) {
    r = await exec(code);
    if (!isSyntax(r)) break;
  }
  if (r && r.evalBlocked) {
    throw new Error('This page\'s Content-Security-Policy blocks running JavaScript from a string. To run code on pages like this, turn on "Allow User Scripts" for Claude Browser Bridge (chrome://extensions → Claude Browser Bridge → Details), then try again. The other tools (snapshot, click, type, get_text…) work without it.');
  }
  if (r && r.e) throw new Error('JavaScript error: ' + r.e);
  if (r && typeof r === 'object' && 't' in r) {
    if (r.t === 'u') return 'undefined';
    if (r.t === 'd') return r.d;
    try { const v = JSON.parse(r.j); return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (_) { return r.j; }
  }
  // completion value of plain statements (3.)
  if (r === undefined || r === null) return String(r);
  return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
}

export const METHODS = Object.keys(handlers);

export async function handleCommand(method, params, ctx) {
  const h = handlers[method];
  if (!h) throw new Error(`Unknown command "${method}". This extension supports: ${METHODS.join(', ')}. (Update the extension or the server so versions match.)`);
  return await h(params || {}, ctx);
}
