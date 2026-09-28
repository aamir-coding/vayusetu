import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const firebase = JSON.parse(readFileSync(new URL('../hosting.json', import.meta.url), 'utf8'));

test('every state door points at a deployed app', () => {
  const links = new Set([...html.matchAll(/href="(https:\/\/[^"]+\.web\.app)"/g)].map((m) => m[1]));
  assert.deepEqual([...links].sort(), [
    'https://vayusetu-mh-dev-admin.web.app',
    'https://vayusetu-mh-dev.web.app',
    'https://vayusetu-ncr-dev-admin.web.app',
    'https://vayusetu-ncr-dev.web.app',
  ]);
});

test('every translatable string has a Hindi version', () => {
  const keys = new Set([...html.matchAll(/data-i18n(?:-html)?="(\w+)"/g)].map((m) => m[1]));
  const hi = html.slice(html.indexOf('const HI = {'), html.indexOf('const EN = {}'));
  const missing = [...keys].filter((k) => !new RegExp(`(^|[\\s{,])${k}:`).test(hi));
  assert.deepEqual(missing, []);
});

test('no third-party scripts; only Google Fonts is loaded', () => {
  assert.equal([...html.matchAll(/<script[^>]+src=/g)].length, 0);
  const external = [...html.matchAll(/(?:href|src)="(https?:\/\/[^/"]+)/g)].map((m) => m[1]).filter((u) => !u.endsWith('.web.app'));
  assert.deepEqual([...new Set(external)].sort(), ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
});

test('reads like a product, not a project: no event or tech-stack talk', () => {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, (m) => m.slice(m.indexOf('const HI'), m.indexOf('const EN'))).replace(/<[^>]+>/g, ' ');
  for (const word of ['hackathon', 'Gemini', 'Google', 'Vertex', 'Firebase', 'BigQuery', 'Cloud Run', 'Earth Engine', 'three.js']) {
    assert.ok(!new RegExp(word, 'i').test(text), `landing page mentions "${word}"`);
  }
});

test('the 3D hero is bundled, lazy-loaded and within its budget', () => {
  const bundle = statSync(new URL('../public/assets/scene.js', import.meta.url));
  assert.ok(bundle.size < 600_000, `scene.js is ${bundle.size} bytes`);
  assert.match(html, /import\('\.\/assets\/scene\.js'\)/);
  assert.match(html, /saveData/); // skipped on data-saver
});

test('the CSP allows exactly what the page uses', () => {
  const csp = firebase.hosting.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/); // the lazily imported scene
  assert.equal(firebase.hosting.site, 'vayusetu');
});
