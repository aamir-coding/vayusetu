import { describe, expect, it } from 'vitest';
import type { Submission } from '@vayusetu/shared-types';
import { assembleContext } from '../src/adapters/context.js';
import { parseGsUrl, speechLanguageCode, ttsCacheKey } from '../src/adapters/speech.js';
import { categoryForAqi, crossValidate, istLabel, seasonFor, visualCategory } from '../src/pipeline/crossValidate.js';

const base = {
  sourceClassification: 'vehicular_smog' as const, severityEstimate: 3, skyOpacityScore: 0.5, plumeDetected: false,
  confidenceScore: 0.8, needsHumanReview: false, recommendedAdvisory: 'x', advisoryLanguage: 'en-IN',
};

describe('cross-validation', () => {
  it('CPCB bands', () => {
    expect([30, 51, 150, 250, 350, 450].map(categoryForAqi)).toEqual(['good', 'satisfactory', 'moderate', 'poor', 'very_poor', 'severe']);
  });

  it('visibility beats the severity scale; indeterminate has no category', () => {
    expect(visualCategory({ ...base, visibilityMeters: 300 })).toBe('severe');
    expect(visualCategory({ ...base, visibilityMeters: 12000 })).toBe('good');
    expect(visualCategory({ ...base })).toBe('poor'); // severity 3 of 1..5 -> satisfactory..severe
    expect(visualCategory({ ...base, sourceClassification: 'indeterminate' })).toBeUndefined();
  });

  it('agreement is 1 - gap/5; > 2 categories disagrees', () => {
    const ref = { aqi: 250, source: 'monitor' as const, label: 'm' };
    expect(crossValidate({ ...base, visibilityMeters: 1500 }, ref)).toMatchObject({ agreementScore: 1, disagrees: false });
    expect(crossValidate({ ...base, visibilityMeters: 6000 }, ref)).toMatchObject({ agreementScore: 0.6, disagrees: false });
    expect(crossValidate({ ...base, visibilityMeters: 15000 }, ref)).toMatchObject({ agreementScore: 0.4, disagrees: true });
    expect(crossValidate(base, undefined)).toEqual({ estimatedAQICategory: 'poor', disagrees: false });
  });

  it('IST label and season', () => {
    expect(istLabel(new Date('2026-11-03T02:10:00Z'))).toBe('2026-11-03 07:40 IST');
    expect(seasonFor(new Date('2026-11-03T02:10:00Z'))).toContain('crop-residue');
    expect(seasonFor(new Date('2026-01-10T02:10:00Z'))).toContain('winter');
  });
});

describe('context assembly', () => {
  const sub = { capturedAt: '2026-11-03T02:09:00.000Z' } as Submission;
  const now = new Date('2026-11-03T02:10:00.000Z');
  const opts = { now, monitorFreshHours: 6, monitorMaxDistanceKm: 5 };
  const row = {
    corridor_id: 'ncr-airshed', nearest_station_id: 'anand-vihar', nearest_station_distance_km: 2.1,
    gt_aqi: 380, gt_ts: { value: '2026-11-03T01:00:00.000Z' }, sat_aod: 0.61, sat_aai: 1.2, sat_date: { value: '2026-11-02' },
  };

  it('a fresh, close monitor is the reference', () => {
    const c = assembleContext(sub, row, { aqi: 200 }, opts);
    expect(c.reference).toMatchObject({ aqi: 380, source: 'monitor' });
    expect(c.corridorId).toBe('ncr-airshed');
    expect(c.context.nearestMonitor).toMatchObject({ id: 'anand-vihar', aqi: 380, aqiCategory: 'very_poor' });
    expect(c.context.satellite).toMatchObject({ aod550nm: 0.61, aerosolIndex: 1.2, observationDate: '2026-11-02' });
    expect(c.crossValidation).toEqual({ nearestMonitorId: 'anand-vihar', nearestMonitorAQI: 380, satelliteAODAtCell: 0.61 });
  });

  it('a stale (OpenAQ lags ~2 days) or distant monitor yields to the modeled AQI at the point', () => {
    const stale = assembleContext(sub, { ...row, gt_ts: '2026-11-01T01:00:00.000Z' }, { aqi: 210 }, opts);
    expect(stale.reference).toMatchObject({ aqi: 210, source: 'modeled' });
    expect(stale.context.nearestMonitor?.observedAt).toBe('2026-11-01T01:00:00.000Z'); // still shown as context
    const far = assembleContext(sub, { ...row, nearest_station_distance_km: 9 }, undefined, opts);
    expect(far.reference).toBeUndefined();
  });

  it('a cell outside every corridor has no corridor and no monitor', () => {
    const c = assembleContext(sub, undefined, undefined, opts);
    expect(c.corridorId).toBeUndefined();
    expect(c.context).toEqual({ localTime: '2026-11-03 07:39 IST', season: expect.any(String) });
  });
});

describe('speech helpers', () => {
  it('maps Punjabi to the code Cloud Speech accepts', () => {
    expect(speechLanguageCode('pa-IN')).toBe('pa-Guru-IN');
    expect(speechLanguageCode('hi-IN')).toBe('hi-IN');
  });

  it('parses gs:// URLs for the inline voice-note download', () => {
    expect(parseGsUrl('gs://vayusetu-mh-dev-citizen-media/submissions/u/2026-09-29/audio-1.webm')).toEqual({
      bucket: 'vayusetu-mh-dev-citizen-media',
      path: 'submissions/u/2026-09-29/audio-1.webm',
    });
    expect(parseGsUrl('https://storage.googleapis.com/b/o')).toBeUndefined();
    expect(parseGsUrl('gs://bucket-only')).toBeUndefined();
  });

  it('TTS cache key depends on text, language and voice only', () => {
    const k = ttsCacheKey('a', 'hi-IN', 'hi-IN-Chirp3-HD-Aoede');
    expect(k).toBe(ttsCacheKey('a', 'hi-IN', 'hi-IN-Chirp3-HD-Aoede'));
    expect(k).not.toBe(ttsCacheKey('a', 'mr-IN', 'mr-IN-Chirp3-HD-Aoede'));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});
