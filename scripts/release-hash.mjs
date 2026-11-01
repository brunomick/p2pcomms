// Release helper: runs the build, then copies dist/SHA256SUMS to the repo root so it can be
// committed before tagging. CI compares a fresh Linux build against that committed file.
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const built = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);

copyFileSync(join(root, 'dist', 'SHA256SUMS'), join(root, 'SHA256SUMS'));
console.log('Copied SHA256SUMS to the repository root. Review it, commit it, then tag the release.');
