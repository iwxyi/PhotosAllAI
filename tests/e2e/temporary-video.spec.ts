import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect, test } from '@playwright/test';

const execFile = promisify(execFileCallback);

test('opens and plays a temporary MP4 without importing it into the image catalog', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-temporary-video-'));
  const source = path.join(directory, 'clip.mp4');
  await execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { timeout: 15_000 });
  const app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js'), source], env: { ...process.env, PHOTOALLISAI_USER_DATA: path.join(directory, 'user-data') } });
  try {
    const page = await app.firstWindow();
    const viewer = page.getByRole('region', { name: '临时看图', exact: true });
    await expect(viewer).toBeVisible();
    const video = viewer.locator('video.temporary-video-player');
    await expect(video).toBeVisible();
    const protocol = await page.evaluate(async (id) => { const response = await fetch(`photovideo://temporary/${id}`, { headers: { Range: 'bytes=0-1023' } }); return { status: response.status, type: response.headers.get('content-type'), length: (await response.arrayBuffer()).byteLength }; }, await video.evaluate((element) => element.getAttribute('src')!.split('/').at(-1)!));
    expect(protocol).toEqual({ status: 200, type: 'video/mp4', length: 1_024 });
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(async (element) => { await (element as HTMLVideoElement).play(); });
    await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.desktopApi.listCatalogFolders())).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
