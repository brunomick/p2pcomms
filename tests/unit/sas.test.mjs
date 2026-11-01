import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS } from '../../src/wordlist.js';
import { extractFingerprint, isCommitter, sasWords, runSasExchange } from '../../src/sas.js';

const FP_A = 'sha-256 4A:1B:00:FF';
const FP_B = 'sha-256 0C:9D:7E:21';
const N1 = 'aa'.repeat(32);
const N2 = 'bb'.repeat(32);

const FINGERPRINT = '4A:1B:C3:5E:77:09:D2:A8:31:6F:EE:10:92:B4:5C:0D:E7:83:2A:F1:64:9B:CC:38:70:AD:15:4E:B9:26:D0:9F';
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:Xk3p',
  'a=ice-pwd:d8Zq1mV0c5rT7uYh2nBw9LsE',
  'a=fingerprint:sha-256 ' + FINGERPRINT.toLowerCase(),
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  ''
].join('\r\n');

test('extractFingerprint reads the sha-256 line', () => {
  assert.equal(extractFingerprint(SDP), 'sha-256 ' + FINGERPRINT);
  assert.equal(extractFingerprint(SDP.replace(/\r\n/g, '\n')), 'sha-256 ' + FINGERPRINT);
  assert.throws(() => extractFingerprint('v=0\r\ns=-\r\na=setup:actpass\r\n'), { message: 'no-fingerprint' });
});

test('isCommitter is true for the smaller id only', () => {
  assert.equal(isCommitter('a', 'b'), true);
  assert.equal(isCommitter('b', 'a'), false);
});

test('sasWords maps the first 44 bits of the digest to four indices, big-endian', async () => {
  // sha256('sha-256 0C:9D:7E:21|sha-256 4A:1B:00:FF|aa..aa|bb..bb') = 24449d2410af...
  // first 44 bits = 0x24449d2410a, split into 11-bit groups: 290, 295, 584, 266 (done by hand from the hex)
  const words = await sasWords(FP_A, FP_B, N1, N2);
  assert.deepEqual(words, [290, 295, 584, 266].map(i => WORDS[i]));
  assert.deepEqual(words, ['bufon', 'burla', 'edad', 'bosque']);
});

test('sasWords is symmetric in fingerprint order', async () => {
  const x = await sasWords(FP_A, FP_B, N1, N2);
  const y = await sasWords(FP_B, FP_A, N1, N2);
  assert.deepEqual(x, y);
  assert.equal(x.length, 4);
  for (const w of x) assert.ok(WORDS.includes(w));
});

test('sasWords changes with any input', async () => {
  const base = (await sasWords(FP_A, FP_B, N1, N2)).join(' ');
  const variants = [
    await sasWords('sha-256 4A:1B:00:FE', FP_B, N1, N2),
    await sasWords(FP_A, 'sha-256 0C:9D:7E:22', N1, N2),
    await sasWords(FP_A, FP_B, 'ab'.repeat(32), N2),
    await sasWords(FP_A, FP_B, N1, 'bc'.repeat(32)),
    await sasWords(FP_A, FP_B, N2, N1)
  ];
  for (const v of variants) assert.notEqual(v.join(' '), base);
});

// In-memory link between two endpoints. `tamper(msg)` may rewrite what a sends to b.
function link(tamper = m => m) {
  const handlers = { a: null, b: null };
  const deliver = (to, msg) => queueMicrotask(() => handlers[to]?.(msg));
  return {
    a: { send: m => deliver('b', tamper(m)), subscribe: h => { handlers.a = h; } },
    b: { send: m => deliver('a', m), subscribe: h => { handlers.b = h; } }
  };
}

test('honest exchange gives both sides the same words', async () => {
  const { a, b } = link();
  const [wa, wb] = await Promise.all([
    runSasExchange({ selfId: 'a', peerId: 'b', localFp: FP_A, remoteFp: FP_B, ...a }),
    runSasExchange({ selfId: 'b', peerId: 'a', localFp: FP_B, remoteFp: FP_A, ...b })
  ]);
  assert.deepEqual(wa, wb);
  assert.equal(wa.length, 4);
});

test('two exchanges produce different words (fresh nonces)', async () => {
  const run = async () => {
    const { a, b } = link();
    const [w] = await Promise.all([
      runSasExchange({ selfId: 'a', peerId: 'b', localFp: FP_A, remoteFp: FP_B, ...a }),
      runSasExchange({ selfId: 'b', peerId: 'a', localFp: FP_B, remoteFp: FP_A, ...b })
    ]);
    return w.join(' ');
  };
  assert.notEqual(await run(), await run());
});

test('tampered reveal is rejected', async () => {
  const { a, b } = link(m => (m.t === 'reveal' ? { t: 'reveal', n: 'cc'.repeat(32) } : m));
  const committer = runSasExchange({ selfId: 'a', peerId: 'b', localFp: FP_A, remoteFp: FP_B, ...a });
  const responder = runSasExchange({ selfId: 'b', peerId: 'a', localFp: FP_B, remoteFp: FP_A, ...b });
  await assert.rejects(responder, { message: 'sas-commit-mismatch' });
  await committer; // committer verifies nothing and still finishes
});

test('reveal before nonce is a protocol error', async () => {
  let handler;
  const p = runSasExchange({
    selfId: 'b', peerId: 'a', localFp: FP_B, remoteFp: FP_A,
    send: () => {}, subscribe: h => { handler = h; }
  });
  handler({ t: 'reveal', n: N1 });
  await assert.rejects(p, { message: 'sas-protocol' });
});

test('duplicate or unexpected messages are protocol errors', async () => {
  const start = (selfId, peerId) => {
    let handler;
    const p = runSasExchange({
      selfId, peerId, localFp: FP_A, remoteFp: FP_B,
      send: () => {}, subscribe: h => { handler = h; }
    });
    return { p, push: m => handler(m) };
  };

  // responder: second commit while waiting for the reveal
  const r = start('b', 'a');
  r.push({ t: 'commit', h: '00'.repeat(32) });
  r.push({ t: 'commit', h: '11'.repeat(32) });
  await assert.rejects(r.p, { message: 'sas-protocol' });

  // committer: a reveal (or any non-nonce) instead of the nonce
  const c = start('a', 'b');
  c.push({ t: 'reveal', n: N1 });
  await assert.rejects(c.p, { message: 'sas-protocol' });

  // committer: unrecognised garbage
  const g = start('a', 'b');
  g.push(null);
  await assert.rejects(g.p, { message: 'sas-protocol' });
});
