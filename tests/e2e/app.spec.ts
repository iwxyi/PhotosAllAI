import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;
let userDataDirectory: string;
let backupDirectory: string;

async function openWorkspaceTab(label: string): Promise<void> {
  const tab = page.getByRole('tab', { name: label });
  if (await tab.count() === 0) {
    await page.getByRole('button', { name: '打开工作区' }).click();
    await page.getByRole('menuitem', { name: label }).click();
    return;
  }
  await tab.click();
}

test.beforeAll(async () => {
  userDataDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-e2e-'));
  backupDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-e2e-backup-'));
  electronApp = await electron.launch({
    args: [path.resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, PHOTOALLISAI_USER_DATA: userDataDirectory, PHOTOALLISAI_E2E_DEMO: '1' }
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  await Promise.all([
    rm(userDataDirectory, { recursive: true, force: true }),
    rm(backupDirectory, { recursive: true, force: true })
  ]);
});

test('catalog list checkbox selects all, deselects all and shows partial selection', async () => {
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const header = page.getByRole('checkbox', { name: '全选当前列表', exact: true });
  const rows = page.locator('.catalog-list-row input[type="checkbox"]');
  expect(await rows.count()).toBeGreaterThan(1);
  await header.check();
  expect(await rows.evaluateAll((elements) => elements.every((element) => (element as HTMLInputElement).checked))).toBe(true);
  await header.uncheck();
  expect(await rows.evaluateAll((elements) => elements.every((element) => !(element as HTMLInputElement).checked))).toBe(true);
  await rows.first().check();
  await expect(header).toHaveJSProperty('indeterminate', true);
  await header.check();
  await expect(header).toHaveJSProperty('indeterminate', false);
  await header.uncheck();
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
});

test('starts with the secure library workspace', async () => {
  await expect(page.getByText('PhotoAllIsAI')).toBeVisible();
  await expect(page.getByRole('tab', { name: '图库' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('2026 人像作品', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('添加关联文件夹')).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __viewerImageClasses?: string[] }).__viewerImageClasses = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const image = node.matches('.base-image') ? node : node.querySelector('.base-image');
        if (image) (window as typeof window & { __viewerImageClasses?: string[] }).__viewerImageClasses?.push(image.className);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator('.catalog-card').first().dblclick();
  await expect(page.getByRole('tab', { name: '看图' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __viewerImageClasses?: string[] }).__viewerImageClasses?.[0] ?? '')).toContain('is-ready');
  await expect(page.getByRole('button', { name: /加入生成队列/ })).toBeVisible();
  await page.getByRole('button', { name: '模板库' }).click();
  await expect(page.getByLabel('搜索模板')).toBeVisible();
  await page.getByRole('tab', { name: /看图/ }).click();
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await expect(page.getByText('文件信息')).toBeVisible();
  await expect(page.getByText('生成版本', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: /筛选/ }).click();
  await expect(page.getByRole('dialog', { name: '图库筛选' })).toBeVisible();
  await page.getByLabel('仅显示首选照片').check();
  await expect(page.getByRole('button', { name: /筛选 · 首选/ })).toBeVisible();
  await page.getByRole('dialog', { name: '图库筛选' }).getByRole('button', { name: '清除筛选' }).click();
  await page.getByRole('button', { name: '网格视图' }).click();
  await expect(page.locator('.filmstrip')).toHaveClass(/is-grid/);
  await page.getByRole('button', { name: '胶片视图' }).click();
  await expect(page.locator('.filmstrip')).not.toHaveClass(/is-grid/);
  await page.getByLabel('图库排序').selectOption('fileName');
  await expect(page.getByLabel('图库排序')).toHaveValue('fileName');
  await page.getByLabel('图库排序').selectOption('modifiedAt');

  const security = await page.evaluate(() => ({
    hasDesktopApi: typeof window.desktopApi === 'object',
    hasNodeProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined'
  }));
  expect(security).toEqual({ hasDesktopApi: true, hasNodeProcess: false });

  await expect.poll(async () =>
    page.locator('img').evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0))
  ).toBe(true);

  const canvas = await page.locator('.photo-canvas').boundingBox();
  expect(canvas?.width).toBeGreaterThan(300);
  expect(canvas?.height).toBeGreaterThan(300);
  const sourceRatio = await page.locator('.base-image').evaluate((image) => {
    const element = image as HTMLImageElement;
    return element.naturalWidth / element.naturalHeight;
  });
  expect(Math.abs((canvas!.width / canvas!.height) - sourceRatio)).toBeLessThan(0.02);
});

