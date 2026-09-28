import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Ambient backdrop shared with the landing page's look: slowly drifting
 * brand-tinted light plus a faint hex grid. Pure CSS (three blurred blobs,
 * transform-only animation), so it costs a phone almost nothing; it holds
 * still under prefers-reduced-motion. Decorative only.
 */
export function Aurora({ className, hexGrid = true }: { className?: string; hexGrid?: boolean }) {
  return (
    <div aria-hidden="true" className={cn('pointer-events-none overflow-hidden', className)}>
      <div className="absolute -left-[20%] -top-[25%] h-[70vmax] w-[70vmax] rounded-full bg-brand-400/20 blur-3xl motion-safe:animate-drift-a dark:bg-brand-500/15" />
      <div className="absolute -right-[25%] top-[10%] h-[55vmax] w-[55vmax] rounded-full bg-sky-400/15 blur-3xl motion-safe:animate-drift-b dark:bg-sky-500/10" />
      <div className="absolute -bottom-[30%] left-[15%] h-[50vmax] w-[50vmax] rounded-full bg-accent-400/15 blur-3xl motion-safe:animate-drift-c dark:bg-accent-500/[0.08]" />
      {hexGrid && (
        <div
          className="absolute inset-0 opacity-[0.35] dark:opacity-[0.18]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='97' viewBox='0 0 56 97'%3E%3Cpath d='M28 0l28 16v32L28 64 0 48V16zM28 64v33' fill='none' stroke='%231F948C' stroke-opacity='0.14' stroke-width='1'/%3E%3C/svg%3E\")",
            maskImage: 'radial-gradient(ellipse at 50% 0%, black 20%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black 20%, transparent 75%)',
          }}
        />
      )}
    </div>
  );
}
