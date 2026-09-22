import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // vi.mock('@vayusetu/gcp-clients') in the test file replaces the whole
    // module for the test run -- no real GCP credentials or emulator
    // needed to run this suite.
  },
});