test('keeps navigation and inspector mounted across library and viewer tabs', async () => {
  await openWorkspaceTab('图库');
  const firstCard = page.locator('.catalog-card').first();
  await firstCard.click();
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await expect(page.getByText('文件信息')).toBeVisible();
  await page.evaluate(() => {
    const left = document.querySelector('.sidebar');
    const right = document.querySelector('.inspector');
    if (left) (left as HTMLElement).dataset.sharedPane = 'left';
    if (right) (right as HTMLElement).dataset.sharedPane = 'right';
  });
  await firstCard.dblclick();
  await expect(page.locator('.sidebar[data-shared-pane="left"]')).toBeVisible();
  await expect(page.locator('.inspector[data-shared-pane="right"]')).toBeVisible();
  await expect(page.getByText('文件信息')).toBeVisible();
  await page.getByRole('tab', { name: '图库' }).click();
  await expect(page.locator('.sidebar[data-shared-pane="left"]')).toBeVisible();
  await expect(page.locator('.inspector[data-shared-pane="right"]')).toBeVisible();
  await expect(page.locator('.catalog-card').first()).toHaveAttribute('aria-selected', 'true');
  const nextName = await page.locator('.catalog-card').nth(1).locator('.catalog-card-meta strong').textContent();
  await page.locator('.catalog-card').nth(1).click();
  await expect(page.locator('.inspector-info .metadata-list')).toContainText(nextName!);
  await page.getByRole('tab', { name: '看图' }).click();
  await expect(page.locator('.inspector-info .metadata-list')).toContainText(nextName!);
  await page.getByRole('button', { name: 'AI', exact: true }).click();
});

