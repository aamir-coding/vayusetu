/**
 * Shared Tailwind design tokens for every VayuSetu frontend package.
 *
 * `apps/citizen-pwa` and `apps/admin-dashboard` both extend this preset so
 * brand color, type scale, and the domain color ramps are pixel-identical
 * across both surfaces. Domain colors below (`aqi`, `severity`, `grap`) are
 * kept deliberately separate from `brand` — they encode real data semantics
 * (the CPCB National AQI Bulletin's 6-category color scale, and the GRAP
 * staging ladder Delhi-NCR officials already use), so they must never be
 * repurposed for chrome/branding. Changing a hex in this file changes it
 * everywhere at once — that's the point; don't fork it per-app.
 *
 * Steward: whole team via Engineer 1 (frontend design-system owner). Ask
 * before changing `aqi` / `grap` values specifically, since Officer
 * Deshmukh and Ms. Iyer's mental model of these colors comes from other
 * government displays, not from us.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        // Bridge teal — the brand ramp. Never used for AQI/severity/GRAP data.
        brand: {
          50: '#EFFAF9',
          100: '#D3F1EE',
          200: '#A8E3DD',
          300: '#74CFC6',
          400: '#3FB3AA',
          500: '#1F948C',
          600: '#157B76',
          700: '#146560',
          800: '#14514E',
          900: '#133F3D',
          950: '#072423',
        },
        // Warm marigold accent — citizen-pwa only, used sparingly (primary
        // capture CTA glow, success confirmations). Never used on data.
        accent: {
          300: '#F9CD82',
          400: '#F5B04E',
          500: '#EFA22A',
          600: '#D6841A',
          700: '#B3690F',
        },
        // Cool-neutral background — deliberately not warm cream.
        paper: '#F5F8F7',
        ink: '#0E2224',
        // CPCB National AQI Bulletin 6-category scale — faithful hues.
        aqi: {
          good: '#4CAF50',
          satisfactory: '#9CCC65',
          moderate: '#FDD835',
          poor: '#FB8C00',
          veryPoor: '#E53935',
          severe: '#7E0023',
        },
        // Alert severity — a distinct axis from AQI (system-computed urgency,
        // not a pollution reading), so it gets its own scale to avoid the
        // two being visually conflated.
        severity: {
          info: '#2563EB',
          watch: '#B45309',
          warning: '#C2410C',
          critical: '#B91C1C',
        },
        // GRAP staging ladder (Graded Response Action Plan) — the 4-step
        // scale Delhi-NCR officials already use operationally.
        grap: {
          none: '#94A3B8',
          stage1: '#EAB308',
          stage2: '#F97316',
          stage3: '#EF4444',
          stage4: '#7F1D1D',
        },
      },
      fontFamily: {
        sans: ['Manrope', '"Hind"', 'system-ui', 'sans-serif'],
        devanagari: ['"Hind"', '"Noto Sans Devanagari"', 'system-ui', 'sans-serif'],
        gurmukhi: ['"Noto Sans Gurmukhi"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(14, 34, 36, 0.06), 0 4px 16px rgba(14, 34, 36, 0.08)',
        glow: '0 0 0 12px rgba(31, 148, 140, 0.08), 0 0 0 28px rgba(31, 148, 140, 0.04)',
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.55' },
          '50%': { transform: 'scale(1.06)', opacity: '0.85' },
        },
      },
      animation: {
        breathe: 'breathe 4.5s ease-in-out infinite',
      },
    },
  },
};
