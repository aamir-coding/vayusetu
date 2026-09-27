/**
 * Fill/refresh the hi, pa, mr UI bundles from en.json with Cloud Translation.
 *   pnpm --filter @vayusetu/gcp-clients translate-locales -- --project vayusetu-ncr-dev [--dry-run]
 * Runs over every app with src/i18n/locales/en.json. Needs ADC with
 * roles/cloudtranslate.user on the project. Review the diff before committing:
 * machine strings are a first draft; edit any in place and they become human-owned.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import { cloudTranslate, flatten, syncBundle, unflatten, type Bundle, type MachineMeta } from '../src/localeSync.js';

const TARGETS = ['hi', 'pa', 'mr'] as const;
const APPS = ['citizen-pwa', 'admin-dashboard'];

const args = process.argv.slice(2);
const project = args[args.indexOf('--project') + 1];
const dryRun = args.includes('--dry-run');
if (!project || project.startsWith('--')) {
  console.error('usage: translate-locales --project <gcp-project> [--dry-run]');
  process.exit(1);
}

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const translate = cloudTranslate({
  project,
  getAccessToken: async () => (await (await auth.getClient()).getAccessToken()).token!,
});
const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as T) : fallback);

for (const app of APPS) {
  const dir = join(repo, 'apps', app, 'src/i18n/locales');
  if (!existsSync(join(dir, 'en.json'))) continue;
  const source = flatten(readJson<Bundle>(join(dir, 'en.json'), {}));
  const order = Object.keys(source);
  for (const lang of TARGETS) {
    const targetPath = join(dir, `${lang}.json`);
    const metaPath = join(dir, `${lang}.meta.json`);
    const { target, meta, plan } = await syncBundle(
      source,
      flatten(readJson<Bundle>(targetPath, {})),
      readJson<MachineMeta>(metaPath, {}),
      lang,
      dryRun ? async (texts) => texts : translate,
    );
    console.log(`${app}/${lang}: translate ${plan.toTranslate.length}, remove ${plan.toRemove.length}, human-owned ${plan.humanOwned.length}`);
    if (dryRun) continue;
    writeFileSync(targetPath, JSON.stringify(unflatten(target, order), null, 2) + '\n');
    const sortedMeta = Object.fromEntries(order.filter((k) => meta[k]).map((k) => [k, meta[k]!]));
    writeFileSync(metaPath, JSON.stringify(sortedMeta, null, 2) + '\n');
  }
}
