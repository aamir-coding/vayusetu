// Runs pytest from apps/ingestion-jobs/.venv so `pnpm test` covers Python too.
// Without a venv: skipped locally with a hint, FAILED in CI (CI=true).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const venvPython = process.platform === 'win32' ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : process.env.CI ? 'python3' : null;
if (!python) {
  console.warn('ingestion-jobs: no .venv -- skipping. Set up: python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt');
  process.exit(0);
}
const r = spawnSync(python, ['-m', 'pytest', '-q'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
