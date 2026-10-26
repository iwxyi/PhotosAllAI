import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';
import { TaskService } from '../../apps/desktop/src/main/task-service';

test('viewer rating and color update immediately and persist after reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-viewer-metadata-'));
  const userData = path.join(root, 'data');
  const source = path.join(root, 'photos');
  await mkdir(source);
  await mkdir(path.join(userData, 'library'), { recursive: true });
  await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), path.join(source, 'PHOTO.jpg'));
  const catalog = new CatalogService(path.join(userData, 'library/catalog.sqlite'));
  await catalog.importFolders([source]);
  catalog.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await page.locator('.catalog-card').first().dblclick();
    const viewer = page.getByRole('region', { name: '看图', exact: true });
    const openMenu = async () => {
      await viewer.locator('.canvas-wrap').click({ button: 'right' });
      return viewer.getByRole('menu', { name: /照片菜单/ });
    };
    let menu = await openMenu();
    await menu.getByRole('button', { name: '4 星', exact: true }).click();
    menu = await openMenu();
    await expect(menu.getByRole('button', { name: '4 星', exact: true }).locator('svg')).toHaveAttribute('fill', 'currentColor');
    await menu.getByRole('button', { name: '红色标签', exact: true }).click();
    await expect(viewer.locator('.thumb[data-label-color="red"]')).toBeVisible();
    menu = await openMenu();
    await expect(menu.getByRole('button', { name: '红色标签', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.catalog-card').first().dblclick();
    await expect(viewer.locator('.thumb[data-label-color="red"]')).toBeVisible();
    menu = await openMenu();
    await menu.getByRole('button', { name: '清除颜色标签', exact: true }).click();
    await expect(viewer.locator('.thumb[data-label-color]')).toHaveCount(0);
    menu = await openMenu();
    await menu.getByRole('button', { name: '清除评分', exact: true }).click();
    menu = await openMenu();
    await expect(menu.getByRole('button', { name: '1 星', exact: true }).locator('svg')).toHaveAttribute('fill', 'none');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('color mats stay consistent across library views, batch queue and filtered task previews', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'photo-color-mats-'));
  const source = path.join(root, 'photos');
  const userData = path.join(root, 'data');
  const database = path.join(userData, 'library/catalog.sqlite');
  await mkdir(source);
  await mkdir(path.dirname(database), { recursive: true });
  const colors = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
  for (const color of colors) await copyFile(path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg'), path.join(source, `${color}.jpg`));
  const catalog = new CatalogService(database);
  await catalog.importFolders([source]);
  const assets = catalog.listAssets();
  for (const color of colors) catalog.updateMetadata({ assetIds: [assets.find((asset) => asset.fileName === `${color}.jpg`)!.id], labelColor: color });
  const redId = assets.find((asset) => asset.fileName === 'red.jpg')!.id;
  catalog.close();
  const tasks = new TaskService(database);
  const task = tasks.enqueue({ kind: 'analysis', assetId: redId, payload: {} });
  tasks.pause(task.id);
  tasks.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.catalog-card[data-label-color]')).toHaveCount(5);
    await mkdir('test-results', { recursive: true });
    const themePalettes: Record<string, string[]> = {};
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => window.dispatchEvent(new CustomEvent('photoallisai-theme-change', { detail: value })), theme);
      for (const mode of ['网格视图', '瀑布流视图', '列表视图']) {
        await page.getByRole('button', { name: mode, exact: true }).click();
        const items = page.locator(mode === '列表视图' ? '.catalog-list-row' : '.catalog-card');
        await expect(items.locator('.photo-color-swatch')).toHaveCount(0);
        const backgrounds = await items.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundColor));
        expect(new Set(backgrounds).size).toBe(5);
        if (mode === '网格视图') themePalettes[theme] = backgrounds;
        else expect(backgrounds).toEqual(themePalettes[theme]);
        await expect(items.locator('img:not(.is-ready)')).toHaveCount(0);
        await page.screenshot({ path: `test-results/color-mats-${theme}-${mode}.png`, animations: 'disabled' });
      }
    }
    expect(themePalettes.light).not.toEqual(themePalettes.dark);
    await page.getByRole('button', { name: '网格视图', exact: true }).click();
    const red = page.locator(`.catalog-card[data-asset-id="${redId}"]`);
    await red.dblclick();
    const viewer = page.getByRole('region', { name: '看图', exact: true });
    await expect(viewer.locator('.thumb[data-label-color]')).toHaveCount(5);
    expect(await viewer.locator('.thumb[data-label-color]').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundColor))).toEqual(themePalettes.dark);
    await page.screenshot({ path: 'test-results/color-mats-filmstrip.png' });
    await viewer.locator('.canvas-wrap').click({ button: 'right' });
    await viewer.getByRole('menu').getByRole('menuitem', { name: /加入 AI 批量修图/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.batch-queue-original[data-label-color="red"]')).toBeVisible();
    await page.getByRole('textbox', { name: /搜索图库/ }).fill('green');
    await page.getByRole('button', { name: '打开工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: '任务中心', exact: true }).click();
    await page.locator('.task-center-page .task-batch-summary').click();
    const preview = page.locator('.task-center-page .task-member-preview');
    await expect(preview).toHaveAttribute('data-label-color', 'red');
    await page.evaluate((id) => window.desktopApi.updateCatalogMetadata({ assetIds: [id], labelColor: 'blue' }), redId);
    await expect(preview).toHaveAttribute('data-label-color', 'blue');
    await page.getByRole('button', { name: '后台任务', exact: true }).click();
    await page.locator('.task-drawer .task-batch-summary').click();
    await expect(page.locator('.task-drawer .task-member-preview')).toHaveAttribute('data-label-color', 'blue');
    await page.screenshot({ path: 'test-results/color-mats-tasks.png' });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