test('keeps the selected photo AI inspector global across workflow tabs', async () => {
  await openWorkspaceTab('图库');
  const folderSidebar = page.locator('.global-workspace-shell > .sidebar');
  await folderSidebar.evaluate((element) => { (element as HTMLElement).dataset.globalNavigation = 'true'; });
  const leftWidth = await folderSidebar.evaluate((element) => element.getBoundingClientRect().width);
  const selectedName = await page.locator('.catalog-card').nth(1).locator('.catalog-card-meta strong').textContent();
  await page.locator('.catalog-card').nth(1).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.locator('.inspector').evaluate((element) => { (element as HTMLElement).dataset.globalInspector = 'true'; });

  await openWorkspaceTab('AI 工作流');
  await expect(page.locator('.sidebar[data-global-navigation="true"]')).toBeVisible();
  await expect(page.getByRole('tree', { name: '关联文件夹' })).toBeVisible();
  await expect.poll(() => folderSidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(leftWidth);
  await expect(page.locator('.workflow-analysis')).toBeVisible();
  await expect(page.locator('.inspector[data-global-inspector="true"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /处理中 1/ })).toBeVisible();
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await expect(page.locator('.inspector-info .metadata-list')).toContainText(selectedName!);
  await expect(page.getByRole('navigation', { name: 'AI 工作流阶段' })).toBeVisible();

  await openWorkspaceTab('任务中心');
  await expect(page.locator('.sidebar[data-global-navigation="true"]')).toBeVisible();
  await expect(page.locator('.inspector[data-global-inspector="true"]')).toBeVisible();
  await expect(page.locator('.inspector-info .metadata-list')).toContainText(selectedName!);
  await openWorkspaceTab('看图');
  await expect(page.locator('.sidebar[data-global-navigation="true"]')).toBeVisible();
});

test('adds selected photos to an independent ordered AI workflow queue', async () => {
  await openWorkspaceTab('图库');
  await expect(page.getByRole('button', { name: '打开看图' })).toHaveCount(0);
  const cards = page.locator('.catalog-card');
  await cards.nth(0).click();
  await cards.nth(0).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '加入 AI 工作流' })).toBeVisible();
  await page.getByRole('menuitem', { name: '加入 AI 工作流' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('AI 处理队列摘要')).toContainText('1 张');
  await cards.nth(1).click();
  await page.getByRole('button', { name: '加入 AI 工作流' }).click();
  await expect(page.getByLabel('AI 处理队列摘要')).toContainText('2 张');
  await expect(page.getByLabel('AI 处理队列摘要')).toContainText('第 2 位');

  await openWorkspaceTab('AI 工作流');
  await expect(page.locator('.workflow-queue-heading')).toContainText('处理队列');
  await expect(page.locator('.workflow-assets')).toHaveCount(0);
  await expect(page.getByLabel('工作流批次默认模板')).toBeVisible();
  const firstRule = page.locator('.workflow-inspector-settings .workflow-rule input[type="checkbox"]').first();
  await firstRule.uncheck();
  await openWorkspaceTab('图库');
  await expect(firstRule).not.toBeChecked();
  await openWorkspaceTab('AI 工作流');
  await firstRule.check();
  await expect(page.locator('.workflow-asset')).toHaveCount(2);
  const firstName = await page.locator('.workflow-asset').first().locator('strong').textContent();
  const secondName = await page.locator('.workflow-asset').nth(1).locator('strong').textContent();
  expect(firstName).not.toBe(secondName);
  await page.locator('.workflow-asset').first().getByRole('button', { name: /下移/ }).click();
  await expect(page.locator('.workflow-asset').first().locator('strong')).toHaveText(secondName!);
  await page.getByRole('navigation', { name: 'AI 工作流阶段' }).getByRole('button', { name: /优化建议/ }).click();
  await expect(page.locator('.workflow-asset')).toHaveCount(2);
  await page.locator('.workflow-asset').first().locator('.workflow-analysis-select').click();
  await expect(page.getByLabel('AI 处理队列摘要')).toContainText('第 1 位');
  await page.locator('.workflow-asset').first().getByRole('button', { name: /移除/ }).click();
  await expect(page.locator('.workflow-asset')).toHaveCount(1);
  await page.getByRole('button', { name: '清空队列' }).click();
  await expect(page.locator('.workflow-asset')).toHaveCount(0);
  await openWorkspaceTab('看图');
});

test('honors the reduced motion preference', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.locator('.working-pulse').first().evaluate((element) =>
    getComputedStyle(element).animationDuration)).toBe('0.001s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('supports mouse and trackpad navigation in the viewer', async () => {
  const canvasWrap = page.locator('.canvas-wrap');
  await canvasWrap.dispatchEvent('wheel', { deltaY: -120, ctrlKey: true, deltaMode: 0 });
  await expect(page.locator('.zoom-value')).not.toHaveText('100%');
  const beforePan = await page.locator('.photo-canvas').getAttribute('style');
  await canvasWrap.dispatchEvent('wheel', { deltaX: 32, deltaY: 24, deltaMode: 0 });
  await expect.poll(() => page.locator('.photo-canvas').getAttribute('style')).not.toBe(beforePan);
  const wrap = (await canvasWrap.boundingBox())!;
  const beforeDrag = await page.locator('.photo-canvas').getAttribute('style');
  await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
  await page.mouse.down();
  await page.mouse.move(wrap.x + wrap.width / 2 + 36, wrap.y + wrap.height / 2 + 20, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => page.locator('.photo-canvas').getAttribute('style')).not.toBe(beforeDrag);
  await page.getByRole('button', { name: '适应窗口' }).click();
  await expect(page.locator('.zoom-value')).toHaveText('100%');
});

test('uses arrow keys to change the current viewer photo', async () => {
  await openWorkspaceTab('图库');
  await page.locator('.catalog-card').first().dblclick();
  const filmstrip = page.locator('.filmstrip');
  const options = filmstrip.getByRole('option');
  await options.first().click();
  const firstSource = await page.locator('.base-image').getAttribute('src');
  await filmstrip.focus();
  await page.keyboard.press('ArrowRight');
  await expect(options.nth(1)).toHaveClass(/is-selected/);
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.locator('.base-image').getAttribute('src')).not.toBe(firstSource);
  await page.keyboard.press('ArrowLeft');
  await expect(options.first()).toHaveClass(/is-selected/);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.locator('.canvas-wrap').click();
  await page.keyboard.press('ArrowRight');
  await expect(options.nth(1)).toHaveClass(/is-selected/);
  await expect.poll(() => page.locator('.base-image').getAttribute('src')).not.toBe(firstSource);
});

