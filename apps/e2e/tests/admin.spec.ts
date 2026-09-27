import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const locale = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../admin-dashboard/src/i18n/locales/${lang}.json`, import.meta.url), 'utf-8'));
const en = locale('en');
const hi = locale('hi');

async function signIn(page: Page, persona: 'Officer Deshmukh' | 'Ms. Iyer') {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(persona) }).click();
  await expect(page.getByRole('heading', { name: en.alerts.title })).toBeVisible();
}

test.describe('admin dashboard (mock mode)', () => {
  test('district admin: jurisdiction-scoped queue, no Federation', async ({ page }) => {
    await signIn(page, 'Officer Deshmukh');
    await expect(page.getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('link', { name: en.nav.federation })).toHaveCount(0);
    // Deep-linking is also refused (router gate mirrors the API's state_admin+ rule).
    await page.goto('/federation');
    await expect(page).toHaveURL(/\/alerts$/);
  });

  test('hotspot map: cells, hidden count, detail panel', async ({ page }) => {
    await signIn(page, 'Ms. Iyer');
    await page.getByRole('link', { name: en.nav.hotspots }).click();
    await expect(page.getByRole('heading', { name: en.hotspots.title })).toBeVisible();
    await expect(page.getByText(/4 cells · 2 hidden/)).toBeVisible();
    await expect(page.getByText(en.hotspots.selectCell)).toBeVisible();
    // Schematic fallback (no Maps key in dev): click the first plotted cell.
    await page.locator('svg[aria-label^="Hotspot"] g.cursor-pointer').first().click();
    await expect(page.getByText(en.hotspots.last7Days)).toBeVisible();
  });

  test('lite mode swaps the map for a plain table', async ({ page }) => {
    await signIn(page, 'Ms. Iyer');
    await page.getByRole('link', { name: en.nav.hotspots }).click();
    await page.getByRole('checkbox', { name: en.nav.liteModeToggle }).check();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: en.hotspots.table.confidence })).toBeVisible();
  });

  test('forecast: three horizons with GRAP stages', async ({ page }) => {
    await signIn(page, 'Ms. Iyer');
    await page.getByRole('link', { name: en.nav.forecast }).click();
    await expect(page.getByRole('heading', { name: en.forecast.title })).toBeVisible();
    // The horizon cards (the chart tooltip repeats the labels).
    const cards = page.locator('div.grid-cols-3');
    for (const h of ['+24h', '+48h', '+72h']) await expect(cards.getByText(h, { exact: true })).toBeVisible();
  });

  test('federation: state admin sees models + cross-state view; import is super_admin only', async ({ page }) => {
    await signIn(page, 'Ms. Iyer');
    await page.getByRole('link', { name: en.nav.federation }).click();
    await expect(page.getByRole('heading', { name: en.federation.title })).toBeVisible();
    const importButtons = page.getByRole('button', { name: en.federation.import });
    if ((await importButtons.count()) > 0) await expect(importButtons.first()).toBeDisabled();
    await page.getByRole('tab', { name: en.federation.tabExchange }).click();
    await expect(page.getByText(en.federation.byState)).toBeVisible();
    for (const state of ['DL', 'HR', 'UP']) await expect(page.getByText(state, { exact: true })).toBeVisible();
  });

  test('language switch to Hindi re-renders the console', async ({ page }) => {
    await signIn(page, 'Ms. Iyer');
    await page.getByRole('combobox', { name: en.nav.language }).click();
    await page.getByRole('option', { name: 'हिन्दी' }).click();
    await expect(page.getByRole('heading', { name: hi.alerts.title })).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('vayusetu-admin:lang'));
  });
});
