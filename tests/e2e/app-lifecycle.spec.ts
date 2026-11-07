import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const entry = path.resolve('apps/desktop/out/main/index.js');
let directory: string;
let application: ElectronApplication | undefined;

test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-lifecycle-'));
});
test.afterEach(async () => {
  if (application && application.process().exitCode === null) await application.close();
  application = undefined;
  await rm(directory, { recursive: true, force: true });
});
async function launch(extra: Record<string, string> = {}) {
  application = await electron.launch({ args: [entry], env: { ...process.env, ELECTRON_RENDERER_URL: '', PHOTOALLISAI_USER_DATA: directory, ...extra } });
  await (await application.firstWindow()).waitForLoadState('domcontentloaded');
  return application;
}

test('Dock activation restores hidden windows and recreates closed Mac windows', async () => {
  test.skip(process.platform !== 'darwin');
  const app = await launch();
  await app.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.hide();
    app.emit('activate');
  });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app.windows().length).toBe(0);
  const reopened = app.waitForEvent('window');
  await app.evaluate(({ app }) => app.emit('activate'));
  const page = await reopened;
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('tab', { name: '图库', exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
});

test('closing a loading window does not show its destroyed instance', async () => {
  test.skip(process.platform !== 'darwin');
  const app = await launch();
  const reopened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.once('closed', () => {
      setImmediate(() => {
        if (!window.isDestroyed()) throw new Error('Expected the closed window to be destroyed');
        for (const eventName of ['show', 'hide', 'minimize', 'maximize', 'restore']) window.emit(eventName);
        app.emit('activate');
      });
    });
    setImmediate(() => {
      void window.loadURL('data:text/html,<title>Closing window</title>').catch(() => {});
      window.close();
    });
  });
  const page = await reopened;
  await expect(page.getByRole('tab', { name: '图库', exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test('second launch restores the first window and exits without taking its lock', async () => {
  const app = await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  const child = spawn(app.process().spawnfile, [entry], {
    env: { ...process.env, PHOTOALLISAI_USER_DATA: directory }, stdio: 'ignore'
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  expect(exitCode).toBe(0);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
  expect(app.windows()).toHaveLength(1);
});

test('quit releases the process and lock so the same library can immediately reopen', async () => {
  const app = await launch();
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  const reopened = await launch();
  await expect((await reopened.firstWindow()).getByRole('tab', { name: '图库', exact: true })).toBeVisible();
});

test('closing the development window exits instead of leaving an orphan process', async () => {
  const server = createServer((_request, response) => { response.end('<!doctype html><title>Development lifecycle</title>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No dev server address');
    const app = await launch({ ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}` });
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0]!.close(), 0); });
    await closed;
    const reopened = await launch();
    await expect((await reopened.firstWindow()).getByRole('tab', { name: '图库', exact: true })).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
