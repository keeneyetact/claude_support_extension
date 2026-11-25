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
  const li = el('li');
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

function sessionCard(s) {
  const card = el('div', 'card');
  card.style.setProperty('--c', s.color);

  const head = el('div', 'card-head');
  const name = el('div', 'name');
  name.append(el('span', 'chip', 'C' + s.number), el('span', '', s.label));
  head.append(name);
  const running = s.running[0];
  const state = el('span', 'state' + (running ? ' working' : ''));
  state.textContent = running
    ? `${verb(running.method)}…`
    : s.lastActionAt ? `idle · ${ago(s.lastActionAt)}` : 'connected';
  head.append(state);
  card.append(head);

  card.append(el('div', 'cwd', `${s.cwd || ''}  ·  port ${s.port}${s.pid ? ` · pid ${s.pid}` : ''}`));

  if (s.tab) {
    const b = el('button', 'tab');
    b.title = 'Show this tab';
    fillTabRow(b, s.tab);
    b.addEventListener('click', () => send({ type: 'focusTab', tabId: s.tab.id }));
    card.append(b);
  } else {
    card.append(el('div', 'notab', 'No tab yet. It will take the active tab or open its own on the first browser command.'));
  }

  if (s.activity.length) {
    const ol = el('ol', 'log');
    for (const a of s.activity.slice(0, isPanel ? 8 : 5)) ol.append(logItem(a));
    card.append(ol);
  }
  return card;
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
      ? `2. tab_select with tabId ${tab.id} and takeOver: true. Session C${owner.number} ("${owner.label}") had this tab, and I am handing it to you.`
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

async function renderHandoff(st) {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { /* ignore */ }
  currentTab = tab || null;
  const btn = $('copyPrompt');
  if (!tab) {
    $('handoffTab').replaceChildren(el('div', 'notab', 'No active tab in this window.'));
    btn.disabled = true;
    return;
  }
  fillTabRow($('handoffTab'), tab);
  const owner = st.sessions.find((s) => s.tab && s.tab.id === tab.id) || null;
  const url = tab.pendingUrl || tab.url || '';
  const restricted = RESTRICTED.test(url);
  $('handoffOwner').textContent = restricted
    ? "Chrome doesn't let extensions control this page"
    : owner ? `Controlled by C${owner.number} · ${owner.label}` : 'Not controlled by Claude';
  btn.disabled = restricted || !st.settings.enabled;
  $('promptPreview').textContent = restricted ? '' : buildPrompt(st, tab, owner, $('task').value.trim());
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
$('task').addEventListener('input', () => { if (lastStatus) renderHandoff(lastStatus); });

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
  renderHandoff(st);
  const n = st.sessions.length;
  const working = st.sessions.filter((s) => s.running.length).length;
  $('enabled').checked = !!st.settings.enabled;
  $('dot').className = 'dot ' + (!st.settings.enabled ? 'off' : n ? 'on' : '');
  $('summary').textContent = !st.settings.enabled
    ? 'Disabled. Claude cannot control this profile.'
    : n
      ? `${n} Claude session${n > 1 ? 's' : ''} connected${working ? ` · ${working} working` : ''}`
      : 'No Claude session connected';

  const box = $('sessions');
  if (!st.settings.enabled) {
    box.replaceChildren();
  } else if (!n) {
    box.replaceChildren(el('div', 'empty',
      `Waiting for Claude Code… Start a Claude Code session that has the chrome-bridge MCP server. ` +
      `Scanning ports ${st.ports[0]}–${st.ports[st.ports.length - 1]}.`));
  } else {
    box.replaceChildren(...st.sessions.map(sessionCard));
  }

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
