import type {
  AQICategory,
  AlertSeverity,
  AlertStatus,
  GRAPStage,
  PollutionSourceType,
  ResourceType,
  SubmissionStatus,
} from '@vayusetu/shared-types';

/**
 * English label + Tailwind class maps for every enum in the canonical
 * contract (`@vayusetu/shared-types`). This is the ONE place both apps
 * pull human-readable copy and color treatment from, so a badge never
 * reads differently on citizen-pwa vs admin-dashboard.
 *
 * These are the English defaults / fallback strings. citizen-pwa routes
 * its own user-facing copy through i18next (see `src/i18n`); admin-dashboard
 * uses these directly until multilingual admin UI lands (Week 3 per the
 * roadmap). Being TypeScript `Record`s keyed by the exact union types means
 * this file fails to compile the moment API_CONTRACTS.md adds or renames a
 * value — that's intentional.
 */

export const AQI_CATEGORY_LABEL: Record<AQICategory, string> = {
  good: 'Good',
  satisfactory: 'Satisfactory',
  moderate: 'Moderate',
  poor: 'Poor',
  very_poor: 'Very Poor',
  severe: 'Severe',
};

/** Tailwind bg/text pair per AQI category — solid blocks, matching how CPCB and most AQI apps signal urgency at a glance. */
export const AQI_CATEGORY_CLASS: Record<AQICategory, string> = {
  good: 'bg-aqi-good text-white',
  satisfactory: 'bg-aqi-satisfactory text-ink',
  moderate: 'bg-aqi-moderate text-ink',
  poor: 'bg-aqi-poor text-white',
  very_poor: 'bg-aqi-veryPoor text-white',
  severe: 'bg-aqi-severe text-white',
};

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: 'Info',
  watch: 'Watch',
  warning: 'Warning',
  critical: 'Critical',
};

export const ALERT_SEVERITY_CLASS: Record<AlertSeverity, string> = {
  info: 'bg-severity-info/10 text-severity-info ring-1 ring-inset ring-severity-info/30',
  watch: 'bg-severity-watch/10 text-severity-watch ring-1 ring-inset ring-severity-watch/30',
  warning: 'bg-severity-warning/10 text-severity-warning ring-1 ring-inset ring-severity-warning/30',
  critical: 'bg-severity-critical text-white ring-1 ring-inset ring-severity-critical',
};

export const GRAP_STAGE_LABEL: Record<GRAPStage, string> = {
  none: 'No GRAP Stage',
  stage_1: 'GRAP Stage I',
  stage_2: 'GRAP Stage II',
  stage_3: 'GRAP Stage III',
  stage_4: 'GRAP Stage IV',
};

/** 0–4 ladder position, used to render the GRAP ladder tick (the admin console's signature structural device). */
export const GRAP_STAGE_INDEX: Record<GRAPStage, number> = {
  none: 0,
  stage_1: 1,
  stage_2: 2,
  stage_3: 3,
  stage_4: 4,
};

export const GRAP_STAGE_CLASS: Record<GRAPStage, string> = {
  none: 'bg-grap-none/15 text-slate-600',
  stage_1: 'bg-grap-stage1/15 text-yellow-800',
  stage_2: 'bg-grap-stage2/15 text-orange-800',
  stage_3: 'bg-grap-stage3/15 text-red-800',
  stage_4: 'bg-grap-stage4 text-white',
};

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  pending_analysis: 'Analyzing…',
  analyzed: 'Analyzed',
  failed: 'Failed',
  flagged_for_review: 'Needs Review',
};

export const SUBMISSION_STATUS_CLASS: Record<SubmissionStatus, string> = {
  queued: 'bg-slate-100 text-slate-600',
  uploading: 'bg-blue-50 text-blue-700',
  pending_analysis: 'bg-blue-50 text-blue-700',
  analyzed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  flagged_for_review: 'bg-amber-50 text-amber-800',
};

export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const ALERT_STATUS_CLASS: Record<AlertStatus, string> = {
  new: 'bg-blue-50 text-blue-700',
  acknowledged: 'bg-amber-50 text-amber-800',
  in_progress: 'bg-indigo-50 text-indigo-700',
  resolved: 'bg-emerald-50 text-emerald-700',
  dismissed: 'bg-slate-100 text-slate-500',
};

/**
 * Conservative client-side UX heuristic only — NOT the source of truth.
 * `PATCH /alerts/:id/status` returns 409 CONFLICT server-side for an
 * invalid transition; this map exists purely to disable obviously-wrong
 * next-status buttons in the UI. Never trust it as validation.
 */
export const ALERT_STATUS_SUGGESTED_NEXT: Record<AlertStatus, AlertStatus[]> = {
  new: ['acknowledged', 'dismissed'],
  acknowledged: ['in_progress', 'dismissed'],
  in_progress: ['resolved'],
  resolved: [],
  dismissed: [],
};

export const POLLUTION_SOURCE_LABEL: Record<PollutionSourceType, string> = {
  crop_residue_burning: 'Crop Residue Burning',
  industrial_emission: 'Industrial Emission',
  open_waste_burning: 'Open Waste Burning',
  vehicular_smog: 'Vehicular Smog',
  construction_dust: 'Construction Dust',
  no_visible_pollution: 'No Visible Pollution',
  indeterminate: 'Indeterminate',
};

export const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  inspection_team: 'Inspection Team',
  anti_smog_gun: 'Anti-Smog Gun',
  water_sprinkler: 'Water Sprinkler',
  mobile_monitoring_van: 'Mobile Monitoring Van',
  public_advisory: 'Public Advisory',
  other: 'Other',
};

/** Plain-language word for the 1–5 severityEstimate on AnalysisResult. */
export function severityWord(severity: 1 | 2 | 3 | 4 | 5): string {
  return ['Minimal', 'Mild', 'Moderate', 'High', 'Severe'][severity - 1] ?? 'Unknown';
}
