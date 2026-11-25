const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const isPanel = new URLSearchParams(location.search).has('panel');
if (isPanel) document.body.classList.add('panel');

function ago(t) {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Friendly names for commands in the activity log.
const VERBS = {
  tabs_list: 'listed tabs', tab_new: 'opened tab', tab_select: 'selected tab', tab_close: 'closed tab',
  navigate: 'navigated', snapshot: 'read page', find: 'searched page', get_text: 'read text',
  screenshot: 'screenshot', click: 'clicked', hover: 'hovered', drag: 'dragged', type: 'typed',
  press_key: 'pressed key', select_option: 'selected option', scroll: 'scrolled', evaluate: 'ran JS',
  wait_for: 'waited', console_messages: 'read console', handle_dialog: 'handled dialog', upload_file: 'uploaded file',
};
const verb = (m) => VERBS[m] || m;

function describeParams(detail) {
  if (!detail) return '';
  try {
    const p = JSON.parse(detail);
    const bits = [];
    if (p.url) bits.push(p.url);
    if (p.query) bits.push(`"${p.query}"`);
    if (p.text) bits.push(`"${p.text}"`);
    if (p.keys) bits.push([].concat(p.keys).join(' '));
    if (p.ref) bits.push(p.ref);
    if (p.selector) bits.push(p.selector);
    if (p.x != null && p.y != null) bits.push(`(${p.x}, ${p.y})`);
    if (p.values) bits.push([].concat(p.values).join(', '));
    if (p.expression) bits.push(p.expression);
    if (p.tabId != null && !bits.length) bits.push(`tab ${p.tabId}`);
    return bits.join(' · ');
  } catch (_) {
    return detail; // error messages etc.
  }
}

function logItem(a) {
  const li = el('li', a.ok ? '' : 'failed');
  li.append(el('span', 'ic ' + (a.ok ? 'ok' : 'bad'), a.ok ? '✓' : '✗'));
  li.append(el('span', 'm', verb(a.method)));
  const d = el('span', 'd', describeParams(a.detail));
  d.title = a.detail || '';
  li.append(d);
  li.append(el('span', 'tm', ago(a.time)));
  return li;
}

function fillTabRow(box, tab) {
  const nodes = [];
  if (tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) {
    const img = el('img');
    img.src = tab.favIconUrl;
    img.onerror = () => img.replaceWith(el('span', 'noicon'));
    nodes.push(img);
  } else nodes.push(el('span', 'noicon'));
  const txt = el('div', 'txt');
  txt.append(el('div', 't', (tab.status === 'loading' ? '⟳ ' : '') + (tab.title || '(no title)')));
  txt.append(el('div', 'u', tab.pendingUrl || tab.url || ''));
  nodes.push(txt);
  box.replaceChildren(...nodes);
}

/** Session numbers whose "Details" are expanded (the list is rebuilt every second). */
const openDetails = new Set();
let idleOpen = false;

function sessionState(s) {
  const running = s.running[0];
  if (running) return { text: `Working: ${verb(running.method)}…`, working: true };
  if (s.lastActionAt) return { text: `Idle · last action ${ago(s.lastActionAt)}`, working: false };
  return { text: 'Connected, no actions yet', working: false };
}

function chip(s) {
  const c = el('span', 'chip', 'C' + s.number);
  c.style.setProperty('--c', s.color);
  c.title = `Session C${s.number}. The same badge is shown on the toolbar icon and on the page of the tab it controls.`;
  return c;
}

/** The name people know a session by: its conversation title (as in the VS Code tab), else its folder. */
const sessionName = (s) => (s.session && s.session.title) || s.label;

const WHERE = { 'claude-vscode': 'VS Code', cli: 'terminal', 'sdk-cli': 'SDK', 'sdk-ts': 'SDK', 'sdk-py': 'SDK' };
const CHAT = { busy: 'Claude is busy', idle: 'waiting for you' };

/** "auto-bid · VS Code · waiting for you" */
function sessionSub(s) {
  const ss = s.session || {};
  const bits = [];
  if (ss.title) bits.push(s.label);
  if (ss.entrypoint) bits.push(WHERE[ss.entrypoint] || ss.entrypoint);
  if (ss.status) bits.push(CHAT[ss.status] || ss.status);
  return bits.join(' · ');
}

const canOpen = (s) => !!(s.session && s.session.id && s.session.entrypoint === 'claude-vscode');

/** Feedback of the last "Go to session" click per session; the popup is rebuilt every second. */
const goState = new Map();

/** Button that brings the session's chat into view in VS Code. */
function goButton(s, cls = 'go') {
  const st = goState.get(s.number);
  const busy = st && st.until > Date.now();
  const b = el('button', cls, busy ? st.text : 'Go to session ↗');
  b.disabled = !!busy;
  b.title = busy && st.error ? st.error : `Show "${sessionName(s)}" in VS Code`;
  b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    goState.set(s.number, { text: 'Opening…', until: Date.now() + 10000 });
    b.disabled = true;
    b.textContent = 'Opening…';
    const r = await send({ type: 'openSession', number: s.number }).catch((e) => ({ ok: false, error: e.message }));
    const ok = r && r.ok;
    goState.set(s.number, { text: ok ? 'Opened in VS Code' : 'Failed', error: ok ? '' : (r && r.error) || 'Could not open the session', until: Date.now() + (ok ? 2500 : 6000) });
    if (!ok) $('summary').textContent = goState.get(s.number).error;
    refresh();
  });
  return b;
}

