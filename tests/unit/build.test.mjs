import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildScript = join(root, 'scripts', 'build.mjs');

function buildInto() {
  const dir = mkdtempSync(join(tmpdir(), 'p2pcomms-build-'));
  execFileSync(process.execPath, [buildScript, dir], { cwd: root, stdio: 'pipe' });
  return dir;
}

function read(dir, name) {
  return readFileSync(join(dir, name));
}

function inlineScript(html) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'inline <script> present');
  return m[1];
}

function cspPolicy(html) {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(m, 'CSP meta present');
  return m[1];
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

test('build is deterministic', () => {
  const a = buildInto();
  const b = buildInto();
  try {
    assert.ok(read(a, 'p2pcomms.html').equals(read(b, 'p2pcomms.html')));
    assert.ok(read(a, 'SHA256SUMS').equals(read(b, 'SHA256SUMS')));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('SHA256SUMS matches the html', () => {
  const dir = buildInto();
  try {
    const html = read(dir, 'p2pcomms.html');
    const sums = read(dir, 'SHA256SUMS').toString('utf8');
    const [hash, name] = sums.trimEnd().split('  ');
    assert.equal(hash, createHash('sha256').update(html).digest('hex'));
    assert.equal(name, 'p2pcomms.html');
    assert.equal(sums, `${hash}  p2pcomms.html\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no external resources', () => {
  const dir = buildInto();
  try {
    const html = read(dir, 'p2pcomms.html').toString('utf8');
    assert.ok(!/<script[^>]+src=/i.test(html));
    assert.ok(!/<link[^>]+href=/i.test(html));
    assert.ok(!/\r/.test(html));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CSP pins the inline script', () => {
  const dir = buildInto();
  try {
    const html = read(dir, 'p2pcomms.html').toString('utf8');
    const hash = createHash('sha256').update(inlineScript(html), 'utf8').digest('base64');
    const scriptSrc = /script-src ([^;]*)/.exec(cspPolicy(html));
    assert.ok(scriptSrc, 'script-src present');
    assert.ok(scriptSrc[1].includes(`'sha256-${hash}'`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CSP restricts connections', () => {
  const dir = buildInto();
  try {
    const policy = cspPolicy(read(dir, 'p2pcomms.html').toString('utf8'));
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(policy.includes('connect-src wss:'));
    assert.ok(policy.includes("base-uri 'none'"));
    assert.ok(policy.includes("form-action 'none'"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundled third-party notices are shipped outside the hashed script', () => {
  const dir = buildInto();
  try {
    const html = read(dir, 'p2pcomms.html').toString('utf8');
    const outside = html.replace(inlineScript(html), '');
    assert.ok(outside.includes('Copyright (c) 2021 Dan Motzenbecker'));
    assert.ok(outside.includes('Copyright (c) 2019 Paul Miller (https://paulmillr.com)'));
    assert.ok(outside.includes('Permission is hereby granted, free of charge'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app code never persists data', () => {
  const forbidden = /localStorage|sessionStorage|indexedDB|document\.cookie/;
  for (const file of listFiles(join(root, 'src'))) {
    assert.ok(!forbidden.test(readFileSync(file, 'utf8')), `${file} must not persist data`);
  }
});