test('supports folder appearance and professional catalog selection', async () => {
  await page.getByRole('tab', { name: '图库' }).click();
  const folderDisclosure = page.getByRole('button', { name: '收起关联文件夹区域' });
  await folderDisclosure.click();
  await expect(page.getByRole('button', { name: '展开关联文件夹区域' })).toBeVisible();
  await page.getByRole('button', { name: '展开关联文件夹区域' }).click();
  const folderEntry = page.locator('.folder-entry').first();
  await folderEntry.locator('.folder-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'red 色' }).click();
  await expect(folderEntry).toHaveClass(/color-red/);

  const cards = page.locator('.catalog-card');
  await expect(cards.nth(0).locator('.catalog-card-meta svg')).toHaveCount(5);
  await expect(cards.nth(1).locator('.catalog-card-meta svg')).toHaveCount(4);
  await cards.nth(0).click();
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(cards.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(cards.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+Shift+ArrowRight');
  await expect(cards.nth(3)).toHaveAttribute('aria-selected', 'true');
  await expect(cards.nth(1)).toHaveAttribute('draggable', 'true');

  const grid = (await page.locator('.catalog-grid').boundingBox())!;
  const second = (await cards.nth(1).boundingBox())!;
  await page.mouse.move(grid.x + 3, grid.y + 3);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width - 2, second.y + second.height - 2, { steps: 5 });
  await page.mouse.up();
  await expect(cards.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(cards.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(cards.nth(2)).toHaveAttribute('aria-selected', 'false');
  await cards.nth(0).click();
  await page.getByRole('tab', { name: /看图/ }).click();
  const filmstrip = page.locator('.filmstrip');
  const filmOptions = filmstrip.getByRole('option');
  await expect(filmOptions.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(filmOptions.nth(1)).toHaveAttribute('aria-selected', 'true');
  await filmstrip.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(filmOptions.nth(2)).toHaveAttribute('aria-selected', 'true');
  const selectedDrag = await filmOptions.nth(1).evaluate((element) => {
    const transfer = new DataTransfer();
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return JSON.parse(transfer.getData('application/x-photoallisai-assets')).length;
  });
  expect(selectedDrag).toBe(3);
  const unselectedDrag = await filmOptions.nth(3).evaluate((element) => {
    const transfer = new DataTransfer();
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return JSON.parse(transfer.getData('application/x-photoallisai-assets')).length;
  });
  expect(unselectedDrag).toBe(1);
  await page.getByRole('tab', { name: '图库' }).click();
  await expect(cards.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(cards.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(cards.nth(2)).toHaveAttribute('aria-selected', 'true');
  await cards.nth(1).click();
  await expect(page.locator('.catalog-card[aria-selected="true"]')).toHaveCount(3);
  await cards.nth(1).dblclick();
  await expect(page.getByRole('tab', { name: '看图' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.filmstrip [aria-selected="true"]')).toHaveCount(3);
});

test('switches photos and comparison modes', async () => {
  await expect(page.locator('.base-image')).toHaveClass(/is-ready/);
  const originalSource = await page.locator('.base-image').getAttribute('src');
  await page.locator('.filmstrip [role="option"]').nth(2).click();
  await expect(page.getByText('A7R_0912.ARW', { exact: true }).last()).toBeVisible();
  await expect(page.locator('.base-image')).not.toHaveAttribute('src', originalSource!);
  await expect(page.locator('.base-image')).toHaveClass(/is-ready/);

  await page.getByRole('button', { name: /对比/ }).click();
  await expect(page.getByLabel('调整原图和生成图分割线')).toBeVisible();

  await expect(page.locator('.zoom-value')).toHaveText('100%');
  const fittedCanvas = await page.locator('.photo-canvas').boundingBox();
  await page.getByRole('button', { name: '放大' }).click();
  await expect(page.locator('.zoom-value')).toHaveText('125%');
  await expect.poll(async () => (await page.locator('.photo-canvas').boundingBox())?.width ?? 0)
    .toBeGreaterThan(fittedCanvas!.width * 1.2);
  await page.getByRole('button', { name: '适应窗口' }).click();
  await expect(page.locator('.zoom-value')).toHaveText('100%');
});

test('resizes and restores Lightroom-style viewer panes', async () => {
  const leftSplitter = page.getByRole('separator', { name: '调整左侧目录栏宽度' });
  const rightSplitter = page.getByRole('separator', { name: '调整右侧 AI 面板宽度' });
  const filmstripSplitter = page.getByRole('separator', { name: '调整大图和胶片带高度' });
  await expect(leftSplitter).toHaveAttribute('aria-valuenow', '224');
  await expect(rightSplitter).toHaveAttribute('aria-valuenow', '300');
  await expect(filmstripSplitter).toHaveAttribute('aria-valuenow', '160');
  const thumbHeightBefore = (await page.locator('.filmstrip .thumb').first().boundingBox())!.height;
  await leftSplitter.press('ArrowRight');
  await rightSplitter.press('ArrowLeft');
  await filmstripSplitter.press('ArrowUp');
  await expect(leftSplitter).toHaveAttribute('aria-valuenow', '236');
  await expect(rightSplitter).toHaveAttribute('aria-valuenow', '312');
  await expect(filmstripSplitter).toHaveAttribute('aria-valuenow', '172');
  await expect.poll(async () => (await page.locator('.filmstrip .thumb').first().boundingBox())?.height ?? 0).toBeGreaterThan(thumbHeightBefore + 8);

  const viewer = await page.locator('.viewer').boundingBox();
  const filmstrip = await page.locator('.filmstrip-region').boundingBox();
  expect(viewer!.y).toBeLessThan(filmstrip!.y);

  await page.reload();
  if (await page.getByRole('tab', { name: '看图' }).count() === 0) {
    await page.locator('.catalog-card').first().dblclick();
  } else {
    await page.getByRole('tab', { name: '看图' }).click();
  }
  await expect(page.getByRole('separator', { name: '调整左侧目录栏宽度' })).toHaveAttribute('aria-valuenow', '236');
  await expect(page.getByRole('separator', { name: '调整右侧 AI 面板宽度' })).toHaveAttribute('aria-valuenow', '312');
  await expect(page.getByRole('separator', { name: '调整大图和胶片带高度' })).toHaveAttribute('aria-valuenow', '172');
});

test('supports additive, range, and select-all interactions', async () => {
  const options = page.locator('.filmstrip [role="option"]');
  await options.nth(5).click();
  await options.nth(0).click();
  await options.nth(2).click({ modifiers: ['Meta'] });
  await expect(page.locator('.filmstrip [aria-selected="true"]')).toHaveCount(2);

  await options.nth(4).click({ modifiers: ['Shift'] });
  await expect(page.locator('.filmstrip [aria-selected="true"]')).toHaveCount(3);

  await page.keyboard.press('Meta+A');
  await expect(page.locator('.filmstrip [aria-selected="true"]')).toHaveCount(6);
  await options.nth(0).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '照片菜单 6 张' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '按默认方案生成' })).toBeVisible();
  await expect(page.getByLabel('导出版本范围')).toHaveValue('preferred-or-latest');
  await page.getByLabel('导出版本范围').selectOption('all');
  await expect(page.getByLabel('导出版本范围')).toHaveValue('all');
  await page.keyboard.press('Escape');
});

test('opens the task drawer and application tabs', async () => {
  await page.getByRole('button', { name: /处理中 1/ }).click();
  await expect(page.getByText('当前任务')).toBeVisible();
  await expect(page.getByText('正在生成 · 64%')).toBeVisible();
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  await expect(page.locator('.task-table')).toBeVisible();

  await page.getByRole('tab', { name: /任务中心/ }).click();
  await expect(page.locator('.task-summary')).toBeVisible();
  await expect(page.getByText('暂无任务')).toBeVisible();

  await openWorkspaceTab('提示词模板');
  await expect(page.getByLabel('搜索模板')).toBeVisible();
  await expect(page.getByText('尚未创建模板')).toBeVisible();
  await expect(page.getByText('{{analysis.generative_actions}}', { exact: true })).toBeVisible();
  await page.getByLabel('模板名称').fill('E2E 人像清洁');
  await page.getByLabel('简短描述').fill('移除背景干扰并保持主体自然。');
  await page.getByRole('button', { name: '创建模板' }).click();
  await expect(page.getByText('E2E 人像清洁', { exact: true })).toBeVisible();
  await page.getByLabel('搜索模板').fill('清洁');
  await expect(page.getByRole('button', { name: /E2E 人像清洁/ })).toBeVisible();
  await page.getByLabel('模板分类').selectOption('风光');
  await expect(page.getByText('没有匹配模板')).toBeVisible();
  await page.getByLabel('模板分类').selectOption('全部分类');
  await page.getByLabel('搜索模板').fill('');
  await page.getByRole('button', { name: '预览模板' }).click();
  await expect(page.getByRole('dialog', { name: 'E2E 人像清洁' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('移除背景干扰并保持主体自然。')).toBeVisible();
  await expect(page.getByRole('dialog').locator('pre')).toContainText('{{analysis.generative_actions}}');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/prompt-templates.png', animations: 'disabled' });
  await page.getByRole('button', { name: '归档模板' }).click();
  await page.getByRole('button', { name: '确认归档' }).click();
  await expect(page.getByText('尚未创建模板')).toBeVisible();

  await openWorkspaceTab('设置');
  await expect(page.getByRole('button', { name: 'AI 模型' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Base URL')).toBeVisible();
  await expect(page.getByLabel('API Key')).toHaveAttribute('type', 'password');
  await expect(page.getByText('尚未配置模型')).toBeVisible();
  await expect(page.getByRole('heading', { name: '导出预设' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '诊断摘要' })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出诊断文件' })).toBeVisible();
  await page.getByRole('button', { name: '外观' }).click();
  await page.getByRole('radio', { name: /浅色/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'test-results/settings-light-theme.png', animations: 'disabled' });
  await page.getByRole('radio', { name: /深色/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'AI 模型' }).click();
  await page.getByLabel('导出预设名称').fill('客户交付');
  await page.getByRole('button', { name: '保存预设' }).click();
  await expect(page.getByText('客户交付', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除导出预设 客户交付' }).click();
  await expect(page.getByText('客户交付', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '图库与存储' }).click();
  await expect(page.getByRole('button', { name: '图库与存储' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: '生成结果存储' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '预览缓存' })).toBeVisible();
  await page.getByLabel('预览缓存磁盘上限').selectOption(String(1024 ** 3));
  await expect(page.locator('.cache-section').getByRole('status')).toContainText('缓存上限已保存');
  expect(JSON.parse(await readFile(path.join(userDataDirectory, 'settings', 'app.json'), 'utf8'))).toMatchObject({
    cacheMaxBytes: 1024 ** 3
  });
  await page.screenshot({ path: 'test-results/settings-storage.png', animations: 'disabled' });
  await expect(page.getByRole('heading', { name: '图库备份' })).toBeVisible();
  await electronApp.evaluate(({ dialog }, directory) => {
    const state = globalThis as typeof globalThis & { photoAllIsAiOriginalShowOpenDialog?: typeof dialog.showOpenDialog };
    state.photoAllIsAiOriginalShowOpenDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory], bookmarks: [] });
  }, backupDirectory);
  try {
    await page.getByRole('button', { name: '完整图库备份' }).click();
    await expect(page.locator('.backup-section').getByRole('status')).toContainText('完整图库已备份');
  } finally {
    await electronApp.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & { photoAllIsAiOriginalShowOpenDialog?: typeof dialog.showOpenDialog };
      if (state.photoAllIsAiOriginalShowOpenDialog) {
        dialog.showOpenDialog = state.photoAllIsAiOriginalShowOpenDialog;
        delete state.photoAllIsAiOriginalShowOpenDialog;
      }
    });
  }
  const backupNames = (await readdir(backupDirectory)).filter((name) => name.startsWith('PhotoAllIsAI-library-'));
  expect(backupNames).toHaveLength(1);
  const backupPath = path.join(backupDirectory, backupNames[0]!);
  expect((await stat(path.join(backupPath, 'catalog.sqlite'))).isFile()).toBe(true);
  const manifest = JSON.parse(await readFile(path.join(backupPath, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expect(Object.keys(manifest)).toEqual(['schemaVersion', 'createdAt', 'catalog', 'generated']);
  expect(manifest.generated).toEqual([]);
  await electronApp.evaluate(({ dialog }, directory) => {
    const state = globalThis as typeof globalThis & { photoAllIsAiOriginalShowOpenDialog?: typeof dialog.showOpenDialog };
    state.photoAllIsAiOriginalShowOpenDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory], bookmarks: [] });
  }, backupPath);
  try {
    await page.getByRole('button', { name: '验证备份包' }).click();
    await expect(page.locator('.backup-section').getByRole('status')).toContainText('备份验证通过');
  } finally {
    await electronApp.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & { photoAllIsAiOriginalShowOpenDialog?: typeof dialog.showOpenDialog };
      if (state.photoAllIsAiOriginalShowOpenDialog) {
        dialog.showOpenDialog = state.photoAllIsAiOriginalShowOpenDialog;
        delete state.photoAllIsAiOriginalShowOpenDialog;
      }
    });
  }
  await electronApp.evaluate(({ dialog }, directory) => {
    const state = globalThis as typeof globalThis & {
      photoAllIsAiOriginalShowOpenDialog?: typeof dialog.showOpenDialog;
      photoAllIsAiOriginalShowMessageBox?: typeof dialog.showMessageBox;
    };
    state.photoAllIsAiOriginalShowOpenDialog = dialog.showOpenDialog;
    state.photoAllIsAiOriginalShowMessageBox = dialog.showMessageBox;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory], bookmarks: [] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, backupPath);
  try {
    await page.getByRole('button', { name: '从完整备份恢复' }).click();
    await expect(page.locator('.backup-section').getByRole('status')).toContainText('已取消图库恢复');
  } finally {
    await electronApp.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        photoAllIsAiOriginalShowOpenDialog?: typeof dialog.showOpenDialog;
        photoAllIsAiOriginalShowMessageBox?: typeof dialog.showMessageBox;
      };
      if (state.photoAllIsAiOriginalShowOpenDialog) dialog.showOpenDialog = state.photoAllIsAiOriginalShowOpenDialog;
      if (state.photoAllIsAiOriginalShowMessageBox) dialog.showMessageBox = state.photoAllIsAiOriginalShowMessageBox;
      delete state.photoAllIsAiOriginalShowOpenDialog;
      delete state.photoAllIsAiOriginalShowMessageBox;
    });
  }
  await page.getByRole('button', { name: '任务与重试' }).click();
  await expect(page.getByRole('heading', { name: '队列执行' })).toBeVisible();
  await page.getByRole('button', { name: '快捷键' }).click();
  await expect(page.getByRole('heading', { name: '工作流快捷键' })).toBeVisible();
  await page.getByRole('button', { name: '隐私与安全' }).click();
  await expect(page.getByRole('heading', { name: '数据边界' })).toBeVisible();
  await page.screenshot({ path: 'test-results/settings-models.png', animations: 'disabled' });
  await page.getByRole('tab', { name: /看图/ }).click();
});

test('restores open tabs, active workspace, and selected photo', async () => {
  await page.locator('.filmstrip [role="option"]').nth(2).click();
  await page.getByRole('button', { name: /最近 30 天/ }).click();
  await page.getByRole('button', { name: '筛选' }).click();
  await page.getByRole('checkbox', { name: '仅显示首选照片' }).check();
  await page.getByLabel('图库排序').selectOption('rating');
  await page.getByRole('button', { name: '关闭设置标签页' }).click();
  await expect(page.getByRole('tab', { name: '设置' })).toHaveCount(0);
  await page.getByRole('tab', { name: /任务中心/ }).click();
  await page.waitForTimeout(500);

  await page.reload();
  await expect(page.getByRole('tab', { name: /任务中心/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '设置' })).toHaveCount(0);
  await page.getByRole('tab', { name: /看图/ }).click();
  await expect(page.getByRole('button', { name: /最近 30 天/ })).toHaveClass(/is-active/);
  await expect(page.getByRole('button', { name: '筛选 · 首选' })).toBeVisible();
  await expect(page.getByLabel('图库排序')).toHaveValue('rating');
  await expect(page.locator('.result-summary strong')).toHaveText('最近 30 天');
  await expect(page.getByText('A7R_0912.ARW', { exact: true }).last()).toBeVisible();
  await expect(page.locator('.generated-layer img')).toHaveCSS('object-fit', 'cover');

  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.screenshot({ path: 'test-results/workspace-tab-menu.png', animations: 'disabled' });
  await page.getByRole('menuitem', { name: '设置' }).click();
  await expect(page.getByRole('button', { name: 'AI 模型' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('tab', { name: /看图/ }).click();
});

test('captures the primary workspace for visual inspection', async () => {
  await page.screenshot({
    path: 'test-results/library-workspace.png',
    animations: 'disabled'
  });
});