function facts(s) {
  const dl = el('dl', 'facts');
  const fact = (k, v) => { if (v == null || v === '') return; dl.append(el('dt', '', k), el('dd', '', String(v))); };
  fact('Tab', s.tab ? `id ${s.tab.id} · window ${s.tab.windowId}${s.tab.active ? ' · active in its window' : ''}` : 'none');
  fact('Conversation', s.session && s.session.title);
  fact('Session id', s.session && s.session.id);
  fact('Folder', s.cwd);
  fact('Server', `port ${s.port}${s.pid ? ` · pid ${s.pid}` : ''}${s.serverVersion ? ` · v${s.serverVersion}` : ''}`);
  fact('Connected', ago(s.connectedAt));
  fact('Commands', `${s.commands || 0} run${s.errors ? ` · ${s.errors} failed` : ''}`);
  return dl;
}

function detailsBlock(s) {
  const d = el('details', 'more');
  d.open = openDetails.has(s.number);
  d.addEventListener('toggle', () => { if (d.open) openDetails.add(s.number); else openDetails.delete(s.number); });
  d.append(el('summary', '', 'Details'), facts(s));
  return d;
}

function cardHead(s, stateText, working) {
  const head = el('div', 'card-head');
  const name = el('div', 'name');
  name.append(chip(s), el('span', '', sessionName(s)));
  name.title = [sessionName(s), s.cwd].filter(Boolean).join('\n');
  head.append(name, el('span', 'state' + (working ? ' working' : ''), stateText));
  const sub = sessionSub(s);
  if (!sub && !canOpen(s)) return head;
  const wrap = el('div', 'head-wrap');
  const line = el('div', 'sub-row');
  line.append(el('span', 'sub', sub));
  if (canOpen(s)) line.append(goButton(s));
  wrap.append(head, line);
  return wrap;
}

function sessionCard(s) {
  const card = el('div', 'card');
  card.id = 'session-' + s.number;
  card.style.setProperty('--c', s.color);
  const st = sessionState(s);
  card.append(cardHead(s, st.working ? st.text : 'Idle', st.working));

  if (s.tab) {
    const b = el('button', 'tab');
    b.title = 'Switch to this tab';
    fillTabRow(b, s.tab);
    if (currentTab && currentTab.id === s.tab.id) b.append(el('span', 'here', 'This tab'));
    b.addEventListener('click', () => send({ type: 'focusTab', tabId: s.tab.id }));
    card.append(b);
  }

  if (s.activity.length) {
    const ol = el('ol', 'log');
    for (const a of s.activity.slice(0, isPanel ? 8 : 3)) ol.append(logItem(a));
    card.append(ol);
  }
  card.append(detailsBlock(s));
  return card;
}

function idleRow(s) {
  const li = el('li', 'idle-row');
  li.style.setProperty('--c', s.color);
  li.append(cardHead(s, 'No tab', false), detailsBlock(s));
  return li;
}

function renderSessions(st) {
  const box = $('sessions');
  const n = st.sessions.length;
  const working = st.sessions.filter((s) => s.running.length).length;
  $('summary').textContent = !st.settings.enabled ? 'off' : n ? `${n} connected${working ? ` · ${working} working` : ''}` : 'none connected';
  if (!st.settings.enabled) {
    box.replaceChildren(el('div', 'empty', 'The bridge is off, so no Claude session can control this profile. Turn it on with the switch at the top right.'));
    return;
  }
  if (!n) {
    box.replaceChildren(el('div', 'empty',
      'Waiting for Claude Code. Start a Claude Code session that has the chrome-bridge MCP server ' +
      `(scanning ports ${st.ports[0]}–${st.ports[st.ports.length - 1]}).`));
    return;
  }
  // Sessions using a tab get a full card; the rest are only connected in the background.
  const active = st.sessions.filter((s) => s.tab || s.running.length);
  const idle = st.sessions.filter((s) => !s.tab && !s.running.length);
  const nodes = active.map(sessionCard);
  if (idle.length) {
    const d = el('details', 'idle-box');
    d.open = idleOpen || !active.length;
    d.addEventListener('toggle', () => { idleOpen = d.open; });
    d.append(el('summary', '', `${idle.length} session${idle.length > 1 ? 's' : ''} without a tab`));
    d.append(el('p', 'muted small', 'Connected, but not using a tab yet. To give one a tab, use "Give this tab to a Claude session" above.'));
    const ul = el('ul', 'idle-list');
    ul.append(...idle.map(idleRow));
    d.append(ul);
    nodes.push(d);
  }
  box.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- hand a tab to Claude

// Pages no extension may control.
const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-search|chrome-untrusted):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

