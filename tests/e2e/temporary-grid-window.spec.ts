import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

test('keeps a bounded temporary grid while discovering ten thousand files', async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-temporary-grid-'));
  const directory = path.join(root, 'photos');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(directory);
  for (let start = 0; start < 10_000; start += 256) {
    await Promise.all(Array.from({ length: Math.min(256, 10_000 - start) }, (_, offset) => writeFile(path.join(directory, `photo${String(start + offset).padStart(4, '0')}.jpg`), '')));
  }
  const source = path.join(directory, 'photo0600.jpg');
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js'), source], env: { ...process.env, PHOTOALLISAI_USER_DATA: path.join(root, 'user-data'), PHOTOALLISAI_STARTUP_TRACE: '1', PHOTOALLISAI_CRASH_TRACE: '1' } });
  const electronProcess = app.process();
  try {
    const page = await app.firstWindow();
    const viewer = page.getByRole('region', { name: '临时看图', exact: true });
    await expect(viewer).toBeVisible();
    await expect.poll(() => viewer.locator('.filmstrip-count').textContent()).toContain('10000');
    const sessionId = await viewer.getAttribute('data-session-id');
    expect(sessionId).toBeTruthy();
    await expect.poll(async () => (await page.evaluate((id) => window.desktopApi.listTemporaryMediaPage({ sessionId: id, offset: 0, limit: 1 }), sessionId!)).totalCount).toBe(10_000);
    const lastPage = await page.evaluate((id) => window.desktopApi.listTemporaryMediaPage({ sessionId: id, offset: 9_750, limit: 250 }), sessionId!);
    expect(lastPage.totalCount).toBe(10_000);
    expect(lastPage.items[0]?.fileName).toBe('photo9750.jpg');
    const grid = viewer.locator('.indexed-filmstrip');
    await expect(grid).toBeVisible();
    await expect.poll(() => grid.locator('.thumb').count()).toBeGreaterThan(0);
    expect(await grid.locator('.thumb').count()).toBeLessThan(150);
    await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => grid.locator('.thumb').first().getAttribute('aria-label')).not.toBe('photo0000.jpg');
    expect(await grid.locator('.thumb').count()).toBeLessThan(150);
    await viewer.locator('.canvas-wrap').focus();
    await page.keyboard.press('ArrowRight');
    await expect(viewer.locator('.viewer-title')).toContainText('photo0601.jpg');
    await expect.poll(() => grid.locator('.thumb.is-selected').getAttribute('aria-label')).toBe('photo0601.jpg');
  } finally {
    await app.close();
    const timing = await readFile(path.join(root, 'user-data', 'logs', 'startup-timing.log')).catch(() => null);
    if (timing) await testInfo.attach('startup-timing', { body: timing, contentType: 'text/plain' });
    const crashTrace = await readFile(path.join(root, 'user-data', 'logs', 'crash-trace.log')).catch(() => null);
    if (crashTrace) {
      await testInfo.attach('crash-trace', { body: crashTrace, contentType: 'text/plain' });
      expect(crashTrace.toString()).toContain('image-cache-stopped');
      expect(crashTrace.toString()).toContain('app-quit');
    }
    await rm(root, { recursive: true, force: true });
    expect(electronProcess?.exitCode).toBe(0);
  }
});
