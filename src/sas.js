import { WORDS } from './wordlist.js';

const enc = new TextEncoder();

const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function extractFingerprint(sdp) {
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+) (\S+)/.exec(line);
    if (m) return `${m[1]} ${m[2].toUpperCase()}`;
  }
  throw new Error('no-fingerprint');
}

export function isCommitter(selfId, peerId) {
  return selfId < peerId;
}

export async function sasWords(fpLocal, fpRemote, committerNonce, responderNonce) {
  const [fp1, fp2] = [fpLocal, fpRemote].sort();
  const digest = await sha256(`${fp1}|${fp2}|${committerNonce}|${responderNonce}`);
  // First 44 bits, big-endian: four 11-bit indices.
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(digest[i]);
  bits >>= 4n;
  return [3n, 2n, 1n, 0n].map(i => WORDS[Number((bits >> (i * 11n)) & 0x7ffn)]);
}

// Commit-reveal over the already-encrypted direct channel: the committer fixes its nonce
// (via its hash) before it sees the responder's, so a man in the middle cannot grind
// for matching words.
export async function runSasExchange({ selfId, peerId, localFp, remoteFp, send, subscribe }) {
  const queue = [];
  let wake = null;
  subscribe(msg => {
    queue.push(msg);
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  });

  const expect = async (type, field) => {
    if (!queue.length) await new Promise(resolve => { wake = resolve; });
    const msg = queue.shift();
    if (!msg || msg.t !== type || typeof msg[field] !== 'string') throw new Error('sas-protocol');
    return msg[field];
  };

  const myNonce = toHex(crypto.getRandomValues(new Uint8Array(32)));

  if (isCommitter(selfId, peerId)) {
    send({ t: 'commit', h: toHex(await sha256(myNonce)) });
    const theirNonce = await expect('nonce', 'n');
    send({ t: 'reveal', n: myNonce });
    return sasWords(localFp, remoteFp, myNonce, theirNonce);
  }

  const commitHash = await expect('commit', 'h');
  send({ t: 'nonce', n: myNonce });
  const revealed = await expect('reveal', 'n');
  if (toHex(await sha256(revealed)) !== commitHash) throw new Error('sas-commit-mismatch');
  return sasWords(localFp, remoteFp, revealed, myNonce);
}
