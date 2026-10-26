import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

test('gallery dimensions group the complete folder with independent masonry sections', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photo-browse-'));
  const userData = path.join(directory, 'user-data');
  await mkdir(path.join(userData, 'library'), { recursive: true });
  const catalog = new CatalogService(path.join(userData, 'library', 'catalog.sqlite'));
  const source = path.resolve('apps/desktop/src/renderer/public/demo');
  const fixtures = [
    ['A/one.jpg', 'portrait.jpg', 0], ['A/two.png', 'street.jpg', 0],
    ['B/three.jpg', 'mountain.jpg', 1], ['B/four.jpg', 'coast.jpg', 0],
    ['B/sub/five.jpg', 'city.jpg', 0], ['B/sub/six.jpg', 'forest.jpg', 1]
  ] as const;
  for (const [relative, image, month] of fixtures) {
    const file = path.join(directory, 'photos', relative);
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(path.join(source, image), file);
    const date = new Date(2026, month, 15, 12);
    await utimes(file, date, date);
  }
  await catalog.importFolders([path.join(directory, 'photos')]);
  catalog.close();
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.getByLabel('图库排序', { exact: true }).selectOption('fileName');
    await expect(page.locator('.catalog-card-meta strong').first()).toHaveText('five.jpg');
    await page.getByRole('button', { name: '图库排序：正序，点击切换', exact: true }).click();
    await expect(page.locator('.catalog-card-meta strong').first()).toHaveText('two.png');
    await page.getByRole('button', { name: '图库排序：逆序，点击切换', exact: true }).click();
    await page.getByRole('button', { name: '图库过滤器', exact: true }).click();
    await expect(page.getByRole('button', { name: '按日期分组', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '按文件夹分组', exact: true })).toBeVisible();
    await page.getByRole('group', { name: '图库分组维度', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitemcheckbox', { name: '月份', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: '格式', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.getByRole('button', { name: '瀑布流视图', exact: true }).click();
    await expect.poll(() => page.locator('.catalog-card img.is-ready').count()).toBe(6);
    await page.evaluate(() => {
      (window as unknown as { browseImages: Map<string, Element> }).browseImages = new Map([...document.querySelectorAll<HTMLElement>('.catalog-card')].map((card) => [card.dataset.assetId!, card.querySelector('img')!]));
    });
    await page.getByRole('button', { name: '按文件夹分组', exact: true }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.catalog-card')].every((card) => (window as unknown as { browseImages: Map<string, Element> }).browseImages.get(card.dataset.assetId!) === card.querySelector('img')))).toBe(true);
    await page.getByRole('button', { name: '按文件夹分组', exact: true }).click();
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.catalog-card')].every((card) => (window as unknown as { browseImages: Map<string, Element> }).browseImages.get(card.dataset.assetId!) === card.querySelector('img')))).toBe(true);
    await page.getByRole('button', { name: '按文件夹分组', exact: true }).click();
    await expect(page.locator('.catalog-photo-group')).toHaveCount(3);
    await expect(page.locator('.catalog-group-heading').first()).toContainText('photos / A');
    await page.getByRole('button', { name: '文件夹：正序，点击切换' }).click();
    await expect(page.locator('.catalog-group-heading').first()).toContainText('photos / B / sub');
    await page.getByRole('button', { name: '文件夹：逆序，点击切换' }).click();
    await page.getByRole('button', { name: '按月份分组', exact: true }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await expect(page.locator('.catalog-photo-group')).toHaveCount(5);
    await page.getByRole('button', { name: '配置图库分组字段', exact: true }).click();
    await page.getByRole('button', { name: '上移月份', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.catalog-group-heading').first()).toContainText('2026-02 · photos / B');
    await page.getByRole('button', { name: '配置图库分组字段', exact: true }).click();
    await page.getByRole('button', { name: '下移月份', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    await expect(page.locator('.catalog-list-row')).toHaveCount(6);
    await expect(page.locator('.catalog-group-heading')).toHaveCount(5);
    await page.getByRole('button', { name: '瀑布流视图', exact: true }).click();
    await expect(page.locator('.catalog-group-heading').first()).toContainText('photos / A');
    await expect(page.locator('.catalog-group-heading').first()).toContainText('2026-01');
    await page.getByRole('button', { name: '月份：逆序，点击切换' }).click();
    await expect(page.locator('.catalog-group-heading').nth(1)).toContainText('2026-01');
    await page.getByRole('button', { name: '月份：正序，点击切换' }).click();
    await page.getByRole('button', { name: '展开 photos', exact: true }).click();
    await page.getByRole('treeitem', { name: /^B 4/ }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(4);
    await expect(page.locator('.catalog-photo-group')).toHaveCount(4);
    await page.getByRole('button', { name: /所有照片 6/ }).click();
    await expect(page.locator('.catalog-photo-group')).toHaveCount(5);
    for (const [width, height] of [[1440, 900], [1000, 640]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!), [width!, height!]);
      await expect.poll(() => page.locator('.catalog-grid').evaluate((element) => {
        const cards = [...element.querySelectorAll<HTMLElement>('.catalog-card')];
        const groups = [...element.querySelectorAll<HTMLElement>('.catalog-photo-group')];
        return element.clientWidth >= element.scrollWidth && cards.every((card) => {
          const image = card.querySelector('img')!;
          const frame = card.querySelector('.catalog-card-image')!.getBoundingClientRect();
          return image.naturalHeight > 0 && Math.abs(frame.height - frame.width * image.naturalHeight / image.naturalWidth) < 2;
        }) && groups.every((group, index) => index === 0 || group.getBoundingClientRect().top >= groups[index - 1]!.getBoundingClientRect().bottom);
      })).toBe(true);
      await page.screenshot({ path: `test-results/catalog-browse-${width}.png`, animations: 'disabled' });
    }
    await page.locator('.catalog-grid').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.locator('.catalog-card[aria-selected="true"]')).toHaveCount(6);
    await page.locator('.catalog-card').first().dblclick();
    await expect(page.getByRole('region', { name: '看图', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.catalog-photo-group')).toHaveCount(5);
    await page.getByRole('button', { name: '按格式分组', exact: true }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await expect(page.locator('.catalog-photo-group')).toHaveCount(6);
    await page.getByRole('button', { name: '按日期分组', exact: true }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await page.getByRole('button', { name: '配置图库分组字段', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: '城市', exact: true }).click();
    await page.getByRole('button', { name: 'EXIF', exact: true }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: '相机型号', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitemcheckbox', { name: '颜色标签', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '更多', exact: true })).toHaveCount(0);
    await expect.poll(() => page.getByRole('menu', { name: '显示分组字段' }).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 8 && rect.top >= 8 && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8;
    })).toBe(true);
    await page.screenshot({ path: 'test-results/catalog-group-menu.png', animations: 'disabled' });
    await page.getByRole('menuitemcheckbox', { name: 'ISO 感光度', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '按城市分组', exact: true }).click();
    await page.getByRole('button', { name: '按ISO 感光度分组', exact: true }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await expect(page.locator('.catalog-group-loading')).toHaveCount(0);
    const groupsBeforeReset = await page.locator('.catalog-photo-group').count();
    await page.getByRole('button', { name: '至少 1 星', exact: true }).click();
    await page.getByRole('button', { name: '重置图库过滤器', exact: true }).click();
    await expect(page.locator('.catalog-card')).toHaveCount(6);
    await expect(page.locator('.catalog-photo-group')).toHaveCount(groupsBeforeReset);
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
