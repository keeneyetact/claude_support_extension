// End-to-end test: launches an isolated Chrome (temporary profile) with the extension loaded,
// starts the MCP server through a real MCP client, and exercises every tool against a local page.
//   node test/e2e.mjs            (headless)
//   HEADED=1 node test/e2e.mjs   (watch it)
//   CHROME_PATH=... to point at a specific Chrome/Chromium binary.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '..', 'index.js');
const extPath = path.resolve(here, '..', '..', 'extension');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const c = [
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Bin/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return c.find((p) => p && fs.existsSync(p));
}

const PAGE = `<!doctype html><html><head><title>Bridge Test Page</title>
<style>body{font-family:sans-serif;margin:20px} #spacer{height:2500px} .card{cursor:pointer;padding:6px;border:1px solid #ccc;width:200px}</style></head>
<body>
<h1>Bridge Test</h1>
<p>Some <b>intro</b> paragraph text.</p>
<label for="name">Your name</label> <input id="name" placeholder="Type name" value="old">
<button id="go" onclick="document.getElementById('out').textContent='Hello, '+document.getElementById('name').value; console.log('clicked go', 42)">Greet</button>
<div id="out">nothing yet</div>
<select id="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select>
<label><input type="checkbox" id="agree"> I agree</label>
<div class="card" onclick="this.textContent='card clicked'">Clickable card</div>
<a href="/second" target="_blank">Open second</a>
<a href="/second" id="samelink">Go second</a>
<button onclick="document.getElementById('out').textContent = confirm('Sure?') ? 'confirmed' : 'cancelled'">Confirm me</button>
<input type="file" id="file" onchange="document.getElementById('out').textContent='file: '+this.files[0].name">
<textarea id="ta"></textarea>
<div id="keys">no key</div>
<iframe srcdoc="<button onclick=&quot;this.textContent='frame ok'&quot;>Frame button</button>" style="height:60px"></iframe>
<my-widget></my-widget>
<div id="spacer"></div>
<div id="bottom">Bottom of page</div>
<script>
document.addEventListener('keydown', e => { if (e.key==='Escape') document.getElementById('keys').textContent='escape pressed'; });
customElements.define('my-widget', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'closed'}); r.innerHTML='<button>Shadow button</button>'; r.querySelector('button').onclick=()=>{ r.querySelector('button').textContent='shadow ok'; }; } });
setTimeout(()=>{ const d=document.createElement('div'); d.id='late'; d.textContent='Late content'; document.body.appendChild(d); }, 1500);
console.error('test error message');
</script>
</body></html>`;

