import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { _electron as electron, expect, test } from '@playwright/test';

import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

function pastedFileUrls(): { urls: string[]; types: string[][] } {
  const script = `ObjC.import('AppKit');
var items = $.NSPasteboard.generalPasteboard.pasteboardItems;
var urls = [];
var types = [];
for (var i = 0; i < items.count; i++) {
  var item = items.objectAtIndex(i);
  types.push(ObjC.deepUnwrap(item.types));
  var url = item.stringForType($.NSPasteboardTypeFileURL);
  if (url) urls.push(ObjC.unwrap(url));
}
var paths = ObjC.deepUnwrap($.NSPasteboard.generalPasteboard.propertyListForType($.NSFilenamesPboardType));
if (paths && paths.length) urls = paths.map(function(path) { return ObjC.unwrap($.NSURL.fileURLWithPath($(path)).absoluteString); });
JSON.stringify({urls: urls, types: types});`;
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim()) as { urls: string[]; types: string[][] };
}

test('copies every selected displayed file to the native clipboard', async () => {
  test.skip(process.platform !== 'darwin', 'Native pasteboard inspection requires macOS');
  const root = await mkdtemp(path.join(tmpdir(), 'photoallisai-file-transfer-'));
  const source = path.join(root, 'source');
  const library = path.join(root, 'user-data', 'library');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await Promise.all([mkdir(source), mkdir(library, { recursive: true })]);
    const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
    await Promise.all(['FIRST.jpg', 'SECOND.jpg'].map((name) => copyFile(fixture, path.join(source, name))));
    const catalog = new CatalogService(path.join(library, 'catalog.sqlite'));
    await catalog.importFolders([source]);
    catalog.close();
    app = await electron.launch({
      args: [path.resolve('apps/desktop/out/main/index.js')],
      env: { ...process.env, PHOTOALLISAI_USER_DATA: path.join(root, 'user-data') }
    });
    const page = await app.firstWindow();
    await expect(page.locator('.catalog-card')).toHaveCount(2);
    const actualExpected = await Promise.all(['FIRST.jpg', 'SECOND.jpg'].map(async (name) => pathToFileURL(await realpath(path.join(source, name))).href));
    const copySelection = async (selector: string) => {
      const items = page.locator(selector);
      await items.first().click();
      await items.nth(1).click({ modifiers: ['Meta'] });
      await expect(items.filter({ has: page.locator('[aria-selected="true"]') })).toHaveCount(0);
      await expect.poll(() => items.evaluateAll((elements) => elements.filter((element) => element.getAttribute('aria-selected') === 'true').length)).toBe(2);
      const ids = await items.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-asset-id')!));
      expect(new Set(ids).size).toBe(2);
      const resolved = await page.evaluate((assetIds) => Promise.all(assetIds.map((assetId) => window.desktopApi.getFileDetails(assetId))), ids);
      expect(resolved.map((detail) => detail.path).sort()).toEqual((await Promise.all(['FIRST.jpg', 'SECOND.jpg'].map((name) => realpath(path.join(source, name))))).sort());
      expect(await page.evaluate((assetIds) => window.desktopApi.copyDisplayedFiles({ items: assetIds.map((assetId) => ({ kind: 'asset' as const, assetId })) }), ids)).toBe(2);
      await expect.poll(() => pastedFileUrls().urls.sort()).toEqual(actualExpected.sort());
      await items.nth(1).press('Meta+c');
      await expect(page.locator('.operation-toast')).toContainText('已复制 2 个当前显示的文件');
      await expect.poll(() => pastedFileUrls().urls.sort()).toEqual(actualExpected.sort());
    };
    await copySelection('.catalog-card');
    await page.locator('.catalog-card').nth(1).press('Meta+v');
    await expect(page.locator('.catalog-card')).toHaveCount(4);
    await expect(page.locator('.global-navigation-notice')).toContainText('已粘贴 2 个媒体文件');
    const single = page.locator('.catalog-card[aria-selected="false"]').first();
    await single.click();
    await expect(page.locator('.catalog-card[aria-selected="true"]')).toHaveCount(1);
    await single.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '复制图片内容' }).click();
    await expect(page.locator('.operation-toast:not(.global-navigation-notice)')).toContainText('已复制图片');
    expect(await app.evaluate(({ clipboard }) => clipboard.readImage().isEmpty())).toBe(false);
    const video = path.join(root, 'clip.mov');
    await writeFile(video, 'video fixture');
    const sourceFolderId = await page.evaluate(async () => (await window.desktopApi.listCatalogFolders()).find((folder) => folder.name === 'source')!.id);
    expect(await page.evaluate(({ videoPath, folderId }) => window.desktopApi.importExternalMedia({ paths: [videoPath], targetFolderId: folderId }), { videoPath: video, folderId: sourceFolderId })).toBe(1);
    await expect.poll(async () => page.evaluate(async () => (await window.desktopApi.listCatalogFolders()).find((folder) => folder.name === 'source')?.assetCount)).toBe(3);
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
