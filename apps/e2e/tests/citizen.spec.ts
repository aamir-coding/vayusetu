import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const locale = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../citizen-pwa/src/i18n/locales/${lang}.json`, import.meta.url), 'utf-8'));
const en = locale('en');
const hi = locale('hi');

/** Mock-mode API calls go through MSW inside the page; its db lives in page memory. */
async function createReports(page: Page, n: number): Promise<string[]> {
  return page.evaluate(async (count) => {
    const sess = JSON.parse(localStorage.getItem('vayusetu:mockAuthSession') ?? 'null');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer mock-token:${sess?.uid}` };
    await fetch('/api/v1/users/register', {
      method: 'POST', headers, body: JSON.stringify({ displayName: 'Anand', preferredLanguage: 'en-IN', role: 'field_worker' }),
    });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = await fetch('/api/v1/submissions', {
        method: 'POST', headers,
        body: JSON.stringify({ mediaType: 'photo', photoStorageUrl: 'gs://mock/p.jpg', geo: { lat: 28.63, lng: 77.22 },
          capturedAt: new Date().toISOString(), fieldSensorReading: { pm25: 182, pm10: 260 } }),
      });
      ids.push((await r.json()).submission.id);
    }
    return ids;
  }, n);
}

/** Client-side navigation: a full reload would wipe the in-page MSW db. */
async function spaNavigate(page: Page, path: string) {
  await page.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, path);
}

test.describe('citizen PWA (mock mode)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/capture');
    await page.evaluate(() => { localStorage.removeItem('i18nextLng'); });
    await page.goto('/capture');
    await expect(page.getByRole('heading', { name: en.capture.title })).toBeVisible();
  });

  test('language switch to Hindi', async ({ page }) => {
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'हिन्दी' }).click();
    await expect(page.getByRole('heading', { name: hi.capture.title })).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('i18nextLng'));
  });

  test('result screen keeps polling from `queued` until the analysis lands', async ({ page }) => {
    // Regression (27 Sep live rehearsal): the screen polled only while
    // `pending_analysis`, so opening it while the report was still `queued`
    // (a real cold start) stopped polling and it spun forever.
    const [id] = await createReports(page, 1);
    await spaNavigate(page, `/result/${id}`);
    await expect(page.getByText(en.result.analyzing)).toBeVisible();
    await expect(page.getByText(en.result.analyzing)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: en.result.title })).toBeVisible();
  });

  test('Pipeline D: clarifying question -> answer -> re-analysed result, with sensor panel', async ({ page }) => {
    // The mock rotates four analysis presets; the third report is "indeterminate" and asks a question.
    const ids = await createReports(page, 3);
    await page.waitForTimeout(3600); // mock pipeline: queued -> analysed after ~3.2 s
    await spaNavigate(page, `/result/${ids[2]}`);
    await expect(page.getByText(en.result.clarifyTitle)).toBeVisible();
    await expect(page.getByText(en.result.sensorsTitle, { exact: false })).toBeVisible();
    await expect(page.getByText('Your sensor PM2.5: 182 µg/m³')).toBeVisible();

    await page.getByPlaceholder(en.result.clarifyPlaceholder).fill('A pile of garbage is burning next to the road');
    await page.getByRole('button', { name: en.result.clarifySend }).click();
    await expect(page.getByText(en.result.clarifyTitle)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(en.pollutionSource.open_waste_burning)).toBeVisible();
  });

  test('My Reports lists the citizen\'s reports and flags the one awaiting an answer', async ({ page }) => {
    await createReports(page, 3);
    await page.waitForTimeout(3600);
    await spaNavigate(page, '/reports');
    // Registered behind the app's back (via MSW), so the profile may not be loaded yet: either title.
    await expect(page.getByRole('heading', { name: new RegExp(`^(${en.reports.title}|${en.reports.titleFieldWorker})$`) })).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('link', { name: en.reports.awaitingAnswer })).toBeVisible();
  });
});
