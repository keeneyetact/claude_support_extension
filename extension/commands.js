// Command handlers invoked by the local MCP server. Each returns { text, images? }.
import {
  cdp, ensureAttached, sessionFor, withTimeout, mouseClick, mouseMove, mouseWheel, mouseDrag,
} from './cdp.js';
import { keyDef, parseCombo, modifierBits, macCommands } from './keys.js';

const AGENT_VERSION = 5; // must match VERSION in content/agent.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function setAgentTab(ctx, tabId) {
  if (ctx.currentTabId === tabId) return;
  const old = ctx.currentTabId;
  if (old != null && tabOwner.get(old) === ctx) {
    tabOwner.delete(old);
    clearTabBadge(old);
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
  }
  if (ctx.onChange) ctx.onChange();
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
});

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

function dialogError(d) {
  return new Error(
    `A JavaScript ${d.type} dialog is open on this tab: "${d.message}". ` +
    'Call handle_dialog (accept or dismiss) before doing anything else on this tab.',
  );
}

function guardDialog(tabId) {
  const st = sessionFor(tabId);
  if (st && st.dialog) throw dialogError(st.dialog);
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

/** Run a method of the in-page helper (content/agent.js) in the tab's top frame. */
async function page(tab, method, args = {}, timeoutMs = 15000) {
  checkScriptable(tab);
  guardDialog(tab.id);
  const run = () => chrome.scripting.executeScript({
    target: { tabId: tab.id },
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
        chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['content/agent.js'] }),
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
    const st = sessionFor(tab.id);
    if (st && st.dialog) throw dialogError(st.dialog);
    if (/Page did not respond/.test(e.message)) {
      throw new Error(`The page did not respond within ${timeoutMs} ms (it may be busy, frozen, or blocked by a dialog). If a dialog is showing, call console_messages or handle_dialog.`);
    }
    throw friendlyScriptError(e, tab);
  }
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
    const st = sessionFor(tabId);
    if (st && st.dialog) return { ok: false, dialog: st.dialog, tab };
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
  const st = sessionFor(tabId);
  if (st && st.dialog) notes.push(`A JavaScript ${st.dialog.type} dialog opened: "${st.dialog.message}" — call handle_dialog.`);
  const opened = recentCreated.filter((r) => r.at >= since && r.opener === tabId);
  for (const o of opened) {
    const t = await chrome.tabs.get(o.id).catch(() => null);
    if (t) notes.push(`The page opened a new tab ${summary(t)} — call tab_select with tabId ${t.id} to work in it.`);
  }
  if (urlBefore && tabUrl(tab) !== urlBefore) notes.push(`Navigated to ${tabUrl(tab)}`);
  notes.push(`Current page: ${summary(tab)}`);
  return notes.join('\n');
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

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

async function resizeImage(b64, inMime, width, height, outMime, quality) {
  const bmp = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: inMime }));
  if (bmp.width === width && bmp.height === height && inMime === outMime) { bmp.close(); return b64; }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (outMime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: outMime, quality: quality / 100 });
  return bytesToB64(new Uint8Array(await blob.arrayBuffer()));
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
    guardDialog(tab.id);
    const since = Date.now();
    const cmd = String(url).toLowerCase();
    const before = tabUrl(tab);
    try {
      if (cmd === 'back') await chrome.tabs.goBack(tab.id);
      else if (cmd === 'forward') await chrome.tabs.goForward(tab.id);
      else if (cmd === 'reload') await chrome.tabs.reload(tab.id);
      else await chrome.tabs.update(tab.id, { url: normalizeUrl(url) });
    } catch (e) {
      throw new Error(`Navigation failed: ${e.message}`);
    }
    const r = await waitForLoad(tab.id, timeoutMs, { expectNavigation: cmd !== 'back' && cmd !== 'forward' });
    tab = r.tab || tab;
    const notes = [];
    if (r.timeout) notes.push(`Page still loading after ${timeoutMs} ms (continuing anyway).`);
    if (r.dialog) notes.push(`A JavaScript ${r.dialog.type} dialog is open: "${r.dialog.message}" — call handle_dialog.`);
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
    guardDialog(tab.id);
    await ensureAttached(tab.id);
    const fmt = format === 'png' ? 'png' : 'jpeg';
    const mime = 'image/' + fmt;
    const metrics = await cdp(tab.id, 'Page.getLayoutMetrics');
    const layout = metrics.cssLayoutViewport || metrics.layoutViewport;
    const visual = metrics.cssVisualViewport || metrics.visualViewport;
    let cssW = visual.clientWidth, cssH = visual.clientHeight;
    const params = { format: fmt, captureBeyondViewport: false };
    if (fmt === 'jpeg') params.quality = Math.max(1, Math.min(100, quality));
    let mode = 'viewport';
    let originNote = '';
    if (ref || selector) {
      const r = await page(tab, 'rect', { ref, selector });
      const m2 = await cdp(tab.id, 'Page.getLayoutMetrics');
      const lv = m2.cssLayoutViewport || m2.layoutViewport;
      cssW = Math.max(1, Math.ceil(r.width));
      cssH = Math.max(1, Math.ceil(Math.min(r.height, 8000)));
      params.clip = { x: r.x + lv.pageX, y: r.y + lv.pageY, width: cssW, height: cssH, scale: 1 };
      params.captureBeyondViewport = true;
      mode = 'element';
      originNote = ` Element ${r.description} at viewport (${Math.round(r.x)}, ${Math.round(r.y)}); image (0,0) = that point.`;
    } else if (fullPage) {
      const size = metrics.cssContentSize || metrics.contentSize;
      cssW = Math.ceil(size.width);
      cssH = Math.min(Math.ceil(size.height), 16000);
      params.clip = { x: 0, y: 0, width: cssW, height: cssH, scale: 1 };
      params.captureBeyondViewport = true;
      mode = 'full page';
      originNote = ` Image coordinates are document coordinates (current scroll ${Math.round(layout.pageX)},${Math.round(layout.pageY)}), not viewport coordinates.`;
    }

    let shot;
    const capture = (ms) => cdp(tab.id, 'Page.captureScreenshot', params, ms);
    try {
      shot = await capture(tab.active ? 20000 : 3000);
    } catch (e) {
      if (tab.active) throw new Error(`Screenshot failed: ${e.message}`);
      // Background tabs often don't render; briefly activate the tab, capture, then restore.
      const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(400);
      try {
        shot = await capture(20000);
      } finally {
        if (prev && prev.id !== tab.id) await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
      }
    }

    const longest = Math.max(cssW, cssH);
    const limit = mode === 'full page' ? Math.max(maxDimension, 8000) : maxDimension;
    let scale = longest > limit ? limit / longest : 1;
    if (mode === 'full page' && cssW * scale > maxDimension) scale = Math.min(scale, maxDimension / cssW);
    const outW = Math.max(1, Math.round(cssW * scale));
    const outH = Math.max(1, Math.round(cssH * scale));
    const data = await resizeImage(shot.data, mime, outW, outH, mime, fmt === 'jpeg' ? params.quality : 100);
    tab = await chrome.tabs.get(tab.id).catch(() => tab);
    let coordNote;
    if (scale === 1) coordNote = 'Image pixels = CSS pixels.';
    else coordNote = `Image is scaled by ${scale.toFixed(4)}: divide image coordinates by ${scale.toFixed(4)} (i.e. multiply by ${(1 / scale).toFixed(4)}) to get CSS pixels.`;
    if (mode === 'viewport') coordNote += ' Coordinates are viewport coordinates usable for click/hover x,y.';
    return {
      text: `Screenshot (${mode}) of ${summary(tab)}. Image ${outW}x${outH}, area ${cssW}x${cssH} CSS px. ${coordNote}${originNote}\nPrefer refs from snapshot/find over coordinates when possible.`,
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
    guardDialog(tab.id);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const pt = await targetPoint(tab, { ref, selector, x, y });
    await mouseClick(tab.id, pt.x, pt.y, {
      button, clickCount: clickCount || (doubleClick ? 2 : 1), modifiers: modifierBits(modifiers),
    });
    const after = await settle(tab.id, since, urlBefore);
    return {
      text: `Clicked ${pt.description} at (${Math.round(pt.x)}, ${Math.round(pt.y)}).` +
        (pt.warning ? `\nWarning: ${pt.warning}` : '') + '\n' + after,
    };
  },

  async hover({ tabId, ref, selector, x, y } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    guardDialog(tab.id);
    const pt = await targetPoint(tab, { ref, selector, x, y });
    await mouseMove(tab.id, pt.x, pt.y);
    await sleep(300);
    return { text: `Hovering over ${pt.description} at (${Math.round(pt.x)}, ${Math.round(pt.y)}).${pt.warning ? '\nWarning: ' + pt.warning : ''}` };
  },

  async drag({ tabId, fromRef, fromSelector, fromX, fromY, toRef, toSelector, toX, toY } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    guardDialog(tab.id);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const a = await targetPoint(tab, { ref: fromRef, selector: fromSelector, x: fromX, y: fromY }, 'drag source');
    // Compute destination without scrolling it into view if coordinates given.
    const b = await targetPoint(tab, { ref: toRef, selector: toSelector, x: toX, y: toY }, 'drop target');
    // Source may have moved if the destination scrolled; recompute when using refs.
    const a2 = fromRef || fromSelector ? await page(tab, 'point', { ref: fromRef, selector: fromSelector, scroll: false }).catch(() => a) : a;
    await mouseDrag(tab.id, { x: a2.x, y: a2.y }, { x: b.x, y: b.y });
    return { text: `Dragged ${a.description} to ${b.description}.\n` + (await settle(tab.id, since, urlBefore)) };
  },

  async type({ tabId, text, ref, selector, clear = false, submit = false, slowly = false } = {}, ctx) {
    if (typeof text !== 'string') throw new Error('text is required.');
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    guardDialog(tab.id);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    let desc = 'the focused element';
    if (ref || selector) {
      let f = await page(tab, 'focus', { ref, selector, clear });
      if (!f.focused) {
        // Not directly focusable (e.g. a wrapper) – click it like a user would.
        const pt = await targetPoint(tab, { ref, selector });
        await mouseClick(tab.id, pt.x, pt.y);
        await sleep(100);
        if (clear) {
          await pressCombo(tab.id, isMac ? 'Meta+a' : 'Control+a');
          await pressCombo(tab.id, 'Backspace');
        }
      } else if (clear && f.hasValue) {
        // focus() already selected the content; select-all again via keyboard (covers inputs where
        // select() is unsupported) and delete it so frameworks see a real user edit.
        await pressCombo(tab.id, isMac ? 'Meta+a' : 'Control+a');
        await pressCombo(tab.id, 'Backspace');
      }
      desc = f.description;
    } else if (clear) {
      await pressCombo(tab.id, isMac ? 'Meta+a' : 'Control+a');
      await pressCombo(tab.id, 'Backspace');
    }
    if (text.length) {
      if (slowly) {
        for (const ch of text) {
          if (ch === '\n') await pressCombo(tab.id, 'Enter');
          else await typeChar(tab.id, ch);
          await sleep(30);
        }
      } else {
        await cdp(tab.id, 'Input.insertText', { text });
      }
    }
    if (submit) await pressCombo(tab.id, 'Enter');
    const after = await settle(tab.id, since, urlBefore);
    return { text: `Typed ${text.length} character(s) into ${desc}${submit ? ' and pressed Enter' : ''}.\n${after}` };
  },

  async press_key({ tabId, keys, repeat = 1 } = {}, ctx) {
    if (!keys) throw new Error('keys is required, e.g. "Enter", "Escape", "Control+A", "Shift+Tab".');
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    guardDialog(tab.id);
    const since = Date.now();
    const urlBefore = tabUrl(tab);
    const list = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < Math.max(1, Math.min(repeat, 200)); i++) {
      for (const k of list) await pressCombo(tab.id, k);
    }
    return { text: `Pressed ${list.join(', ')}${repeat > 1 ? ` x${repeat}` : ''}.\n` + (await settle(tab.id, since, urlBefore)) };
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
    guardDialog(tab.id);
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
    await mouseWheel(tab.id, px, py, dx, dy);
    await sleep(400);
    const after = await page(tab, 'scrollInfo');
    let text = `Scrolled by (${dx}, ${dy}) at (${Math.round(px)}, ${Math.round(py)}). Page scroll is now ${after.x},${after.y} of ${after.width}x${after.height} (viewport ${after.viewportWidth}x${after.viewportHeight}).`;
    if (after.x === before.x && after.y === before.y) {
      text += ' The page scroll position did not change: either a nested scroll container under that point scrolled, or the page is already at its edge.';
    }
    return { text };
  },

  async evaluate({ tabId, expression, timeoutMs = 30000 } = {}, ctx) {
    if (!expression) throw new Error('expression is required.');
    const tab = await resolveTab(ctx, tabId);
    checkScriptable(tab);
    guardDialog(tab.id);
    // replMode allows top-level await but does not await a returned promise, so wrapped code runs without it.
    const run = (expr, repl = true) => cdp(tab.id, 'Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true, replMode: repl, allowUnsafeEvalBlockedByCSP: true,
    }, timeoutMs);
    const exc = (x) => x.exceptionDetails && (x.exceptionDetails.exception?.description || x.exceptionDetails.text || 'Error');
    const asFunctionBody = (src) => `(async () => {\n${src}\n})()`;
    // Code with a top-level `return` is treated as a function body.
    const hasTopLevelReturn = /(^|[;{}\n])\s*return\b/.test(expression);
    let r = hasTopLevelReturn ? await run(asFunctionBody(expression), false) : await run(expression);
    if (!hasTopLevelReturn && r.exceptionDetails && /Illegal return statement/.test(exc(r))) {
      r = await run(asFunctionBody(expression), false);
    }
    if (r.exceptionDetails) throw new Error('JavaScript error: ' + exc(r));
    const v = r.result || {};
    let out;
    if (v.type === 'undefined') out = 'undefined';
    else if ('value' in v) out = typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2);
    else out = v.unserializableValue || v.description || `[${v.type}]`;
    if (out && out.length > 50000) out = out.slice(0, 50000) + `\n… [truncated, ${out.length} chars total]`;
    return { text: out };
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
    const existed = !!sessionFor(tab.id);
    const st = await ensureAttached(tab.id);
    let msgs = st.console;
    if (level) {
      const lv = String(level).toLowerCase();
      msgs = msgs.filter((m) => m.level === lv || (lv === 'error' && (m.level === 'exception' || m.level === 'error')));
    }
    const shown = msgs.slice(-limit);
    const lines = shown.map((m) => {
      const t = new Date(m.time > 1e12 ? m.time : Date.now()).toISOString().slice(11, 23);
      return `[${t}] ${m.level}: ${m.text}${m.source ? `  (${m.source})` : ''}`;
    });
    if (clear) st.console.length = 0;
    let head = `${shown.length} of ${msgs.length} message(s) for ${summary(tab)}`;
    if (!existed) head += '\nCapturing just started on this tab — earlier messages are not available. Reproduce the action, then call again.';
    return { text: head + (lines.length ? '\n' + lines.join('\n') : '') };
  },

  async handle_dialog({ tabId, accept = true, promptText } = {}, ctx) {
    const tab = await resolveTab(ctx, tabId);
    const st = sessionFor(tab.id);
    if (!st || !st.dialog) throw new Error('No JavaScript dialog is open on this tab (dialogs are only detected on tabs the agent has interacted with).');
    const d = st.dialog;
    const params = { accept: !!accept };
    if (promptText != null) params.promptText = String(promptText);
    await cdp(tab.id, 'Page.handleJavaScriptDialog', params);
    st.dialog = null;
    return { text: `${accept ? 'Accepted' : 'Dismissed'} ${d.type} dialog "${d.message}".\n` + (await settle(tab.id, Date.now(), null)) };
  },

  async upload_file({ tabId, ref, selector, paths } = {}, ctx) {
    const files = Array.isArray(paths) ? paths : paths ? [paths] : [];
    if (!files.length) throw new Error('paths (absolute file paths on this computer) is required.');
    const tab = await resolveTab(ctx, tabId);
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const info = await page(tab, 'tag', { ref, selector, token });
    try {
      if (info.tag !== 'INPUT' || String(info.type).toLowerCase() !== 'file') {
        throw new Error(`Element ${info.description} is not an <input type="file">. Find the file input (it is often hidden; try find "file" or selector 'input[type=file]').`);
      }
      const finder = `(${function (tok) {
        const sel = '[data-claude-bridge-tag="' + tok + '"]';
        const search = (root) => {
          const f = root.querySelector(sel);
          if (f) return f;
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) { const r = search(el.shadowRoot); if (r) return r; }
            if (el.tagName === 'IFRAME') { try { const d = el.contentDocument; if (d) { const r = search(d); if (r) return r; } } catch (e) { /* cross-origin */ } }
          }
          return null;
        };
        return search(document);
      }.toString()})(${JSON.stringify(token)})`;
      const r = await cdp(tab.id, 'Runtime.evaluate', { expression: finder, returnByValue: false });
      if (!r.result || !r.result.objectId) throw new Error('Could not locate the file input from the debugger (it may be in a closed shadow root).');
      await cdp(tab.id, 'DOM.setFileInputFiles', { files, objectId: r.result.objectId });
    } finally {
      await page(tab, 'untag', { token }).catch(() => {});
    }
    return { text: `Set ${files.length} file(s) on ${info.description}: ${files.join(', ')}\n` + (await settle(tab.id, Date.now(), null)) };
  },
};

