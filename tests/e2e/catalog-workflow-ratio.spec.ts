import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { DEFAULT_FILE_WORKFLOW } from '../../packages/contracts/src/file-workflow';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('gallery uses the selected workflow file ratio after switching stages and restarting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-workflow-ratio-'));
  const userData = path.join(root, 'user-data');
  const photos = path.join(root, 'photos');
  await mkdir(path.join(userData, 'library'), { recursive: true });
  await mkdir(path.join(userData, 'settings'), { recursive: true });
  await mkdir(path.join(photos, '原图'), { recursive: true });
  await mkdir(path.join(photos, 'AI'), { recursive: true });
  await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), path.join(photos, '原图', 'DSC1.jpg'));
  await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/coast.jpg'), path.join(photos, 'AI', 'DSC1-AI-1.jpg'));
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  await catalog.importFolders([photos]);
  for (const asset of catalog.listAssetPage({ limit: 10 }).items) catalog.saveDimensions(asset.id, 1800, asset.fileName === 'DSC1.jpg' ? 2251 : 1197);
  catalog.close();
  await writeFile(path.join(userData, 'settings', 'file-workflows.json'), JSON.stringify({
    revision: 0, defaultPresetId: DEFAULT_FILE_WORKFLOW.id, presets: [DEFAULT_FILE_WORKFLOW], folders: {}, albums: {}
  }));
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => localStorage.setItem('photoallisai.catalog-view-mode', 'masonry'));
    await page.reload();
    const card = page.locator('.catalog-masonry .catalog-card');
    await expect(card).toHaveCount(1);
    const ratio = () => card.locator('.catalog-card-image').evaluate((element) => {
      const frame = element.getBoundingClientRect();
      return frame.width / frame.height;
    });
    const target = page.getByLabel('图库流程版本', { exact: true });
    await target.selectOption('stage:ai');
    await expect.poll(ratio).toBeGreaterThan(1);
    await target.selectOption('stage:original');
    await expect.poll(ratio).toBeLessThan(1);
    await expect(card.locator('img:not(.catalog-image-previous)')).toHaveClass('is-ready');
    await page.reload();
    await expect(card).toHaveCount(1);
    await expect(target).toHaveValue('stage:original');
    await expect.poll(ratio).toBeLessThan(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
