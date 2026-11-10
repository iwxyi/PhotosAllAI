import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('left and right arrows cross justified gallery rows in photo order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-catalog-navigation-'));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: directory, PHOTOALLISAI_E2E_DEMO: '1' } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 600));
    const grid = page.locator('.catalog-justified');
    await expect(grid.locator('.catalog-card')).toHaveCount(6);
    const rowBreak = await grid.locator('.catalog-card').evaluateAll((cards) => cards.findIndex((card, index) => index > 0 && Math.abs(card.getBoundingClientRect().top - cards[0]!.getBoundingClientRect().top) > 1));
    expect(rowBreak).toBeGreaterThan(0);
    const rowEnd = grid.locator('.catalog-card').nth(rowBreak - 1);
    const nextRowStart = grid.locator('.catalog-card').nth(rowBreak);
    const rowEndId = await rowEnd.getAttribute('data-asset-id');
    const nextRowStartId = await nextRowStart.getAttribute('data-asset-id');
    await rowEnd.click();
    await page.keyboard.press('ArrowRight');
    await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', nextRowStartId!);
    await page.keyboard.press('ArrowLeft');
    await expect(grid.locator('.catalog-card.is-focused')).toHaveAttribute('data-asset-id', rowEndId!);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