let failures = 0;
const results = [];
function check(name, cond, detail = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `\n      ${String(detail).slice(0, 600).replace(/\n/g, '\n      ')}` : ''}`);
  if (!cond) failures++;
}

const text = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const refOf = (snap, re) => { const m = new RegExp(re.source + '[^\\n]*?\\[ref=(e\\d+)\\]').exec(snap); return m && m[1]; };

// Minimal CDP client over Chrome's --remote-debugging-pipe (fd 3 = to Chrome, fd 4 = from Chrome).
function cdpPipe(proc) {
  let id = 0;
  let buf = Buffer.alloc(0);
  const pending = new Map();
  proc.stdio[4].on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const msg = JSON.parse(buf.subarray(0, i).toString());
      buf = buf.subarray(i + 1);
      const p = msg.id && pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject, method });
    proc.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0');
  });
  const evaluate = async (sessionId, expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate };
}

// Test-only port range, so the user's real Chrome profiles (which scan the default range) never join.
const TEST_PORT_START = 28765;
const TEST_PORT_COUNT = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/second') ? '<title>Second</title><h1>Second page</h1>' : PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH.');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));
  const chromeArgs = [
    `--user-data-dir=${userDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
    ...(process.env.HEADED ? [] : ['--headless=new']),
    'about:blank',
  ];
  // fds 3/4 are the CDP pipe (Chrome reads commands from fd 3, writes to fd 4)
  const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const browser = cdpPipe(chrome);
  const extId = (await browser.send('Extensions.loadUnpacked', { path: extPath })).id;
  console.log('extension loaded:', extId);
  // chrome://extensions page: turn on developer mode (enables error collection) and read errors later.
  const { targetId: extPageId } = await browser.send('Target.createTarget', { url: 'chrome://extensions' });
  const extPage = (await browser.send('Target.attachToTarget', { targetId: extPageId, flatten: true })).sessionId;
  await sleep(1000);
  await browser.evaluate(extPage, 'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
  // Point the test extension at the test port range.
  let swTarget;
  for (let i = 0; i < 50 && !swTarget; i++) {
    swTarget = (await browser.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (!swTarget) await sleep(100);
  }
  const sw = (await browser.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
  await browser.evaluate(sw, `chrome.storage.local.set({ settings: { enabled: true, profileLabel: 'E2E', token: '', portStart: ${TEST_PORT_START}, portCount: ${TEST_PORT_COUNT} } })`);
  const extensionErrors = () => browser.evaluate(extPage, `chrome.developerPrivate.getExtensionInfo(${JSON.stringify(extId)})
    .then((i) => [...i.runtimeErrors, ...i.manifestErrors].map((e) => (e.severity || 'MANIFEST') + ': ' + e.message + ' x' + (e.occurrences || 1)))`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, CHROME_BRIDGE_CONNECT_WAIT_MS: '30000', CHROME_BRIDGE_PORT_START: String(TEST_PORT_START), CHROME_BRIDGE_PORT_COUNT: String(TEST_PORT_COUNT) },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (process.env.VERBOSE) console.log(`\n=== ${name} ${JSON.stringify(args)}\n${text(r).slice(0, 1500)}`);
    return r;
  };

  try {
    const tools = await client.listTools();
    check('lists tools', tools.tools.length >= 20, tools.tools.map((t) => t.name).join(','));

    let r = await call('list_profiles');
    check('extension connects', /connected profile/.test(text(r)), text(r));
    if (r.isError || !/connected profile/.test(text(r))) throw new Error('extension did not connect; aborting');

    r = await call('tab_new', { url: base + '/' });
    check('tab_new opens page', /Bridge Test Page/.test(text(r)), text(r));

    r = await call('tabs_list');
    check('tabs_list shows agent tab', /AGENT TAB/.test(text(r)) && /Bridge Test Page/.test(text(r)), text(r));

    r = await call('snapshot');
    const snap = text(r);
    check('snapshot has heading', /heading "Bridge Test" \[level=1\]/.test(snap), snap);
    check('snapshot has textbox w/ label + value', /textbox "Your name" \[ref=e\d+\] value="old"/.test(snap), snap);
    check('snapshot lists select options', /combobox .*options=\["Red", "Green", "Blue"\]/.test(snap), snap);
    check('snapshot has intro text merged', /text: Some intro paragraph text\./.test(snap), snap);
    check('snapshot sees same-origin iframe', /button "Frame button"/.test(snap), snap);
    check('snapshot sees closed shadow root', /button "Shadow button"/.test(snap), snap);
    check('snapshot sees clickable div', /clickable "Clickable card"/.test(snap), snap);
    check('controlled tab shows the on-page Claude indicator', text(await call('evaluate', { expression: '!!document.querySelector("claude-bridge-indicator")' })) === 'true');
    check('indicator is left out of snapshots', !/Claude C\d/.test(snap), snap);

    const nameRef = refOf(snap, /textbox "Your name"/);
    const greetRef = refOf(snap, /button "Greet"/);
    r = await call('type', { ref: nameRef, text: 'Claude', clear: true });
    check('type ok', !r.isError, text(r));
    r = await call('click', { ref: greetRef });
    check('click ok', !r.isError, text(r));
    r = await call('get_text', { selector: '#out' });
    check('type+click result', /Hello, Claude/.test(text(r)), text(r));

    r = await call('type', { selector: '#name', text: ' Code' });
    r = await call('evaluate', { expression: 'document.getElementById("name").value' });
    check('type appends without clear', text(r) === 'Claude Code', text(r));

    r = await call('find', { query: 'card' });
    const cardRef = (/\[ref=(e\d+)\]/.exec(text(r)) || [])[1];
    check('find returns ref', !!cardRef, text(r));
    r = await call('click', { ref: cardRef });
    r = await call('evaluate', { expression: 'document.querySelector(".card").textContent' });
    check('clickable div clicked', text(r) === 'card clicked', text(r));

    r = await call('select_option', { selector: '#color', values: 'Blue' });
    check('select_option', /Selected: Blue/.test(text(r)), text(r));

    r = await call('find', { query: 'I agree' });
    const agreeRef = (/checkbox "I agree" \[ref=(e\d+)\]/.exec(text(r)) || [])[1];
    r = await call('click', { ref: agreeRef });
    r = await call('evaluate', { expression: 'document.getElementById("agree").checked' });
    check('checkbox click', text(r) === 'true', text(r));

    r = await call('find', { query: 'Frame button' });
    const frameRef = (/\[ref=(e\d+)\]/.exec(text(r)) || [])[1];
    r = await call('click', { ref: frameRef });
    r = await call('evaluate', { expression: 'document.querySelector("iframe").contentDocument.querySelector("button").textContent' });
    check('click inside same-origin iframe', text(r) === 'frame ok', text(r));

    r = await call('find', { query: 'Shadow button' });
    const shadowRef = (/\[ref=(e\d+)\]/.exec(text(r)) || [])[1];
    r = await call('click', { ref: shadowRef });
    r = await call('find', { query: 'shadow ok' });
    check('click inside closed shadow root', /shadow ok/.test(text(r)), text(r));

    r = await call('press_key', { keys: 'Escape' });
    r = await call('get_text', { selector: '#keys' });
    check('press_key Escape', /escape pressed/.test(text(r)), text(r));

    r = await call('type', { selector: '#ta', text: 'abc', slowly: true });
    r = await call('press_key', { keys: ['Control+a', 'Backspace'] });
    r = await call('type', { selector: '#ta', text: 'xyz' });
    r = await call('evaluate', { expression: 'document.getElementById("ta").value' });
    check('slow typing + Control+A + Backspace', text(r) === 'xyz', text(r));

    r = await call('evaluate', { expression: 'const a = 2; return a * 21;' });
    check('evaluate with return', text(r) === '42', text(r));
    r = await call('evaluate', { expression: 'await new Promise(r => setTimeout(() => r({ok: true}), 50))' });
    check('evaluate top-level await', /"ok": true/.test(text(r)), text(r));
    r = await call('evaluate', { expression: 'throw new Error("boom")' });
    check('evaluate error reported', r.isError && /boom/.test(text(r)), text(r));

    r = await call('console_messages');
    check('console captured log', /clicked go 42/.test(text(r)), text(r));

    r = await call('screenshot');
    const img = (r.content || []).find((c) => c.type === 'image');
    check('screenshot returns image', !!img && img.data.length > 1000, text(r));
    r = await call('screenshot', { selector: 'h1', format: 'png' });
    check('element screenshot', !!(r.content || []).find((c) => c.type === 'image'), text(r));
    r = await call('screenshot', { fullPage: true });
    check('full page screenshot', !!(r.content || []).find((c) => c.type === 'image') && /full page/.test(text(r)), text(r));

    r = await call('scroll', { deltaY: 800 });
    check('scroll moves page', /Page scroll is now 0,8\d\d|Page scroll is now 0,[1-9]\d\d/.test(text(r)), text(r));
    r = await call('scroll', { selector: '#bottom' });
    check('scroll into view', /into view/.test(text(r)), text(r));

    r = await call('wait_for', { text: 'Late content', timeoutMs: 5000 });
    check('wait_for text', /Condition met/.test(text(r)), text(r));
    r = await call('wait_for', { selector: '#never', timeoutMs: 800 });
    check('wait_for timeout errors', r.isError, text(r));

    r = await call('upload_file', { selector: '#file', paths: [serverPath] });
    r = await call('get_text', { selector: '#out' });
    check('upload_file', /file: index\.js/.test(text(r)), text(r));

    r = await call('hover', { selector: 'h1' });
    check('hover', !r.isError, text(r));

    // dialog
    r = await call('find', { query: 'Confirm me' });
    const confirmRef = (/\[ref=(e\d+)\]/.exec(text(r)) || [])[1];
    r = await call('click', { ref: confirmRef });
    check('click reports dialog', /dialog/.test(text(r)), text(r));
    r = await call('snapshot');
    check('blocked while dialog open', r.isError && /handle_dialog/.test(text(r)), text(r));
    r = await call('handle_dialog', { accept: false });
    check('handle_dialog', /Dismissed confirm/.test(text(r)), text(r));
    r = await call('get_text', { selector: '#out' });
    check('dialog result', /cancelled/.test(text(r)), text(r));

    // new tab from target=_blank
    r = await call('find', { query: 'Open second' });
    const openRef = (/\[ref=(e\d+)\]/.exec(text(r)) || [])[1];
    r = await call('click', { ref: openRef });
    const newTab = (/opened a new tab \[tab (\d+)\]/.exec(text(r)) || [])[1];
    check('click reports new tab', !!newTab, text(r));
    if (newTab) {
      r = await call('tab_select', { tabId: Number(newTab) });
      r = await call('snapshot', { interactiveOnly: true });
      check('new tab snapshot', /Second page/.test(text(r)), text(r));
      r = await call('tab_close', {});
      check('tab_close', /Closed/.test(text(r)), text(r));
    }

    r = await call('tabs_list');
    const testTab = (/\[tab (\d+)\] Bridge Test Page/.exec(text(r)) || [])[1];
    r = await call('tab_select', { tabId: Number(testTab) });
    r = await call('click', { selector: '#samelink' });
    check('click navigates', /Navigated to .*\/second/.test(text(r)), text(r));
    r = await call('navigate', { url: 'back' });
    check('navigate back', /Bridge Test Page/.test(text(r)), text(r));
    r = await call('navigate', { url: 'reload' }); // fresh document (back may restore from bfcache)
    r = await call('snapshot', { ref: nameRef });
    check('stale ref after navigation errors (refs never reused)', r.isError && /no longer attached|not found/.test(text(r)), text(r));
    r = await call('snapshot', { interactiveOnly: true });
    const newNameRef = refOf(text(r), /textbox "Your name"/);
    check('refs keep counting across navigations', newNameRef && newNameRef !== nameRef, `${nameRef} vs ${newNameRef}`);

    r = await call('navigate', { url: 'chrome://settings' });
    r = await call('snapshot');
    check('restricted page error', r.isError && /does not allow/.test(text(r)), text(r));

    // ---- a second, simultaneous Claude session (its own server on the next port)
    const clientB = new Client({ name: 'e2e-b', version: '1.0.0' });
    await clientB.connect(new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, CHROME_BRIDGE_CONNECT_WAIT_MS: '30000', CHROME_BRIDGE_PORT_START: String(TEST_PORT_START), CHROME_BRIDGE_PORT_COUNT: String(TEST_PORT_COUNT), CHROME_BRIDGE_SESSION_NAME: 'second-project' },
      stderr: 'pipe',
    }));
    const callB = (name, args = {}) => clientB.callTool({ name, arguments: args });
    r = await callB('tab_new', { url: base + '/second' });
    check('session B opens its own tab', /Second/.test(text(r)), text(r));
    const tabB = Number((/\[tab (\d+)\]/.exec(text(r)) || [])[1]);
    r = await callB('tab_select', { tabId: Number(testTab) });
    check('session B cannot grab session A\'s tab', r.isError && /another Claude session/.test(text(r)), text(r));
    r = await call('tabs_list');
    check('session A sees B\'s tab as foreign', new RegExp(`\\[tab ${tabB}\\].*controlled by other Claude session "second-project"`).test(text(r)), text(r));
    r = await call('snapshot', { tabId: tabB });
    check('session A refused on B\'s tab', r.isError && /another Claude session/.test(text(r)), text(r));
    r = await callB('snapshot', { interactiveOnly: true });
    check('session B keeps working in its tab', /Second page/.test(text(r)), text(r));

    // ---- dashboard (popup / side panel) status
    const { targetId: popupId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html?panel=1` });
    const popup = (await browser.send('Target.attachToTarget', { targetId: popupId, flatten: true })).sessionId;
    await sleep(1500);
    const st = await browser.evaluate(popup, `chrome.runtime.sendMessage({ type: 'getStatus' })`);
    const brief = JSON.stringify(st.sessions.map((s) => ({ n: s.number, label: s.label, tab: s.tab && s.tab.url, acts: s.activity.length })));
    check('dashboard lists both sessions with their tab URL', st.sessions.length === 2 &&
      st.sessions.every((s) => s.tab && s.tab.url) && st.sessions.some((s) => s.label === 'second-project' && /\/second/.test(s.tab.url)), brief);
    check('dashboard has per-session activity', st.sessions.every((s) => s.activity.length > 0), brief);
    const groups = await browser.evaluate(popup, `chrome.tabGroups.query({}).then((g) => g.map((x) => x.title + ':' + x.color))`);
    check('each session\'s tabs are in its own tab group', groups.some((t) => /^Claude · second-project:/.test(t)) && groups.length === 2, JSON.stringify(groups));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false }, popup);
    await sleep(1200);
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, popup);
    if (process.env.DASHBOARD_SHOT) fs.writeFileSync(process.env.DASHBOARD_SHOT, Buffer.from(shot.data, 'base64'));

    // ---- "Copy prompt for Claude": the prompt names the profile, the tab, and how to connect
    check('extension learned the server script path', /server[\\/]index\.js$/.test(st.serverScript || ''), st.serverScript);
    const owned = await browser.evaluate(popup, `chrome.runtime.sendMessage({ type: 'getStatus' }).then(async (st) => {
      const tab = await chrome.tabs.get(${Number(testTab)});
      const owner = st.sessions.find((s) => s.tab && s.tab.id === tab.id) || null;
      return buildPrompt(st, tab, owner, 'Click the Increment button');
    })`);
    check('prompt names profile, tab id and URL', owned.includes(`profile "E2E"`) && owned.includes(`tab_select with tabId ${Number(testTab)}`) && /\n- URL: \S+/.test(owned), owned);
    check('prompt for a tab another session holds says takeOver', /takeOver: true/.test(owned) && /Session C\d/.test(owned), owned);
    check('prompt includes the task and the setup fallback', owned.includes('Task: Click the Increment button') && /claude mcp add --scope user chrome-bridge -- node ".*server\/index\.js"/.test(owned), owned);
    const free = await browser.evaluate(popup, `chrome.runtime.sendMessage({ type: 'getStatus' }).then((st) =>
      buildPrompt(st, { id: 999999, title: 'Free', url: 'https://example.com/' }, null, ''))`);
    check('prompt for a free tab has no takeOver', !/takeOver/.test(free) && /wait for my instructions/.test(free), free);
    const ownerText = await browser.evaluate(popup, `document.getElementById('tabStatus').textContent + '|' + document.getElementById('copyPrompt').disabled`);
    check('popup refuses to hand over a chrome-extension:// page', /can't control this page/.test(ownerText) && ownerText.endsWith('|true'), ownerText);

    // "This tab" status, as seen while the user is on a controlled tab and on a free tab.
    const viewAs = async (tabExpr) => {
      await browser.evaluate(popup, `(() => {
        const realQuery = chrome.tabs.__realQuery || chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.__realQuery = realQuery;
        chrome.tabs.query = async (q) => (q && q.active && q.currentWindow) ? [await (${tabExpr})] : realQuery(q);
        return refresh();
      })()`);
      return browser.evaluate(popup, `({ status: document.getElementById('tabStatus').textContent, give: document.getElementById('give').open,
        summary: document.getElementById('giveSummary').textContent, here: !!document.querySelector('.card .here') })`);
    };
    let view = await viewAs(`chrome.tabs.get(${tabB})`);
    check('popup says a controlled tab is controlled, and by which session', /Controlled by Claude/.test(view.status) && /second-project/.test(view.status) && view.here && !view.give && /different session/.test(view.summary), JSON.stringify(view));
    if (process.env.DASHBOARD_SHOT) {
      const s2 = await browser.send('Page.captureScreenshot', { format: 'png' }, popup);
      fs.writeFileSync(process.env.DASHBOARD_SHOT.replace(/(\.png)?$/, '-controlled.png'), Buffer.from(s2.data, 'base64'));
    }
    view = await viewAs(`({ id: 999999, windowId: 1, title: 'Free page', url: 'https://example.com/' })`);
    check('popup says a free tab is not controlled and offers to give it', /Not controlled by Claude/.test(view.status) && view.give, JSON.stringify(view));
    if (process.env.DASHBOARD_SHOT) {
      const s3 = await browser.send('Page.captureScreenshot', { format: 'png' }, popup);
      fs.writeFileSync(process.env.DASHBOARD_SHOT.replace(/(\.png)?$/, '-free.png'), Buffer.from(s3.data, 'base64'));
    }
    await browser.evaluate(popup, `(() => { chrome.tabs.query = chrome.tabs.__realQuery; return refresh(); })()`);

    r = await callB('tab_select', { tabId: Number(testTab), takeOver: true });
    check('takeOver lets a session take a tab when asked', !r.isError, text(r));
    const hasIndicator = (tabId) => browser.evaluate(popup, `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => !!document.querySelector('claude-bridge-indicator') }).then(([r]) => r.result)`);
    check('indicator leaves a tab its session switched away from', (await hasIndicator(tabB)) === false);
    await callB('tab_select', { tabId: tabB });
    await sleep(300);
    check('indicator shows on the tab a session switches to', (await hasIndicator(tabB)) === true);
    if (process.env.INDICATOR_SHOT) {
      // Screenshot of a controlled page as the user sees it (with the on-page marker).
      const t = (await browser.send('Target.getTargets')).targetInfos.find((x) => x.type === 'page' && /\/second/.test(x.url));
      const s = (await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 560, deviceScaleFactor: 1, mobile: false }, s);
      await sleep(600);
      const img = await browser.send('Page.captureScreenshot', { format: 'png' }, s);
      fs.writeFileSync(process.env.INDICATOR_SHOT, Buffer.from(img.data, 'base64'));
    }
    await clientB.close();
    await sleep(500);
    const groupsAfter = await browser.evaluate(popup, `chrome.tabGroups.query({}).then((g) => g.map((x) => x.title))`);
    check('ended session\'s group is marked ended', groupsAfter.some((t) => /second-project \(ended\)/.test(t)), JSON.stringify(groupsAfter));
    check('indicator disappears when the controlling session ends', (await hasIndicator(tabB)) === false);

    // The Claude session ends: the server goes away while the extension keeps scanning for sessions.
    await client.close().catch(() => {});
    await sleep(8000);
    const errs = await extensionErrors();
    check('extension Errors page stays empty (incl. idle scanning after the session ended)', errs.length === 0, errs.join('\n'));
  } finally {
    console.log(results.join('\n'));
    console.log(`\n${results.length - failures}/${results.length} checks passed`);
    await client.close().catch(() => {});
    chrome.kill();
    site.close();
    setTimeout(() => { try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) { /* locked */ } process.exit(failures ? 1 : 0); }, 1500);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
