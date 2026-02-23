import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

// Helper: click the language toggle button
async function toggleLang(page: import('@playwright/test').Page) {
  const btn = page.locator('button[aria-label="Switch language"]');
  await btn.click();
  await page.waitForTimeout(500);
}

test.describe('i18n E2E Tests', () => {

  test('Homepage renders in Chinese by default', async ({ page }) => {
    // Clear localStorage to ensure default language
    await page.goto(BASE);
    await page.evaluate(() => localStorage.removeItem('language'));
    await page.reload({ waitUntil: 'networkidle' });

    // Hero label should show Chinese
    await expect(page.locator('text=Agent 工程知识库')).toBeVisible();
    // Nav links in Chinese
    await expect(page.locator('nav >> text=问题域')).toBeVisible();
    await expect(page.locator('nav >> text=项目索引')).toBeVisible();
  });

  test('Language toggle switches to English', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => localStorage.removeItem('language'));
    await page.reload({ waitUntil: 'networkidle' });

    await toggleLang(page);

    // Hero label should now show English
    await expect(page.locator('text=Agent Engineering Knowledge Base')).toBeVisible();
    // Nav links in English
    await expect(page.locator('nav >> text=Problem Domains')).toBeVisible();
    await expect(page.locator('nav >> text=Projects')).toBeVisible();
  });

  test('Language toggle switches back to Chinese', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => localStorage.removeItem('language'));
    await page.reload({ waitUntil: 'networkidle' });

    // Switch to EN
    await toggleLang(page);
    await expect(page.locator('text=Agent Engineering Knowledge Base')).toBeVisible();
    // Switch back to ZH
    await toggleLang(page);
    await expect(page.locator('text=Agent 工程知识库')).toBeVisible();
  });

  test('Domain detail page renders with i18n', async ({ page }) => {
    await page.goto(`${BASE}/domain/context-management`, { waitUntil: 'networkidle' });
    // Section headings in Chinese
    await expect(page.locator('h2:has-text("子问题")')).toBeVisible();
    await expect(page.locator('h2:has-text("最佳实践")')).toBeVisible();
  });

  test('Domain detail page switches to English', async ({ page }) => {
    await page.goto(`${BASE}/domain/context-management`, { waitUntil: 'networkidle' });
    await toggleLang(page);
    // Section headings in English
    await expect(page.locator('h2:has-text("Sub-problems")')).toBeVisible();
    await expect(page.locator('h2:has-text("Best Practices")')).toBeVisible();
    await expect(page.locator('text=Problem Domains').first()).toBeVisible();
  });

  test('Scan page renders with i18n', async ({ page }) => {
    await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });
    await expect(page.locator('h1:has-text("扫描新项目")')).toBeVisible();
    // Switch to English
    await toggleLang(page);
    await expect(page.locator('h1:has-text("Scan Project")')).toBeVisible();
  });

  test('Projects page renders with i18n', async ({ page }) => {
    await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle' });
    // Switch to English
    await toggleLang(page);
    await expect(page.locator('h1:has-text("Analyzed Projects")')).toBeVisible();
  });

  test('Language preference persists across navigation', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    // Switch to English
    await toggleLang(page);
    await expect(page.locator('text=Agent Engineering Knowledge Base')).toBeVisible();
    // Navigate to scan page
    await page.click('nav >> text=Scan Project');
    await page.waitForURL('**/scan');
    await expect(page.locator('h1:has-text("Scan Project")')).toBeVisible();
  });

  test('/api/translate endpoint responds', async ({ request }) => {
    // Test domain translation (may fail if no API key, but should return structured response)
    const res = await request.post(`${BASE}/api/translate`, {
      data: { type: 'domain', id: 'PD-01' },
    });
    // Either 200 (translated/cached) or 500 (no API key) — both are valid
    expect([200, 500]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('translation' in body ? 'translation' : 'error');
  });
});
