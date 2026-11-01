// Deterministic single-file build: bundles src/main.js with esbuild and inlines it
// into src/template.html, pinning the inline script in the CSP by SHA-256.
// No timestamps, no absolute paths, LF line endings only.
import { build } from 'esbuild';
import { escapeScriptEnd } from './escape.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(root, 'dist'));

const result = await build({
  entryPoints: [join(root, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  write: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
});

const bundle = escapeScriptEnd(result.outputFiles[0].text.replace(/\r\n?/g, '\n').trimEnd());

const template = readFileSync(join(root, 'src', 'template.html'), 'utf8').replace(/\r\n?/g, '\n');
const scriptHash = createHash('sha256').update(bundle, 'utf8').digest('base64');

// Function replacers: the bundle contains `$` sequences that String.replace would interpret.
const html = template
  .replace('__CSP_SCRIPT_HASH__', () => `sha256-${scriptHash}`)
  .replace('/*__APP__*/', () => bundle);

const htmlBytes = Buffer.from(html, 'utf8');
const sums = `${createHash('sha256').update(htmlBytes).digest('hex')}  p2pcomms.html\n`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'p2pcomms.html'), htmlBytes);
writeFileSync(join(outDir, 'SHA256SUMS'), sums);
