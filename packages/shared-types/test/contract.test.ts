import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// API_CONTRACTS.md: "packages/shared-types/src/index.ts must stay
// byte-identical in shape to section 4.1". This is that check, so a contract
// change without the matching doc change (or vice versa) fails CI.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8').replace(/\r\n/g, '\n');
const normalize = (ts: string) =>
  ts
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
    .join('\n');

describe('shared-types <-> API_CONTRACTS.md 4.1', () => {
  it('is identical to the canonical block (comments/blank lines aside)', () => {
    const doc = read('../../../docs/context/03_API_CONTRACTS.md');
    const block = doc.split('## 4.1')[1]!.split('```typescript')[1]!.split('```')[0]!;
    expect(normalize(read('../src/index.ts'))).toBe(normalize(block));
  });
});
