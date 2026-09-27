const preset = require('@vayusetu/config/tailwind-preset');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  // relative: globs resolve from this file, not the process cwd (vite may be
  // launched from the repo root or a tool's cwd).
  content: {
    relative: true,
    files: [
      './index.html',
      './src/**/*.{js,ts,jsx,tsx}',
      '../../packages/ui-components/src/**/*.{js,ts,jsx,tsx}',
    ],
  },
  plugins: [require('tailwindcss-animate')],
};
