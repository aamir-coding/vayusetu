import { createHash } from 'node:crypto';

/**
 * Static UI strings: Cloud Translation API fills the hi/pa/mr bundles from
 * en.json (PRODUCT_SPEC multilingual rules -- Gemini localizes dynamic
 * content, Translation handles static, cacheable strings). Human edits win:
 * a key is machine-(re)translated only when it is missing, or when it was
 * machine-translated before AND its English source changed since. A
 * reviewer who fixes a machine string takes ownership of it for good.
 *
 * Provenance lives next to each bundle (`<lang>.meta.json`):
 *   { "<key.path>": { "sourceHash": "...", "text": "<what the machine wrote>" } }
 */

export type Bundle = { [k: string]: string | Bundle };
export type Flat = Record<string, string>;
export type MachineMeta = Record<string, { sourceHash: string; text: string }>;

export function flatten(b: Bundle, prefix = '', out: Flat = {}): Flat {
  for (const [k, v] of Object.entries(b)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else flatten(v, key, out);
  }
  return out;
}

/** Rebuilds nesting in SOURCE key order, so bundles diff cleanly against en.json. */
export function unflatten(flat: Flat, order: string[]): Bundle {
  const root: Bundle = {};
  for (const key of order) {
    if (!(key in flat)) continue;
    const parts = key.split('.');
    let node = root;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Bundle;
    node[parts[parts.length - 1]!] = flat[key]!;
  }
  return root;
}

export const hashSource = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export interface SyncPlan {
  toTranslate: string[];
  /** Target keys no longer in the source bundle. */
  toRemove: string[];
  /** Machine strings a human has since edited: kept, and dropped from meta. */
  humanOwned: string[];
}

export function planSync(source: Flat, target: Flat, meta: MachineMeta): SyncPlan {
  const plan: SyncPlan = { toTranslate: [], toRemove: [], humanOwned: [] };
  for (const [key, text] of Object.entries(source)) {
    const m = meta[key];
    if (!(key in target)) plan.toTranslate.push(key);
    else if (m && target[key] !== m.text) plan.humanOwned.push(key);
    else if (m && m.sourceHash !== hashSource(text)) plan.toTranslate.push(key);
  }
  for (const key of Object.keys(target)) if (!(key in source)) plan.toRemove.push(key);
  return plan;
}

// i18next interpolation ({{meters}}) and nesting ($t(...)) must survive
// translation verbatim: sent as HTML with translate="no" spans, unwrapped after.
const PLACEHOLDER = /(\{\{[^}]+\}\}|\$t\([^)]+\))/g;

export function protect(s: string): string {
  const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(PLACEHOLDER, '<span translate="no">$1</span>');
}

export function unprotect(s: string): string {
  return s
    .replace(/<span translate="no">\s*(.*?)\s*<\/span>/g, '$1')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export type TranslateFn = (texts: string[], targetLanguage: string) => Promise<string[]>;

/** Applies a plan: returns the new target bundle (flat) and meta. */
export async function syncBundle(
  source: Flat,
  target: Flat,
  meta: MachineMeta,
  targetLanguage: string,
  translate: TranslateFn,
): Promise<{ target: Flat; meta: MachineMeta; plan: SyncPlan }> {
  const plan = planSync(source, target, meta);
  const next: Flat = { ...target };
  const nextMeta: MachineMeta = { ...meta };
  for (const k of plan.toRemove) {
    delete next[k];
    delete nextMeta[k];
  }
  for (const k of plan.humanOwned) delete nextMeta[k];
  for (let i = 0; i < plan.toTranslate.length; i += 50) {
    const keys = plan.toTranslate.slice(i, i + 50);
    const out = await translate(keys.map((k) => protect(source[k]!)), targetLanguage);
    keys.forEach((k, j) => {
      const text = unprotect(out[j]!);
      next[k] = text;
      nextMeta[k] = { sourceHash: hashSource(source[k]!), text };
    });
  }
  return { target: next, meta: nextMeta, plan };
}

/** Cloud Translation v3 (Advanced) translateText over REST, HTML mode. */
export function cloudTranslate(opts: { project: string; getAccessToken: () => Promise<string>; fetchImpl?: typeof fetch }): TranslateFn {
  const f = opts.fetchImpl ?? fetch;
  return async (texts, targetLanguage) => {
    const res = await f(`https://translation.googleapis.com/v3/projects/${opts.project}/locations/global:translateText`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await opts.getAccessToken()}`, 'Content-Type': 'application/json', 'x-goog-user-project': opts.project },
      body: JSON.stringify({ contents: texts, mimeType: 'text/html', sourceLanguageCode: 'en', targetLanguageCode: targetLanguage }),
    });
    if (!res.ok) throw new Error(`Cloud Translation ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { translations: Array<{ translatedText: string }> };
    if (body.translations.length !== texts.length) throw new Error('Cloud Translation returned a different number of strings');
    return body.translations.map((t) => t.translatedText);
  };
}
