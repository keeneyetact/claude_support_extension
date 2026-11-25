const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let formFilled = false;

async function refresh() {
  let st;
  try {
    st = await send({ type: 'getStatus' });
  } catch (e) {
    $('status').textContent = 'Extension background is not running: ' + e.message;
    return;
  }
  if (!st || !st.settings) return;
  const n = st.connections.length;
  $('enabled').checked = !!st.settings.enabled;
  $('dot').className = 'dot ' + (!st.settings.enabled ? 'off' : n ? 'on' : '');
  $('status').textContent = !st.settings.enabled
    ? 'Disabled — Claude cannot control this profile.'
    : n
      ? `Connected to ${n} Claude session${n > 1 ? 's' : ''}`
      : `Waiting for Claude… (scanning ports ${st.ports[0]}–${st.ports[st.ports.length - 1]})`;

  const ul = $('sessions');
  ul.replaceChildren(...st.connections.map((c) => {
    const li = el('li');
    const s = c.server || {};
    li.textContent = `${s.cwd || 'Claude session'} — port ${c.port}${s.pid ? `, pid ${s.pid}` : ''}, ${ago(c.connectedAt)}`;
    return li;
  }));

  $('agentTab').textContent = st.agentTab
    ? `Agent tab: ${st.agentTab.title || st.agentTab.url}` + (st.attachedTabs ? ` · debugger on ${st.attachedTabs} tab(s)` : '')
    : st.attachedTabs ? `Debugger attached to ${st.attachedTabs} tab(s)` : '';

  $('profileInfo').textContent = `Shown to Claude as "${st.label}"${st.email ? ` (${st.email})` : ''} · id ${st.profileId.slice(0, 8)}`;

  if (!formFilled) {
    $('profileLabel').value = st.settings.profileLabel || '';
    $('token').value = st.settings.token || '';
    $('portStart').value = st.settings.portStart;
    $('portCount').value = st.settings.portCount;
    formFilled = true;
  }

  const ol = $('activity');
  ol.replaceChildren(...(st.activity.length ? st.activity : [{ method: 'No activity yet', ok: true, time: Date.now() }]).map((a) => {
    const li = el('li', a.ok ? '' : 'err');
    li.append(el('span', 'm', a.method));
    li.append(document.createTextNode(` · ${ago(a.time)}${a.ms != null ? ` · ${a.ms} ms` : ''}`));
    if (a.detail) li.append(el('div', 'muted', a.detail));
    return li;
  }));
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

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  await send({
    type: 'saveSettings',
    settings: {
      profileLabel: $('profileLabel').value.trim(),
      token: $('token').value,
      portStart: Number($('portStart').value),
      portCount: Number($('portCount').value),
    },
  });
  $('saved').textContent = 'Saved — reconnecting…';
  setTimeout(() => { $('saved').textContent = ''; refresh(); }, 1200);
});

refresh();
setInterval(refresh, 1500);