let lastStatus = null;
let currentTab = null;

/** The prompt a user pastes into any Claude Code session to make it drive this tab. */
function buildPrompt(st, tab, owner, task) {
  const script = (st.serverScript || '<path to claude_support_extension>/server/index.js').replace(/\\/g, '/');
  const lines = [
    'Use my real Chrome browser through the chrome-bridge MCP tools (Claude Browser Bridge).',
    '',
    'Work in this tab:',
    `- Chrome profile: "${st.label}"`,
    `- Tab id: ${tab.id}`,
    `- Title: ${tab.title || '(no title)'}`,
    `- URL: ${tab.pendingUrl || tab.url}`,
    '',
    'Connect like this:',
    `1. select_profile with profile "${st.label}".`,
    owner
      ? `2. tab_select with tabId ${tab.id} and takeOver: true. Session C${owner.number} ("${sessionName(owner)}") had this tab, and I am handing it to you.`
      : `2. tab_select with tabId ${tab.id}.`,
    '   If that tab id no longer exists (Chrome was restarted), call tabs_list and select the tab with the URL above. If none matches, use tab_new with that URL.',
    '3. Read the page with snapshot (use screenshot when the layout matters), then act with click, type, press_key and so on, using the [ref=eN] refs from the snapshot.',
    '',
    "Rules: stay in this tab and don't touch my other tabs unless I ask. Ask me before you submit payments, send messages, delete things, or do anything else that is hard to undo.",
    '',
    task
      ? 'Task: ' + task
      : 'Task: when you are connected, tell me the page title and wait for my instructions.',
    '',
    'If you have no chrome-bridge tools (select_profile, tab_select, snapshot...), the MCP server is not registered in this Claude Code. In that case run this command:',
    `  claude mcp add --scope user chrome-bridge -- node "${script}"`,
    'Then tell me to restart Claude Code and paste this prompt again. Stop there.',
  ];
  return lines.join('\n');
}

let lastMode = null;

/** The "This tab" block: who controls the active tab, and how to give it to a session. */
async function renderThisTab(st) {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { /* ignore */ }
  currentTab = tab || null;
  const status = $('tabStatus');
  const btn = $('copyPrompt');
  status.className = 'tab-status';
  status.style.removeProperty('--c');
  if (!tab) {
    $('handoffTab').replaceChildren(el('div', 'notab', 'No active tab in this window.'));
    status.replaceChildren();
    $('give').hidden = true;
    return;
  }
  fillTabRow($('handoffTab'), tab);
  const owner = st.sessions.find((s) => s.tab && s.tab.id === tab.id) || null;
  const restricted = RESTRICTED.test(tab.pendingUrl || tab.url || '');

  let mode;
  if (!st.settings.enabled) {
    mode = 'off';
    status.classList.add('neutral');
    status.replaceChildren(el('span', 'sdot'), el('span', '', 'Not controlled. The bridge is off.'));
  } else if (restricted) {
    mode = 'restricted';
    status.classList.add('neutral');
    status.replaceChildren(el('span', 'sdot'), el('span', '', "Claude can't control this page. Chrome blocks extensions here."));
  } else if (owner) {
    mode = 'owned';
    const ost = sessionState(owner);
    status.classList.add('owned');
    if (ost.working) status.classList.add('working');
    status.style.setProperty('--c', owner.color);
    const txt = el('div', 'stxt');
    const who = el('div', 'swho');
    who.append(chip(owner), el('span', 'slabel', sessionName(owner)));
    txt.append(el('div', 'sline1', 'Controlled by Claude'), who, el('div', 'sline2', ost.text));
    const show = el('button', 'link', 'Show session');
    show.addEventListener('click', () => {
      const card = document.getElementById('session-' + owner.number);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('flash');
      void card.offsetWidth; // restart the animation
      card.classList.add('flash');
    });
    const btns = el('div', 'sbtns');
    if (canOpen(owner)) btns.append(goButton(owner, 'link'));
    btns.append(show);
    status.replaceChildren(el('span', 'sdot'), txt, btns);
  } else {
    mode = 'free';
    status.classList.add('free');
    status.replaceChildren(el('span', 'sdot'), el('span', '', 'Not controlled by Claude'));
  }

  $('give').hidden = mode === 'off' || mode === 'restricted';
  // Open the "give" box for a free tab; keep the user's choice until the situation changes.
  if (mode !== lastMode) { $('give').open = mode === 'free'; lastMode = mode; }
  $('giveSummary').textContent = owner ? 'Hand this tab to a different session' : 'Give this tab to a Claude session';
  btn.disabled = mode === 'off' || mode === 'restricted';
  $('promptPreview').textContent = btn.disabled ? '' : buildPrompt(st, tab, owner, $('task').value.trim());
}

