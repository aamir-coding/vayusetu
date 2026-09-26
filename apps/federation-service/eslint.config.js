import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // scripts/*.mjs are plain Node scripts (no @types/node-backed no-undef
    // exemption the way .ts files get) -- same pattern admin-dashboard and
    // citizen-pwa's eslint.config.js already use for their *.cjs configs.
    ignores: ['dist/', 'node_modules/', '.turbo/', '*.tsbuildinfo', 'scripts/*.mjs'],
  },
);
