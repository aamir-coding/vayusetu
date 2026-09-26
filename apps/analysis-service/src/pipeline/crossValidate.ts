import type { AQICategory } from '@vayusetu/shared-types';
import type { RecordAirQualityAssessment } from '@vayusetu/gemini-client';

/**
 * Deterministic cross-validation (AI_PIPELINES.md, Pipeline A output
 * handling): the model's visual read vs an independent reference AQI.
 * Pure functions, no I/O.
 */

export const AQI_CATEGORIES: readonly AQICategory[] = ['good', 'satisfactory', 'moderate', 'poor', 'very_poor', 'severe'];

/** CPCB National AQI bands. */
export function categoryForAqi(aqi: number): AQICategory {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'satisfactory';
  if (aqi <= 200) return 'moderate';
  if (aqi <= 300) return 'poor';
  if (aqi <= 400) return 'very_poor';
  return 'severe';
}

/**
 * The photo's implied AQI category. Visibility is the physically grounded
 * signal (fine particulate mass scales roughly inversely with visual range),
 * so it wins when the model estimated it; otherwise fall back to the 1-5
 * severity scale. Indeterminate reports have no category.
 */
export function visualCategory(a: RecordAirQualityAssessment): AQICategory | undefined {
  if (a.sourceClassification === 'indeterminate') return undefined;
  if (a.visibilityMeters !== undefined) {
    const v = a.visibilityMeters;
    if (v >= 10_000) return 'good';
    if (v >= 5_000) return 'satisfactory';
    if (v >= 2_000) return 'moderate';
    if (v >= 1_000) return 'poor';
    if (v >= 500) return 'very_poor';
    return 'severe';
  }
  if (a.sourceClassification === 'no_visible_pollution') return a.severityEstimate <= 1 ? 'good' : 'satisfactory';
  return (['satisfactory', 'moderate', 'poor', 'very_poor', 'severe'] as const)[a.severityEstimate - 1];
}

export interface Reference {
  aqi: number;
  source: 'monitor' | 'modeled';
  label: string; // e.g. "monitor anand-vihar-delhi-dpcc" -- goes into reviewNote
}

export interface CrossValidation {
  estimatedAQICategory?: AQICategory;
  agreementScore?: number;
  /** True when visual vs reference differ by MORE than two categories (Pipeline A calibration rule 5). */
  disagrees: boolean;
  note?: string;
}

export function crossValidate(a: RecordAirQualityAssessment, reference: Reference | undefined): CrossValidation {
  const estimated = visualCategory(a);
  if (!estimated || !reference) return { estimatedAQICategory: estimated, disagrees: false };
  const refCat = categoryForAqi(reference.aqi);
  const gap = Math.abs(AQI_CATEGORIES.indexOf(estimated) - AQI_CATEGORIES.indexOf(refCat));
  const agreementScore = Math.round((1 - gap / (AQI_CATEGORIES.length - 1)) * 100) / 100;
  const disagrees = gap > 2;
  return {
    estimatedAQICategory: estimated,
    agreementScore,
    disagrees,
    ...(disagrees
      ? { note: `Photo suggests "${estimated}" but ${reference.label} reports AQI ${reference.aqi} ("${refCat}") -- ${gap} categories apart.` }
      : {}),
  };
}

/** India's air-quality seasons, as context for the model (IST month). */
export function seasonFor(date: Date): string {
  const month = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(date));
  if (month >= 3 && month <= 5) return 'pre-monsoon summer (dust season)';
  if (month >= 6 && month <= 9) return 'monsoon';
  if (month === 10 || month === 11) return 'post-monsoon (crop-residue burning window)';
  return 'winter (temperature-inversion season)';
}

export function istLabel(date: Date): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => f.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} IST`;
}