async function typeChar(tabId, ch) {
  const d = keyDef(ch);
  const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function pressCombo(tabId, combo) {
  const { modifiers, key } = parseCombo(combo);
  let bits = 0;
  for (const m of modifiers) {
    bits |= modifierBits([m]);
    const d = keyDef(m);
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', modifiers: bits, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, location: 1,
    });
  }
  const shift = modifiers.includes('Shift');
  const d = keyDef(key, shift);
  const withText = !!d.text && !modifiers.some((m) => m === 'Control' || m === 'Alt' || m === 'Meta');
  const base = { modifiers: bits, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
  const down = { type: withText ? 'keyDown' : 'rawKeyDown', ...base };
  if (withText) { down.text = d.text; down.unmodifiedText = d.text; }
  const cmds = isMac ? macCommands(modifiers, key) : undefined;
  if (cmds) down.commands = cmds;
  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  for (const m of [...modifiers].reverse()) {
    bits &= ~modifierBits([m]);
    const md = keyDef(m);
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: bits, key: md.key, code: md.code, windowsVirtualKeyCode: md.keyCode, nativeVirtualKeyCode: md.keyCode, location: 1,
    });
  }
}

export const METHODS = Object.keys(handlers);

export async function handleCommand(method, params, ctx) {
  const h = handlers[method];
  if (!h) throw new Error(`Unknown command "${method}". This extension supports: ${METHODS.join(', ')}. (Update the extension or the server so versions match.)`);
  return await h(params || {}, ctx);
}
