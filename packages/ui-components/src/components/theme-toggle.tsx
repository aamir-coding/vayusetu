import * as React from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '../lib/cn';
import { useTheme } from '../lib/theme';

export interface ThemeToggleProps {
  className?: string;
  /** Accessible names, already translated by the app. */
  labels?: { toDark: string; toLight: string };
  /** Show the text label next to the icon (menus); icon-only otherwise. */
  showLabel?: boolean;
}

export function ThemeToggle({ className, labels = { toDark: 'Dark mode', toLight: 'Light mode' }, showLabel = false }: ThemeToggleProps) {
  const { resolved, toggle } = useTheme();
  const label = resolved === 'dark' ? labels.toLight : labels.toDark;
  const Icon = resolved === 'dark' ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        className,
      )}
    >
      <Icon className="h-[18px] w-[18px] transition-transform duration-300 [transform:rotate(0deg)] motion-safe:group-hover:rotate-12" aria-hidden="true" />
      {showLabel && <span className="text-sm">{label}</span>}
    </button>
  );
}
