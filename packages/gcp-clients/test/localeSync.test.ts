import { describe, expect, it, vi } from 'vitest';
import { cloudTranslate, flatten, hashSource, planSync, protect, syncBundle, unflatten, unprotect } from '../src/localeSync.js';

describe('flatten / unflatten', () => {
  it('round-trips in source key order', () => {
    const b = { a: { x: '1', y: '2' }, b: '3' };
    const flat = flatten(b);
    expect(flat).toEqual({ 'a.x': '1', 'a.y': '2', b: '3' });
    expect(JSON.stringify(unflatten(flat, ['b', 'a.x', 'a.y']))).toBe('{"b":"3","a":{"x":"1","y":"2"}}');
  });
});

describe('placeholders survive translation', () => {
  it('wraps i18next interpolation in translate="no" and unwraps it', () => {
    const p = protect('Visibility ~{{meters}} m & <b>');
    expect(p).toBe('Visibility ~<span translate="no">{{meters}}</span> m &amp; &lt;b&gt;');
    expect(unprotect('दृश्यता ~<span translate="no"> {{meters}} </span> मी &amp; &#39;x&#39;')).toBe("दृश्यता ~{{meters}} मी & 'x'");
  });
});

describe('planSync', () => {
  const source = { a: 'Hello', b: 'Bye', c: 'New' };
  it('translates missing and machine-stale keys; never touches human-owned ones', () => {
    const target = { a: 'नमस्ते', b: 'अलविदा (edited)', old: 'x' };
    const meta = {
      a: { sourceHash: hashSource('Hi'), text: 'नमस्ते' }, // English changed since -> retranslate
      b: { sourceHash: hashSource('Bye'), text: 'अलविदा' }, // human edited -> keep
    };
    expect(planSync(source, target, meta)).toEqual({ toTranslate: ['a', 'c'], toRemove: ['old'], humanOwned: ['b'] });
  });

  it('keys with no meta and a value are human-written: left alone', () => {
    expect(planSync({ a: 'Hello' }, { a: 'नमस्ते' }, {}).toTranslate).toEqual([]);
  });
});

describe('syncBundle', () => {
  it('fills, records provenance, drops removed keys', async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map((t) => `T(${t})`));
    const out = await syncBundle({ a: 'Hi {{name}}' }, { gone: 'x' }, { gone: { sourceHash: 'h', text: 'x' } }, 'hi', translate);
    expect(translate).toHaveBeenCalledWith(['Hi <span translate="no">{{name}}</span>'], 'hi');
    expect(out.target).toEqual({ a: 'T(Hi {{name}})' });
    expect(out.meta).toEqual({ a: { sourceHash: hashSource('Hi {{name}}'), text: 'T(Hi {{name}})' } });
  });
});

describe('cloudTranslate', () => {
  it('calls v3 translateText in HTML mode with the quota project', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ translations: [{ translatedText: 'नमस्ते' }] })));
    const t = cloudTranslate({ project: 'p', getAccessToken: async () => 'tok', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await t(['Hello'], 'hi')).toEqual(['नमस्ते']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://translation.googleapis.com/v3/projects/p/locations/global:translateText');
    expect(JSON.parse(String(init.body))).toMatchObject({ mimeType: 'text/html', sourceLanguageCode: 'en', targetLanguageCode: 'hi' });
  });
});
