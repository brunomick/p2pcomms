// End-to-end test: opens dist/p2pcomms.html from file:// in headless Chrome tabs and drives it over CDP.
// Uses real public Nostr relays, so connection times vary (typically 3-10 s).
// Usage: npm run build && npm run test:e2e   (Chrome path from the CHROME env var)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = pathToFileURL(join(root, 'dist', 'p2pcomms.html')).href;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333 + Math.floor(Math.random() * 500);
const CONNECTED = 'Direct';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs in every page before its own scripts: records peer connections, getUserMedia calls and
// the wall-clock moment #status first reads "Direct".
const INIT = `(() => {
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Orig {
    constructor(...args) { super(...args); window.__pcs.push(this); }
  };
  window.__gum = 0;
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = (...args) => { window.__gum++; return gum(...args); };
  window.__connectedAt = null;
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('status');
    if (!el) return;
    const check = () => {
      if (window.__connectedAt === null && el.textContent.trim() === ${JSON.stringify(CONNECTED)}) window.__connectedAt = Date.now();
    };
    new MutationObserver(check).observe(el, { childList: true, characterData: true, subtree: true });
    check();
  });
})()`;

const profile = mkdtempSync(join(tmpdir(), 'p2pcomms-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });

async function http(path, method = 'GET') {
  for (let i = 0; i < 75; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
      const text = await res.text();
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      await sleep(200);
    }
  }
  throw new Error('CDP endpoint not reachable');
}

async function openTab(name) {
  const target = await http('/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let id = 0;
  const pending = {};
  // Network bookkeeping for the relays-closed scenario.
  const sockets = new Map(); // requestId -> { url, closed }
  const frameTimes = []; // monotonic seconds
  let monoToWallMs = null;
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending[m.id]) {
      pending[m.id](m);
      delete pending[m.id];
      return;
    }
    const p = m.params;
    switch (m.method) {
      case 'Network.webSocketCreated':
        sockets.set(p.requestId, { url: p.url, closed: false });
        break;
      case 'Network.webSocketWillSendHandshakeRequest':
        monoToWallMs = p.wallTime * 1000 - p.timestamp * 1000;
        break;
      case 'Network.webSocketClosed': {
        const s = sockets.get(p.requestId);
        if (s) s.closed = true;
        break;
      }
      case 'Network.webSocketFrameSent':
        frameTimes.push(p.timestamp);
        break;
    }
  });
  const send = (method, params = {}) =>
    new Promise(resolve => {
      pending[++id] = resolve;
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${name}: ${r.result.exceptionDetails.exception?.description ?? 'evaluation failed'}`);
    return r.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await send('Page.navigate', { url: PAGE });
  const t0 = Date.now();
  while ((await ev('document.readyState').catch(() => '')) !== 'complete') {
    if (Date.now() - t0 > 15000) throw new Error(`${name}: page did not load`);
    await sleep(100);
  }
  return {
    name,
    ev,
    sockets,
    framesSentAfter: wallMs => (monoToWallMs === null ? null : frameTimes.filter(t => t * 1000 + monoToWallMs > wallMs)),
    // Page.close runs the page's beforeunload hooks, like a user closing the tab.
    close: async () => {
      await Promise.race([send('Page.close'), sleep(3000)]);
      ws.close();
    }
  };
}

// Page-side helpers, prefixed to expressions.
const H = `const $ = id => document.getElementById(id);
const visible = id => { const el = $(id); return !!el && el.getClientRects().length > 0; };
const text = id => ($(id)?.textContent ?? '').trim();
const click = id => { const el = $(id); if (!el) throw new Error('missing #' + id); el.click(); };
const type = (id, v) => { const el = $(id); if (!el) throw new Error('missing #' + id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const connectedPcs = () => window.__pcs.filter(pc => pc.connectionState === 'connected');`;
const run = (tab, body) => tab.ev(`(async () => { ${H}\n${body} })()`);

async function waitFor(tab, body, timeoutMs, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await run(tab, body).catch(e => `error: ${e.message}`);
    if (last === true) return Date.now() - t0;
    await sleep(250);
  }
  throw new Error(`${tab.name}: timed out after ${timeoutMs / 1000} s waiting for ${what} (last: ${JSON.stringify(last)})`);
}

const results = [];
async function scenario(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
    return true;
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name} - ${e.message}`);
    return false;
  }
}

const status = tab => run(tab, `return text('status');`);

try {
  const A = await openTab('A');
  const B = await openTab('B');
  let code;

  const connected = await scenario('connect-and-chat', async () => {
    await run(A, `click('btn-new');`);
    await waitFor(A, `return /^[a-z]+(-[a-z]+){3}$/.test(text('code-display'));`, 10000, 'code on #code-display');
    code = await run(A, `return text('code-display');`);
    await run(B, `click('btn-have-code'); type('code-input', ${JSON.stringify(code)}); click('btn-connect');`);
    const ms = await Promise.all([
      waitFor(A, `return text('status') === ${JSON.stringify(CONNECTED)};`, 60000, `"${CONNECTED}"`),
      waitFor(B, `return text('status') === ${JSON.stringify(CONNECTED)};`, 60000, `"${CONNECTED}"`)
    ]);
    await run(A, `type('chat-input', 'hello'); click('btn-send');`);
    await waitFor(B, `return text('chat-log').includes('hello');`, 10000, '"hello" in #chat-log');
    return `code ${code}, connected after ${(Math.max(...ms) / 1000).toFixed(1)} s`;
  });

  await scenario('sas-match', async () => {
    if (!connected) throw new Error('not connected');
    const words = `const w = text('sas-words').split(/\\s+/).filter(Boolean); return w.length === 4 ? w : null;`;
    await waitFor(A, `return (() => { ${words} })() !== null;`, 15000, '4 words in #sas-words');
    await waitFor(B, `return (() => { ${words} })() !== null;`, 15000, '4 words in #sas-words');
    const [wa, wb] = [await run(A, words), await run(B, words)];
    if (wa.join(' ') !== wb.join(' ')) throw new Error(`A: ${wa.join(' ')} / B: ${wb.join(' ')}`);
    return wa.join(' ');
  });

  await scenario('relays-closed', async () => {
    if (!connected) throw new Error('not connected');
    const at = { A: await A.ev('window.__connectedAt'), B: await B.ev('window.__connectedAt') };
    const wait = Math.max(at.A, at.B) + 15000 - Date.now();
    if (wait > 0) await sleep(wait);
    const problems = [];
    let total = 0;
    for (const tab of [A, B]) {
      total += tab.sockets.size;
      const open = [...tab.sockets.values()].filter(s => !s.closed).map(s => s.url);
      if (open.length) problems.push(`${tab.name} open: ${open.join(', ')}`);
      const late = tab.framesSentAfter(at[tab.name]);
      if (late === null) problems.push(`${tab.name}: no WebSocket handshake seen, cannot time frames`);
      else if (late.length) problems.push(`${tab.name}: ${late.length} frame(s) sent after connected`);
    }
    if (total === 0) problems.push('no WebSockets observed at all');
    if (problems.length) throw new Error(problems.join('; '));
    return `${total} sockets created, all closed, no frames after connected`;
  });

  // An offline->online blip must not reopen the relays (Trystero's 'online' listener is disabled).
  await scenario('relays-stay-closed-on-online', async () => {
    if (!connected) throw new Error('not connected');
    const before = { A: A.sockets.size, B: B.sockets.size };
    const t = Date.now();
    for (const tab of [A, B]) await tab.ev(`window.dispatchEvent(new Event('online')), true`);
    await sleep(10000);
    const problems = [];
    for (const tab of [A, B]) {
      if (tab.sockets.size !== before[tab.name]) problems.push(`${tab.name}: ${tab.sockets.size - before[tab.name]} new WebSocket(s)`);
      const open = [...tab.sockets.values()].filter(s => !s.closed).length;
      if (open) problems.push(`${tab.name}: ${open} open WebSocket(s)`);
      const late = tab.framesSentAfter(t);
      if (late === null || late.length) problems.push(`${tab.name}: ${late === null ? 'cannot time frames' : `${late.length} frame(s) sent`}`);
    }
    if (problems.length) throw new Error(problems.join('; '));
    return 'no new WebSocket and no frames in 10 s after "online"';
  });

  let C;
  await scenario('third-peer-rejected', async () => {
    if (!connected) throw new Error('not connected');
    C = await openTab('C');
    await run(C, `click('btn-have-code'); type('code-input', ${JSON.stringify(code)}); click('btn-connect');`);
    await waitFor(C, `return text('status').startsWith('Waiting');`, 15000, '"Waiting…"');
    await sleep(20000);
    const problems = [];
    const sc = await status(C);
    if (!sc.startsWith('Waiting')) problems.push(`C status "${sc}"`);
    for (const tab of [A, B]) {
      const st = await status(tab);
      if (st !== CONNECTED) problems.push(`${tab.name} status "${st}"`);
      const n = await run(tab, `return connectedPcs().length;`);
      if (n !== 1) problems.push(`${tab.name} has ${n} connected peer connections`);
    }
    if (problems.length) throw new Error(problems.join('; '));
    return 'C still waiting after 20 s; A and B have exactly one connected peer';
  });
  if (C) await C.close().catch(() => {});

  await scenario('call-consent', async () => {
    if (!connected) throw new Error('not connected');
    await run(A, `click('btn-call-audio');`);
    await waitFor(B, `return visible('incoming');`, 15000, '#incoming visible');
    const gum = await B.ev('window.__gum');
    if (gum !== 0) throw new Error(`B called getUserMedia ${gum} time(s) before accepting`);
    await run(B, `click('btn-accept-audio');`);
    const bytes = `const pc = connectedPcs()[0]; let b = 0;
      if (pc) (await pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') b += s.bytesReceived; });
      return b;`;
    await waitFor(A, `return (await (async () => { ${bytes} })()) > 0;`, 10000, 'inbound audio bytes on A');
    // Proves the counter works, so the "=== 0" check above is not vacuous.
    const gumAfter = await B.ev('window.__gum');
    if (!(gumAfter > 0)) throw new Error(`B getUserMedia count after accepting is ${gumAfter}`);
    // Audio-only call: no (black) video boxes on either side.
    for (const tab of [A, B]) {
      const shown = await run(tab, `return ['video-remote', 'video-local'].filter(visible);`);
      if (shown.length) throw new Error(`${tab.name}: visible in an audio-only call: ${shown.join(', ')}`);
    }
    return `A received ${await run(A, bytes)} audio bytes; B getUserMedia calls before accept: 0, after: ${gumAfter}; no video boxes`;
  });

  await scenario('peer-left', async () => {
    if (!connected) throw new Error('not connected');
    await B.close();
    const ms = await waitFor(A, `return document.body.innerText.includes('Peer left.') && visible('screen-start');`, 15000, '"Peer left." on the start screen');
    return `after ${(ms / 1000).toFixed(1)} s`;
  });

  // Not in the original list: after peer-left, A must be able to connect again without reloading.
  let D;
  const reconnected = await scenario('reconnect-after-peer-left', async () => {
    if (!connected) throw new Error('not connected');
    D = await openTab('D');
    await run(A, `click('btn-new');`);
    await waitFor(A, `return /^[a-z]+(-[a-z]+){3}$/.test(text('code-display')) && text('code-display') !== ${JSON.stringify(code)};`, 10000, 'new code');
    const code2 = await run(A, `return text('code-display');`);
    await run(D, `click('btn-have-code'); type('code-input', ${JSON.stringify(code2)}); click('btn-connect');`);
    await Promise.all([
      waitFor(A, `return text('status') === ${JSON.stringify(CONNECTED)} && text('chat-log') === '';`, 60000, `"${CONNECTED}" with an empty chat`),
      waitFor(D, `return text('status') === ${JSON.stringify(CONNECTED)};`, 60000, `"${CONNECTED}"`)
    ]);
    await run(D, `type('chat-input', 'again'); click('btn-send');`);
    await waitFor(A, `return text('chat-log').includes('again');`, 10000, '"again" in #chat-log');
    return `A connected to D with ${code2}`;
  });

  // "Leave" must close the direct connection now, not when Trystero's ~2 min idle timer fires.
  await scenario('leave-closes-direct', async () => {
    if (!reconnected) throw new Error('A and D not connected');
    await run(A, `click('btn-leave');`);
    const ms = await waitFor(D, `return document.body.innerText.includes('Peer left.') && connectedPcs().length === 0;`, 15000, 'peer-left and no connected RTCPeerConnection on D');
    const states = { A: await run(A, `return window.__pcs.map(pc => pc.connectionState);`), D: await run(D, `return window.__pcs.map(pc => pc.connectionState);`) };
    if (states.A.includes('connected')) throw new Error(`A still has a connected RTCPeerConnection: ${states.A.join(', ')}`);
    return `D saw peer-left and lost the connection after ${(ms / 1000).toFixed(1)} s; A pcs: ${states.A.join(', ')}; D pcs: ${states.D.join(', ')}`;
  });
} catch (e) {
  console.log(`FAIL harness - ${e.message}`);
  results.push({ name: 'harness', ok: false });
} finally {
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
