import { WORDS } from './wordlist.js';

export const APP_ID = 'p2pcomms-v1';

const KDF_SALT = 'p2pcomms-v1-kdf';
const WORD_SET = new Set(WORDS);

export function generateCode(random = n => crypto.getRandomValues(new Uint16Array(n))) {
  const values = random(4);
  return Array.from({ length: 4 }, (_, i) => WORDS[values[i] & 0x7ff]).join('-');
}

export function normalizeCode(input) {
  const words = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (words.length !== 4 || !words.every(w => WORD_SET.has(w))) return null;
  return words.join('-');
}

const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export async function deriveRoomSecrets(code, iterations = 600000) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KDF_SALT), iterations },
    key,
    512
  );
  const bytes = new Uint8Array(bits);
  return { roomId: toHex(bytes.slice(0, 32)), password: toHex(bytes.slice(32)) };
}
