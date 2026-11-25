// Protocol/security test without Chrome: origin check, token handshake, multi-session ports.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest('hex');
let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + d}`); if (!c) fails++; };

function startServer(env) {
  const p = spawn(process.execPath, ['index.js'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    p.stderr.on('data', (d) => { const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(d.toString()); if (m) resolve({ p, port: Number(m[1]) }); });
  });
}

function connect(port, { origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', token = '' } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, origin ? { origin } : {});
    const clientNonce = 'cn123';
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => {});
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'challenge') ws.send(JSON.stringify({ type: 'hello', profileId: 'p1', label: 'Test', clientNonce, proof: token ? hmac(token, 'client:' + m.nonce) : null }));
      if (m.type === 'welcome') { resolve({ welcome: m, serverProofOk: m.proof === (token ? hmac(token, 'server:' + clientNonce) : null) }); ws.close(); }
    });
    ws.on('close', (code) => resolve({ closed: code }));
  });
}

const a = await startServer({ CHROME_BRIDGE_PORT_START: '28765', CHROME_BRIDGE_PORT_COUNT: '3' });
const b = await startServer({ CHROME_BRIDGE_PORT_START: '28765', CHROME_BRIDGE_PORT_COUNT: '3', CHROME_BRIDGE_TOKEN: 's3cret' });
check('first session binds first port', a.port === 28765, a.port);
check('second session binds next port', b.port === 28766, b.port);

let r = await connect(a.port, { origin: 'https://evil.example' });
check('web page origin rejected', r.status === 403, JSON.stringify(r));
r = await connect(a.port, { origin: null });
check('missing origin rejected', r.status === 403, JSON.stringify(r));
r = await connect(a.port);
check('extension origin accepted (no token)', !!r.welcome && r.welcome.server.pid > 0, JSON.stringify(r));
r = await connect(b.port, { token: 'wrong' });
check('wrong token rejected', r.closed === 4001, JSON.stringify(r));
r = await connect(b.port, { token: 's3cret' });
check('right token accepted + server proves token', !!r.welcome && r.serverProofOk, JSON.stringify(r));

a.p.kill(); b.p.kill();
process.exit(fails ? 1 : 0);
