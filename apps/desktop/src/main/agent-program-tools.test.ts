import { mkdtemp, mkdir, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog-service';
import { FileOperationService } from './file-operation-service';
import { TemplateService } from './template-service';
import { TaskService } from './task-service';
import { createAgentProgramTools } from './agent-program-tools';
import { agentSessionSchema } from '@photoallisai/contracts';
import type { AgentToolContext } from './agent-tools';

describe('Agent program tools', () => {
  it('imports and pages a folder larger than 500 photos with persisted progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-large-import-'));
    const catalog = new CatalogService(join(root, 'catalog.sqlite'));
    try {
      const source = join(root, 'photos');
      await mkdir(source, { recursive: true });
      await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(join(source, `${i}.jpg`), 'fixture')));
      const session = agentSessionSchema.parse({ id: crypto.randomUUID(), title: 'batch', assetIds: [], status: 'running', messages: [], calls: [], turns: 0, outputs: 0, createdAt: 1, updatedAt: 1, error: null });
      const save = vi.fn();
      const context = { session, save } as unknown as AgentToolContext;
      const tools = createAgentProgramTools({ catalog, watchFolders: vi.fn(), changed: vi.fn() } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const imported = (await tools.find((tool) => tool.name === 'folders.import')!.execute({ paths: [source] }, context)).result as { scope: { hasNext: boolean; total: number }; addedFolders: Array<{ id: string }> };
      expect(imported.scope).toMatchObject({ hasNext: true, total: 501 });
      expect(session.assetIds).toHaveLength(100);
      expect(session.folderScope?.nextIndex).toBe(100);
      expect(agentSessionSchema.parse(JSON.parse(JSON.stringify(session))).folderScope?.nextIndex).toBe(100);
      const folderId = imported.addedFolders[0]!.id;
      const select = tools.find((tool) => tool.name === 'scope.folder')!;
      const seen = new Set(session.assetIds);
      session.turns = 99; session.outputs = 100;
      for (let batch = 2; batch <= 5; batch++) {
        const page = (await select.execute({ folderId, next: true }, context)).result as { assetIds: string[]; hasNext: boolean; remaining: number };
        expect(page).toMatchObject({ hasNext: true, remaining: 501 - batch * 100 });
        expect(page.assetIds).toHaveLength(100);
        expect(page.assetIds.some((id) => seen.has(id))).toBe(false);
        page.assetIds.forEach((id) => seen.add(id));
        expect(session.turns).toBe(0);
        expect(session.outputs).toBe(0);
      }
      const next = (await select.execute({ folderId, next: true }, context)).result as { assetIds: string[]; hasNext: boolean; remaining: number };
      expect(next).toMatchObject({ hasNext: false, remaining: 0 });
      expect(next.assetIds).toHaveLength(1);
      expect(session.assetIds).toEqual(next.assetIds);
      expect((await select.execute({ folderId, next: true }, context)).result).toMatchObject({ assetIds: [], hasNext: false });
      expect(save).toHaveBeenCalledTimes(6);
    } finally {
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('imports a folder and scopes its photos for follow-up Agent actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-import-'));
    const catalog = new CatalogService(join(root, 'catalog.sqlite'));
    try {
      const source = join(root, 'photos');
      await mkdir(join(source, 'nested'), { recursive: true });
      await writeFile(join(source, 'one.jpg'), 'fixture');
      await writeFile(join(source, 'nested', 'two.jpg'), 'fixture');
      const watchFolders = vi.fn(); const changed = vi.fn(); const save = vi.fn();
      const session = { assetIds: [] as string[] };
      const context = { session, save } as unknown as AgentToolContext;
      const tools = createAgentProgramTools({ catalog, watchFolders, changed } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const importer = tools.find((tool) => tool.name === 'folders.import')!;
      expect(importer.approval).toBe(false);
      const imported = (await importer.execute({ paths: [source] }, context)).result as { scoped: number; addedFolders: Array<{ id: string }> };
      expect(imported.scoped).toBe(2);
      expect(imported.addedFolders).toHaveLength(1);
      expect(session.assetIds).toHaveLength(2);
      expect(save).toHaveBeenCalledOnce();
      expect(watchFolders).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();

      const folder = catalog.listFolders().find((item) => item.name === 'nested')!;
      session.assetIds = [];
      const select = tools.find((tool) => tool.name === 'scope.folder')!;
      expect((await select.execute({ folderId: folder.id }, context)).result).toMatchObject({ added: 1, assetIds: [expect.any(String)] });
      expect(session.assetIds).toHaveLength(1);
      await expect(select.execute({ folderId: 'missing' }, context)).rejects.toThrow('FOLDER_NOT_FOUND');
    } finally {
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('controls eligible tasks across the app without touching completed results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-tasks-'));
    const tasks = new TaskService(join(root, 'catalog.sqlite'));
    try {
      const input = { kind: 'analysis' as const, assetId: 'photo', payload: { providerProfileId: 'model', mode: 'full' } };
      const first = tasks.enqueue(input);
      const second = tasks.enqueue({ ...input, assetId: 'another' });
      const completed = tasks.enqueue({ ...input, assetId: 'finished' });
      tasks.claimNext(['analysis']);
      tasks.advance(first.id, 'processing', .1);
      tasks.advance(first.id, 'downloading', .8);
      tasks.advance(first.id, 'saving', .9);
      tasks.finish(first.id, 'completed', { saved: true });
      const cancelTask = vi.fn(); const wake = vi.fn();
      const tools = createAgentProgramTools({ tasks, cancelTask, wake } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const control = tools.find((tool) => tool.name === 'tasks.control-many')!;
      expect(control.approval).toBe(false);
      const context = { session: { calls: [] } } as unknown as AgentToolContext;
      const paused = (await control.execute({ action: 'pause', scope: 'all' }, context)).result;
      expect(paused).toMatchObject({ matched: 3, changed: 2, skipped: 1, failed: [] });
      expect(tasks.find(first.id)?.status).toBe('completed');
      expect(tasks.find(second.id)?.status).toBe('paused');
      expect(tasks.find(completed.id)?.status).toBe('paused');
      expect(cancelTask).toHaveBeenCalledTimes(2);
      const resumed = (await control.execute({ action: 'resume', scope: 'all' }, context)).result;
      expect(resumed).toMatchObject({ changed: 2, skipped: 1, failed: [] });
      expect(wake).toHaveBeenCalledTimes(2);
    } finally {
      tasks.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates, revises, lists, batch saves, and archives prompt templates through Agent tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-templates-'));
    const templates = new TemplateService(join(root, 'catalog.sqlite'));
    const changed = vi.fn();
    try {
      const tools = createAgentProgramTools({ templates, changed } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const context = {} as AgentToolContext;
      const create = tools.find((tool) => tool.name === 'templates.save')!;
      const list = tools.find((tool) => tool.name === 'templates.list')!;
      const batchSave = tools.find((tool) => tool.name === 'templates.save-batch')!;
      const archiveBatch = tools.find((tool) => tool.name === 'templates.archive-batch')!;
      const first = await create.execute({ name: '清理背景', description: '清除背景杂物', category: '其他', body: '保留主体与自然光影。' }, context);
      const created = first.result as { id: string; version: number };
      expect(created.version).toBe(1);
      expect(changed).toHaveBeenCalledOnce();

      await create.execute({ id: created.id, name: '清理背景', description: '清除背景杂物并自然融合', category: '其他', body: '保留主体、材质和自然光影。' }, context);
      expect((await list.execute({}, context)).result).toMatchObject([{ id: created.id, version: 2, body: '保留主体、材质和自然光影。' }]);

      const batch = await batchSave.execute({ templates: [{ name: '修复污渍', description: '清理污渍', category: '其他', body: '只移除污渍，保留纹理。' }] }, context);
      expect(batch.result).toMatchObject({ saved: 1, failed: [] });
      const all = (await list.execute({}, context)).result as Array<{ id: string }>;
      const extraId = all.find((item) => item.id !== created.id)!.id;
      const archived = await archiveBatch.execute({ ids: [created.id, extraId] }, context);
      expect(archived.result).toMatchObject({ count: 2, failed: [] });
      expect(await list.execute({}, context)).toMatchObject({ result: [] });
    } finally {
      templates.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('relocates every affected asset after renaming a folder larger than one page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-folder-'));
    const catalog = new CatalogService(join(root, 'catalog.sqlite'));
    try {
      const source = join(root, 'photos');
      await mkdir(join(source, 'large'), { recursive: true });
      await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(join(source, 'large', `${i}.jpg`), 'fixture')));
      await writeFile(join(source, 'unrelated.jpg'), 'fixture');
      await catalog.importFolders([source]);
      expect(catalog.listFolderPaths()[0]).toContain('photos');
      const folder = catalog.listFolders().find((f) => f.name === 'large')!;
      const previousDirectory = await realpath(join(source, 'large'));
      const relocate = vi.fn(async (_id: string, _previous: { path: string; fileName: string } | null) => undefined);
      const watchFolders = vi.fn();
      const changed = vi.fn();
      const tools = createAgentProgramTools({ catalog, relocate, watchFolders, changed } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const rename = tools.find((t) => t.name === 'folders.rename')!;
      expect(rename.approval).toBe(true);
      await rename.execute({ folderId: folder.id, name: 'renamed' }, {} as AgentToolContext);
      expect(relocate).toHaveBeenCalledTimes(501);
      expect(new Set(relocate.mock.calls.map((call) => call[0])).size).toBe(501);
      expect(relocate.mock.calls.every((call) => call[1]?.path.startsWith(previousDirectory))).toBe(true);
      expect((await stat(join(source, 'renamed', '500.jpg'))).isFile()).toBe(true);
      expect(catalog.listAssetPage({ workflow: false, limit: 500 }).totalCount).toBe(502);
      expect(watchFolders).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs bounded file transforms only inside associated folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-program-'));
    const catalog = new CatalogService(join(root, 'catalog.sqlite'));
    try {
      const source = join(root, 'photos');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'data.csv'), 'name,value\na,1\n');
      await catalog.importFolders([source]);
      expect(catalog.listFolderPaths()[0]).toContain('photos');
      const tools = createAgentProgramTools({ catalog, changed: vi.fn() } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const run = tools.find((t) => t.name === 'program.run')!;
      expect(run.approval).toBe(true);
      const output = join(source, 'out.csv');
      const result = await run.execute({ code: "write('" + output + "', files['" + join(source, 'data.csv') + "'].toUpperCase())", inputs: [{ path: join(source, 'data.csv') }] }, {} as AgentToolContext);
      expect(result.result).toEqual({ read: [join(source, 'data.csv')], written: [{ path: output, bytes: 15 }] });
      try {
        await run.execute({ code: "write('/tmp/outside.txt', 'x')" }, {} as AgentToolContext);
        throw new Error('expected outside path rejection');
      } catch (error) {
        expect(String(error)).toContain('已关联文件夹');
      }
    } finally {
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('previews and executes extension renames only in the requested folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-rename-pattern-'));
    const databasePath = join(root, 'catalog.sqlite');
    const catalog = new CatalogService(databasePath);
    const files = new FileOperationService(databasePath, undefined, null, process.platform, catalog);
    try {
      const source = join(root, 'photos');
      await mkdir(join(source, 'nested'), { recursive: true });
      await mkdir(join(root, 'other'), { recursive: true });
      await writeFile(join(source, 'one.jpg'), '1');
      await writeFile(join(source, 'nested', 'two.JPG'), '2');
      await writeFile(join(source, 'nested', 'three.png'), '3');
      await writeFile(join(root, 'other', 'outside.jpg'), '4');
      await catalog.importFolders([source, join(root, 'other')]);
      const relocate = vi.fn(async () => undefined);
      const tools = createAgentProgramTools({ catalog, files, relocate, changed: vi.fn() } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const folder = catalog.listFolders().find((item) => item.name === 'photos')!;
      const args = { scope: 'folder' as const, folderId: folder.id, fromExtension: '.jpg', toExtension: '.jpeg' };
      const preview = tools.find((tool) => tool.name === 'files.rename-pattern.preview')!;
      const execute = tools.find((tool) => tool.name === 'files.rename-pattern')!;
      const result = await preview.execute(args, {} as unknown as AgentToolContext);
      const previewResult = result.result as { count: number; fromExtension: string; toExtension: string; examples: Array<{ previousFileName: string }> };
      expect(previewResult).toMatchObject({ count: 2, fromExtension: '.jpg', toExtension: '.jpeg' });
      expect(previewResult.examples.map((item) => item.previousFileName).sort()).toEqual(['one.jpg', 'two.JPG'].sort());
      const output = await execute.execute(args, {} as unknown as AgentToolContext);
      expect((output.result as { matched: number }).matched).toBe(2);
      expect((await stat(join(source, 'one.jpeg'))).isFile()).toBe(true);
      expect((await stat(join(source, 'nested', 'two.jpeg'))).isFile()).toBe(true);
      expect((await stat(join(root, 'other', 'outside.jpg'))).isFile()).toBe(true);
      expect(relocate).toHaveBeenCalledTimes(2);
    } finally {
      files.close();
      catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('previews all associated roots and marks the execution as requiring approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-rename-all-'));
    const databasePath = join(root, 'catalog.sqlite');
    const catalog = new CatalogService(databasePath);
    const files = new FileOperationService(databasePath, undefined, null, process.platform, catalog);
    try {
      const first = join(root, 'first'); const second = join(root, 'second');
      await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true });
      await writeFile(join(first, 'a.jpg'), 'a'); await writeFile(join(second, 'b.jpg'), 'b');
      await catalog.importFolders([first, second]);
      const relocate = vi.fn(async () => undefined);
      const tools = createAgentProgramTools({ catalog, files, relocate, changed: vi.fn() } as unknown as Parameters<typeof createAgentProgramTools>[0]);
      const args = { scope: 'all-associated' as const, fromExtension: '.jpg', toExtension: '.jpeg' };
      const preview = tools.find((tool) => tool.name === 'files.rename-pattern.preview')!;
      const execute = tools.find((tool) => tool.name === 'files.rename-pattern')!;
      expect(((await preview.execute(args, {} as unknown as AgentToolContext)).result as { count: number }).count).toBe(2);
      expect(execute.approval).toBe(true);
      const output = await execute.execute(args, {} as unknown as AgentToolContext);
      expect((output.result as { matched: number }).matched).toBe(2);
      expect(relocate).toHaveBeenCalledTimes(2);
    } finally {
      files.close(); catalog.close(); await rm(root, { recursive: true, force: true });
    }
  });
});
