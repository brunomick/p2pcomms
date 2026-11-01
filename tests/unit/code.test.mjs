import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { WORDS } from '../../src/wordlist.js';
import { APP_ID, generateCode, normalizeCode, deriveRoomSecrets } from '../../src/code.js';

test('WORDS has 2048 unique ascii words', () => {
  assert.equal(WORDS.length, 2048);
  assert.equal(new Set(WORDS).size, 2048);
  for (const w of WORDS) assert.match(w, /^[a-z]+$/);
});

test('APP_ID is p2pcomms-v1', () => {
  assert.equal(APP_ID, 'p2pcomms-v1');
});

test('generateCode uses 4 words from WORDS', () => {
  const seen = [];
  const code = generateCode(n => {
    seen.push(n);
    return [0, 1, 2047, 2048 + 5];
  });
  assert.deepEqual(seen, [4]);
  assert.equal(code, `${WORDS[0]}-${WORDS[1]}-${WORDS[2047]}-${WORDS[5]}`);
});

test('generateCode default random yields a valid code', () => {
  const c = generateCode();
  assert.equal(normalizeCode(c), c);
});

test('normalizeCode tolerates case, accents, spacing, separators', () => {
  const c = generateCode(() => [10, 500, 1000, 2000]);
  assert.equal(normalizeCode(c.toUpperCase()), c);
  assert.equal(normalizeCode('  ' + c.replaceAll('-', ' ,  ') + ' '), c);
  const accented = c.replace(/[aeiou]/, v => v + '́');
  assert.notEqual(accented, c);
  assert.equal(normalizeCode(accented), c);
});

test('normalizeCode rejects wrong word count or unknown word', () => {
  const [a, b, c, d, e] = [WORDS[3], WORDS[4], WORDS[5], WORDS[6], WORDS[7]];
  assert.equal(normalizeCode([a, b, c].join('-')), null);
  assert.equal(normalizeCode([a, b, c, d, e].join('-')), null);
  assert.equal(normalizeCode([a, b, c, 'zzzz'].join('-')), null);
  assert.equal(normalizeCode(''), null);
});

test('deriveRoomSecrets is deterministic and code-dependent', async () => {
  const c1 = generateCode(() => [1, 2, 3, 4]);
  const c2 = generateCode(() => [1, 2, 3, 5]);
  const a = await deriveRoomSecrets(c1, 1000);
  const b = await deriveRoomSecrets(c1, 1000);
  const other = await deriveRoomSecrets(c2, 1000);
  assert.deepEqual(a, b);
  assert.notEqual(a.roomId, other.roomId);
  assert.notEqual(a.password, other.password);
  assert.notEqual(a.roomId, a.password);
  for (const s of [a.roomId, a.password, other.roomId, other.password]) assert.match(s, /^[0-9a-f]{64}$/);
});

test('deriveRoomSecrets matches an independent PBKDF2-SHA256 (salt p2pcomms-v1-kdf, 512 bits split in two)', async () => {
  const code = generateCode(() => [11, 22, 33, 44]);
  const hex = pbkdf2Sync(code, 'p2pcomms-v1-kdf', 1000, 64, 'sha256').toString('hex');
  assert.deepEqual(await deriveRoomSecrets(code, 1000), { roomId: hex.slice(0, 64), password: hex.slice(64) });
});

test('deriveRoomSecrets default cost is under 1.5 s', async () => {
  const t0 = performance.now();
  await deriveRoomSecrets(generateCode(() => [7, 8, 9, 10]));
  const ms = performance.now() - t0;
  console.log(`default KDF took ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500, `took ${ms} ms`);
});