async function copyPrompt() {
  const st = lastStatus;
  const tab = currentTab;
  if (!st || !tab) return;
  const owner = st.sessions.find((s) => s.tab && s.tab.id === tab.id) || null;
  const text = buildPrompt(st, tab, owner, $('task').value.trim());
  try {
    await navigator.clipboard.writeText(text);
    $('copied').textContent = 'Copied. Paste it into your Claude Code session.';
  } catch (_) {
    // Fallback for contexts without clipboard permission.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    $('copied').textContent = ok ? 'Copied. Paste it into your Claude Code session.' : 'Copy failed. Use the preview below.';
  }
  setTimeout(() => { $('copied').textContent = ''; }, 4000);
}

$('copyPrompt').addEventListener('click', copyPrompt);
$('task').addEventListener('input', () => { if (lastStatus) renderThisTab(lastStatus); });

let formFilled = false;

async function refresh() {
  let st;
  try {
    st = await send({ type: 'getStatus' });
  } catch (e) {
    $('summary').textContent = 'Extension background is not running: ' + e.message;
    return;
  }
  if (!st || !st.settings) return;
  lastStatus = st;
  const n = st.sessions.length;
  $('enabled').checked = !!st.settings.enabled;
  $('dot').className = 'dot ' + (!st.settings.enabled ? 'off' : n ? 'on' : '');
  await renderThisTab(st); // first, so session cards know which tab is the current one
  renderSessions(st);

  $('profileInfo').textContent = `Shown to Claude as "${st.label}"${st.email && st.email !== st.label ? ` (${st.email})` : ''} · id ${st.profileId.slice(0, 8)}` +
    (st.attachedTabs ? ` · debugger attached to ${st.attachedTabs} tab(s)` : '');

  if (!formFilled) {
    $('profileLabel').value = st.settings.profileLabel || '';
    $('token').value = st.settings.token || '';
    $('portStart').value = st.settings.portStart;
    $('portCount').value = st.settings.portCount;
    $('groupTabs').checked = st.settings.groupTabs !== false;
    formFilled = true;
  }

  const ol = $('activity');
  if (!st.activity.length) ol.replaceChildren(el('li', 'muted', 'No activity yet'));
  else {
    ol.replaceChildren(...st.activity.map((a) => {
      const li = el('li', a.ok ? '' : 'err');
      if (a.session) {
        const chip = el('span', 'chip', 'C' + a.session);
        chip.style.setProperty('--c', a.color);
        chip.title = a.sessionLabel;
        li.append(chip, document.createTextNode(' '));
      }
      li.append(el('span', 'm', verb(a.method)));
      li.append(document.createTextNode(` · ${ago(a.time)}${a.ms != null ? ` · ${a.ms} ms` : ''}`));
      if (a.detail) li.append(el('div', 'muted', describeParams(a.detail)));
      return li;
    }));
  }
}

$('enabled').addEventListener('change', async (e) => {
  await send({ type: 'saveSettings', settings: { enabled: e.target.checked } });
  setTimeout(refresh, 200);
});

$('reconnect').addEventListener('click', async () => {
  await send({ type: 'reconnect' });
  setTimeout(refresh, 800);
});

$('detach').addEventListener('click', async () => {
  const r = await send({ type: 'detachAll' });
  $('detach').textContent = `Released ${r?.count ?? 0} tab(s)`;
  setTimeout(() => { $('detach').textContent = 'Release all tabs'; }, 2000);
  refresh();
});

$('openPanel').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  } catch (e) {
    $('summary').textContent = 'Could not open the side panel: ' + e.message;
  }
});

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  await send({
    type: 'saveSettings',
    settings: {
      profileLabel: $('profileLabel').value.trim(),
      groupTabs: $('groupTabs').checked,
      token: $('token').value,
      portStart: Number($('portStart').value),
      portCount: Number($('portCount').value),
    },
  });
  $('saved').textContent = 'Saved';
  setTimeout(() => { $('saved').textContent = ''; refresh(); }, 1200);
});

refresh();
setInterval(refresh, 1000);
