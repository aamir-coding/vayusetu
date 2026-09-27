import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import hi from '../src/i18n/locales/hi.json';
import pa from '../src/i18n/locales/pa.json';
import mr from '../src/i18n/locales/mr.json';

type Bundle = { [k: string]: string | Bundle };
const flat = (b: Bundle, p = ''): Record<string, string> =>
  Object.entries(b).reduce<Record<string, string>>(
    (o, [k, v]) => ({ ...o, ...(typeof v === 'string' ? { [p + k]: v } : flat(v, `${p}${k}.`)) }),
    {},
  );
const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

describe.each([
  ['hi', hi],
  ['pa', pa],
  ['mr', mr],
])('%s bundle', (_lang, bundle) => {
  const source = flat(en as Bundle);
  const target = flat(bundle as Bundle);
  it('has every en key (run translate-locales after adding strings)', () => {
    expect(Object.keys(source).filter((k) => !(k in target))).toEqual([]);
  });
  it('keeps every interpolation placeholder', () => {
    expect(Object.keys(source).filter((k) => vars(source[k]!).join() !== vars(target[k] ?? '').join())).toEqual([]);
  });
});
