import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Capped: turbo runs several suites at once and unbounded fork pools
    // exhaust V8 memory on 16 GB laptops ("Zone Allocation failed").
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    include: ['test/**/*.test.ts'],
    // vi.mock('@vayusetu/gcp-clients') in the test file replaces the whole
    // module for the test run -- no real GCP credentials or emulator
    // needed to run this suite.
  },
});