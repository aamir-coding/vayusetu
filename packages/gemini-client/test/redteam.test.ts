import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POLLUTION_SOURCE_TYPES, type RecordAirQualityAssessment } from '../src/pipelineA.js';
import { scriptShare, violations, type RedTeamCase } from '../redteam/evaluate.js';

const dir = (rel: string) => fileURLToPath(new URL(`../redteam/${rel}`, import.meta.url));
const { cases } = JSON.parse(readFileSync(dir('cases.json'), 'utf-8')) as { cases: RedTeamCase[] };

const base: RecordAirQualityAssessment = {
  sourceClassification: 'open_waste_burning',
  severityEstimate: 4,
  skyOpacityScore: 0.6,
  plumeDetected: true,
  confidenceScore: 0.8,
  needsHumanReview: false,
  recommendedAdvisory: 'Avoid outdoor exercise near this location for the next few hours.',
  advisoryLanguage: 'en-IN',
};

describe('red-team case set', () => {
  it('ids are unique and every image exists', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(existsSync(dir(`images/${c.image}`)), c.image).toBe(true);
  });

  it('only names real source classes and valid regexes', () => {
    for (const c of cases) {
      for (const s of c.expect.sources ?? []) expect(POLLUTION_SOURCE_TYPES, c.id).toContain(s);
      for (const re of [...(c.expect.advisoryNot ?? []), ...(c.expect.reviewNoteNot ?? [])]) expect(() => new RegExp(re)).not.toThrow();
    }
  });

  it('covers every attack category', () => {
    expect(new Set(cases.map((c) => c.category))).toEqual(
      new Set(['vision', 'lookalike', 'offtopic', 'injection', 'context', 'language', 'safety', 'privacy']),
    );
  });
});

describe('violations()', () => {
  it('passes a compliant call', () => {
    expect(violations(base, { sources: ['open_waste_burning'], severity: [3, 5], advisoryNot: ['jog'] })).toEqual([]);
  });

  it('reports each broken rule', () => {
    const r = violations(
      { ...base, sourceClassification: 'no_visible_pollution', severityEstimate: 1, confidenceScore: 0.99, recommendedAdvisory: 'Safe to jog outdoors!' },
      { sources: ['open_waste_burning'], severity: [3, 5], maxConfidence: 0.9, advisoryNot: ['jog'], needsHumanReview: true },
    );
    expect(r).toHaveLength(5);
  });

  it('checks the advisory script, tolerating Latin acronyms', () => {
    expect(scriptShare('अगले कुछ घंटों तक यहाँ बाहर व्यायाम न करें; AQI खराब है।', 'devanagari')).toBeGreaterThan(0.8);
    expect(violations({ ...base, recommendedAdvisory: 'Avoid outdoor exercise.' }, { advisoryScript: 'devanagari' })).toHaveLength(1);
    expect(scriptShare('ਅਗਲੇ ਕੁਝ ਘੰਟਿਆਂ ਲਈ ਬਾਹਰ ਕਸਰਤ ਨਾ ਕਰੋ।', 'gurmukhi')).toBe(1);
  });
});
