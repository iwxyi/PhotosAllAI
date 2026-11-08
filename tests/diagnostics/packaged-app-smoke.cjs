const { copyFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

async function verifyPreview(page, filePath, format) {
  const previews = await page.evaluate(async (inputPath) => {
    const session = await window.desktopApi.openImages([inputPath]);
    const assetId = session?.items[0]?.id;
    if (!assetId) throw new Error(`Packaged application could not open ${inputPath}`);
    const results = [];
    for (const kind of ['temporary-thumbnail', 'temporary']) {
      const image = new Image();
      image.src = `photoasset://${kind}/${assetId}`;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${kind} timed out`)), 15_000);
        image.onload = () => { clearTimeout(timer); resolve(); };
        image.onerror = () => { clearTimeout(timer); reject(new Error(`${kind} failed to load`)); };
      });
      results.push({ kind, width: image.naturalWidth, height: image.naturalHeight });
    }
    return results;
  }, filePath);
  if (previews.some((preview) => preview.width <= 0 || preview.height <= 0)) throw new Error(`Packaged ${format} preview is empty`);
  return previews;
}

async function main() {
  const executablePath = process.argv[2];
  if (!executablePath) throw new Error('Usage: node packaged-app-smoke.cjs <executable>');
  const userData = await mkdtemp(path.join(tmpdir(), 'photoallisai-package-smoke-'));
  let application;
  try {
    application = await electron.launch({
      executablePath: path.resolve(executablePath),
      env: { ...process.env, ELECTRON_RENDERER_URL: '', PHOTOALLISAI_USER_DATA: userData },
      timeout: 60_000
    });
    const page = await application.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('tab', { name: '图库', exact: true }).waitFor({ timeout: 30_000 });
    const diagnostic = await page.evaluate(() => globalThis.window.desktopApi.getDiagnosticSnapshot());
    if (!diagnostic?.cache || !diagnostic?.catalogWatcher) throw new Error('Packaged application diagnostics are unavailable');
    const tiffPath = path.join(userData, 'package-smoke.tiff');
    const encodedBytes = await application.evaluate(async ({ app }, outputPath) => {
      const module = process.getBuiltinModule('node:module');
      const path = process.getBuiltinModule('node:path');
      const sharp = module.createRequire(path.join(app.getAppPath(), 'package.json'))('sharp');
      const input = sharp({ create: { width: 32, height: 24, channels: 3, background: '#ff0000' } });
      const bytes = (await input.clone().png().toBuffer()).length;
      await input.tiff().toFile(outputPath);
      return bytes;
    }, tiffPath);
    if (encodedBytes <= 0) throw new Error('Packaged sharp failed to encode a PNG');
    const previews = { tiff: await verifyPreview(page, tiffPath, 'TIFF') };
    const heicPath = path.join(userData, 'package-smoke.heic');
    await copyFile(path.join(__dirname, '..', 'fixtures', 'release-smoke.heic'), heicPath);
    previews.heic = await verifyPreview(page, heicPath, 'HEIC');
    console.log(JSON.stringify({ title: await page.title(), platform: process.platform, cacheFiles: diagnostic.cache.files, encodedBytes, previews }));
  } finally {
    if (application) await application.close();
    await rm(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
