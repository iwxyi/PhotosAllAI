import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('repairs a missing collections table and finishes loading the library', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-catalog-load-recovery-'));
  const library = path.join(root, 'library');
  await mkdir(library);
  const databasePath = path.join(library, 'catalog.sqlite');
  new CatalogService(databasePath).close();
  const database = new DatabaseSync(databasePath);
  database.exec('DROP TABLE smart_collections');
  database.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: root } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('正在读取图库')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /最近 30 天 0/ })).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
