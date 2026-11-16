import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('legacy portrait generation has portrait geometry from the first visible frame', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-generated-ratio-'));
  const userData = path.join(root, 'user-data');
  const photos = path.join(root, 'photos');
  const databasePath = path.join(userData, 'library', 'catalog.sqlite');
  const generatedPath = path.join(root, 'generated.jpg');
  await mkdir(path.dirname(databasePath), { recursive: true });
  await mkdir(photos);
  await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/coast.jpg'), path.join(photos, 'source.jpg'));
  await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), generatedPath);
  const catalog = new CatalogService(databasePath);
  await catalog.importFolders([photos]);
  const source = catalog.listAssetPage({ limit: 1 }).items[0]!;
  catalog.saveDimensions(source.id, 1800, 1197);
  catalog.close();
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE generation_results (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, batch_id TEXT NOT NULL, version INTEGER NOT NULL,
    file_name TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL,
    provider_profile_id TEXT NOT NULL, template_id TEXT, template_version INTEGER,
    created_at INTEGER NOT NULL, UNIQUE(asset_id, version)
  )`);
  const resultId = randomUUID();
  database.prepare(`INSERT INTO generation_results
    (id, asset_id, batch_id, version, file_name, file_path, prompt, provider_profile_id, created_at)
    VALUES (?, ?, ?, 1, 'generated.jpg', ?, '', ?, ?)`)
    .run(resultId, source.id, randomUUID(), generatedPath, randomUUID(), Date.now());
  database.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await page.addInitScript(() => {
      (window as typeof window & { visibleRatios: number[] }).visibleRatios = [];
      const sample = () => {
        const grid = document.querySelector<HTMLElement>('.catalog-grid');
        const frame = grid?.querySelector<HTMLElement>('.catalog-card-image');
        if (grid && frame && getComputedStyle(grid).visibility !== 'hidden') {
          const rect = frame.getBoundingClientRect();
          if (rect.height) (window as typeof window & { visibleRatios: number[] }).visibleRatios.push(rect.width / rect.height);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.evaluate(() => localStorage.setItem('photoallisai.catalog-view-mode', 'masonry'));
    await page.reload();
    const card = page.locator('.catalog-masonry .catalog-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('img:not(.catalog-image-previous)')).toHaveClass('is-ready');
    const visibleRatios = await page.evaluate(() => (window as typeof window & { visibleRatios: number[] }).visibleRatios);
    expect(visibleRatios.length).toBeGreaterThan(0);
    expect(visibleRatios.every((ratio) => ratio < 1)).toBe(true);
    const persisted = await page.evaluate(async ({ assetId, id }) => (await window.desktopApi.listGenerationResults(assetId)).find((item) => item.id === id), { assetId: source.id, id: resultId });
    expect(persisted).toMatchObject({ width: 1800, height: 2251 });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
