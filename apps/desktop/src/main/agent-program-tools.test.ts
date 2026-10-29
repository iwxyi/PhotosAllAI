import { mkdtemp, mkdir, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog-service';
import { FileOperationService } from './file-operation-service';
import { createAgentProgramTools } from './agent-program-tools';
import type { AgentToolContext } from './agent-tools';

describe('Agent program tools', () => {
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
