import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { _electron as electron, expect, test } from '@playwright/test';

import { defaultWorkspaceSession, WorkspaceService } from '../../apps/desktop/src/main/workspace-service';

test('restores an old AI workflow session without blanking the window', async () => {
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'photoallisai-workflow-migration-'));
  const libraryDirectory = path.join(userDataDirectory, 'library');
  await mkdir(libraryDirectory);
  const workspace = new WorkspaceService(path.join(libraryDirectory, 'catalog.sqlite'));
  workspace.save({
    ...defaultWorkspaceSession,
    openTabs: ['library', 'viewer', 'workflow'],
    activeTab: 'workflow'
  });
  workspace.close();

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      args: [path.resolve('apps/desktop/out/main/index.js')],
      env: { ...process.env, PHOTOALLISAI_USER_DATA: userDataDirectory }
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('tab', { name: 'AI 批量修图' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('批次整体提示词')).toBeVisible();
    await expect(page.locator('.batch-workspace')).toBeVisible();
    await expect(page.getByRole('tab', { name: '看图', exact: true })).toHaveCount(0);
    await expect(page.locator('.app-shell')).toBeVisible();
  } finally {
    await app?.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
