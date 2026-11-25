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
    if (s.tab.favIconUrl && /^(https?|data):/.test(s.tab.favIconUrl)) {
      const img = el('img');
      img.src = s.tab.favIconUrl;
      img.onerror = () => img.replaceWith(el('span', 'noicon'));
      b.append(img);
    } else b.append(el('span', 'noicon'));
    const txt = el('div', 'txt');
    txt.append(el('div', 't', (s.tab.status === 'loading' ? '⟳ ' : '') + (s.tab.title || '(no title)')));
    txt.append(el('div', 'u', s.tab.url || ''));
    b.append(txt);
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
