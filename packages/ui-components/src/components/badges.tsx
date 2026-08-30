import * as React from 'react';
import type {
  AQICategory,
  AlertSeverity,
  AlertStatus,
  GRAPStage,
  SubmissionStatus,
} from '@vayusetu/shared-types';
import { cn } from '../lib/cn';
import {
  AQI_CATEGORY_CLASS,
  AQI_CATEGORY_LABEL,
  ALERT_SEVERITY_CLASS,
  ALERT_SEVERITY_LABEL,
  ALERT_STATUS_CLASS,
  ALERT_STATUS_LABEL,
  GRAP_STAGE_CLASS,
  GRAP_STAGE_INDEX,
  GRAP_STAGE_LABEL,
  SUBMISSION_STATUS_CLASS,
  SUBMISSION_STATUS_LABEL,
} from '../lib/domain';

/** Generic pill primitive every domain badge below is built from. */
export function StatusPill({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold leading-none',
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function AqiBadge({
  category,
  className,
}: {
  category: AQICategory;
  className?: string;
}) {
  return (
    <StatusPill className={cn(AQI_CATEGORY_CLASS[category], className)}>
      {AQI_CATEGORY_LABEL[category]}
    </StatusPill>
  );
}

export function SeverityBadge({
  severity,
  className,
}: {
  severity: AlertSeverity;
  className?: string;
}) {
  return (
    <StatusPill className={cn(ALERT_SEVERITY_CLASS[severity], className)}>
      {ALERT_SEVERITY_LABEL[severity]}
    </StatusPill>
  );
}

export function GrapStageBadge({
  stage,
  className,
}: {
  stage: GRAPStage;
  className?: string;
}) {
  return (
    <StatusPill className={cn(GRAP_STAGE_CLASS[stage], className)}>
      {GRAP_STAGE_LABEL[stage]}
    </StatusPill>
  );
}

export function SubmissionStatusBadge({
  status,
  className,
}: {
  status: SubmissionStatus;
  className?: string;
}) {
  const pulsing = status === 'pending_analysis' || status === 'uploading';
  return (
    <StatusPill className={cn(SUBMISSION_STATUS_CLASS[status], className)}>
      {pulsing && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {SUBMISSION_STATUS_LABEL[status]}
    </StatusPill>
  );
}

export function AlertStatusBadge({
  status,
  className,
}: {
  status: AlertStatus;
  className?: string;
}) {
  return (
    <StatusPill className={cn(ALERT_STATUS_CLASS[status], className)}>
      {ALERT_STATUS_LABEL[status]}
    </StatusPill>
  );
}

/**
 * The admin console's signature structural device: a 4-tick ladder that
 * mirrors the real GRAP staging system instead of a generic colored dot.
 * Filled ticks up to the current stage; unfilled ticks beyond it.
 */
export function GrapLadder({ stage, className }: { stage: GRAPStage; className?: string }) {
  const active = GRAP_STAGE_INDEX[stage];
  const tickColor = ['bg-grap-stage1', 'bg-grap-stage2', 'bg-grap-stage3', 'bg-grap-stage4'];
  return (
    <div
      className={cn('flex items-center gap-1', className)}
      role="img"
      aria-label={GRAP_STAGE_LABEL[stage]}
      title={GRAP_STAGE_LABEL[stage]}
    >
      {[1, 2, 3, 4].map((tick) => (
        <span
          key={tick}
          className={cn(
            'h-4 w-1.5 rounded-full',
            tick <= active ? tickColor[tick - 1] : 'bg-slate-200',
          )}
        />
      ))}
    </div>
  );
}
