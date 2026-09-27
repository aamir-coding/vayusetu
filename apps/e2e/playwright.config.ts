import { defineConfig, devices } from '@playwright/test';

/**
 * Both apps run their Vite dev servers in MSW mock mode (the default in dev
 * with no .env.local): no backend, no Firebase, no live data touched.
 * `reuseExistingServer` lets a developer keep `pnpm dev` running.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  projects: [
    { name: 'citizen', testMatch: /citizen\.spec\.ts/, use: { baseURL: 'http://localhost:5173' } },
    { name: 'admin', testMatch: /admin\.spec\.ts/, use: { baseURL: 'http://localhost:5174' } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @vayusetu/citizen-pwa dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: '../..',
    },
    {
      command: 'pnpm --filter @vayusetu/admin-dashboard dev',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: '../..',
    },
  ],
});
