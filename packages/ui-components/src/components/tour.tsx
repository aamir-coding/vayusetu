import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * A short guided tour: dims the screen, spotlights one element per step
 * (found by `data-tour="<target>"`), and explains it in a card. Steps
 * without a target, or whose target is hidden at this screen size (e.g. a
 * sidebar item on a phone), show a centred card instead.
 */
export interface TourStep {
  target?: string;
  title: string;
  body: string;
}

export interface TourLabels {
  next: string;
  back: string;
  done: string;
  skip: string;
  /** e.g. "2 of 5" */
  progress: (current: number, total: number) => string;
}

export interface TourProps {
  steps: TourStep[];
  open: boolean;
  onClose: (completed: boolean) => void;
  labels: TourLabels;
}

const PAD = 6;
const GAP = 14;

function findTarget(target?: string): HTMLElement | null {
  if (!target) return null;
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`));
  // The same target can exist twice (desktop sidebar + phone tab bar): use the visible one.
  return all.find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }) ?? null;
}

export function Tour({ steps, open, onClose, labels }: TourProps) {
  const [index, setIndex] = React.useState(0);
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const [cardSize, setCardSize] = React.useState({ w: 360, h: 200 });
  const cardRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const maskId = `tour-mask-${React.useId().replace(/:/g, '')}`;
  const step = steps[index];
  const last = index === steps.length - 1;

  React.useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Track the target's position (it can move with scroll, resize, layout).
  React.useLayoutEffect(() => {
    if (!open || !step) return;
    let raf = 0;
    const el = findTarget(step.target);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setRect(findTarget(step.target)?.getBoundingClientRect() ?? null));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, step]);

  React.useLayoutEffect(() => {
    if (!open || !cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    setCardSize((s) => (Math.abs(s.w - r.width) > 1 || Math.abs(s.h - r.height) > 1 ? { w: r.width, h: r.height } : s));
    cardRef.current.focus({ preventScroll: true });
  }, [open, index, rect]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false);
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, steps.length - 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, steps.length]);

  if (!open || !step || typeof document === 'undefined') return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cardStyle: React.CSSProperties;
  if (rect) {
    const below = rect.bottom + PAD + GAP;
    const fitsBelow = below + cardSize.h <= vh - 12;
    const top = fitsBelow ? below : Math.max(12, rect.top - PAD - GAP - cardSize.h);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - cardSize.w / 2), vw - cardSize.w - 12);
    cardStyle = { top, left };
  } else {
    cardStyle = { top: Math.max(12, vh / 2 - cardSize.h / 2), left: Math.max(12, vw / 2 - cardSize.w / 2) };
  }

  return createPortal(
    <div className="fixed inset-0 z-[70]" role="presentation">
      {/* One dimmed layer with a hole cut by an SVG mask: cheap on phone GPUs
          (a 9999px box-shadow spotlight is not). */}
      <svg aria-hidden="true" className="fixed inset-0 h-full w-full animate-in fade-in-0">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                rx={12}
                fill="black"
                className="transition-all duration-300 ease-out"
                style={{ x: rect.left - PAD, y: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } as React.CSSProperties}
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(6,14,18,0.62)" mask={`url(#${maskId})`} />
      </svg>
      {rect && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed rounded-xl ring-2 ring-brand-400 transition-all duration-300 ease-out"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      )}

      <div
        ref={cardRef}
        key={index}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed w-[min(360px,calc(100vw-24px))] rounded-2xl border border-slate-200 bg-surface p-5 shadow-2xl outline-none animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-300"
        style={cardStyle}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-brand-600">{labels.progress(index + 1, steps.length)}</span>
          <button
            type="button"
            onClick={() => onClose(false)}
            aria-label={labels.skip}
            className="-mr-1 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <h2 id={titleId} className="text-base font-bold text-ink">
          {step.title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{step.body}</p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-hidden="true">
            {steps.map((_, i) => (
              <span key={i} className={cn('h-1.5 rounded-full transition-all duration-300', i === index ? 'w-5 bg-brand-500' : 'w-1.5 bg-slate-300')} />
            ))}
          </div>
          <div className="flex gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex(index - 1)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {labels.back}
              </button>
            )}
            <button
              type="button"
              onClick={() => (last ? onClose(true) : setIndex(index + 1))}
              className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 dark:hover:bg-brand-500"
            >
              {last ? labels.done : labels.next}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Open state for a tour that starts by itself on a user's first visit
 * (remembered per `storageKey`) and can be replayed from a Help button.
 * Never auto-starts under automation (navigator.webdriver), so it cannot
 * cover the page in end-to-end tests.
 */
export function useTour(storageKey: string, { autoStart = true, delayMs = 600 } = {}) {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!autoStart || (typeof navigator !== 'undefined' && navigator.webdriver)) return;
    let seen = false;
    try {
      seen = localStorage.getItem(storageKey) === 'done';
    } catch {
      seen = true; // can't remember it -- don't show it on every visit
    }
    if (seen) return;
    const t = window.setTimeout(() => setOpen(true), delayMs);
    return () => window.clearTimeout(t);
  }, [autoStart, delayMs, storageKey]);

  const close = React.useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(storageKey, 'done');
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  return { open, start: React.useCallback(() => setOpen(true), []), close };
}
