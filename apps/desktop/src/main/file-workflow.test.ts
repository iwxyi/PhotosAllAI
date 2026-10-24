import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FILE_WORKFLOW, fileWorkflowConfigSchema, type FileWorkflowConfig } from '@photoallisai/contracts';
import { CatalogService } from './catalog-service';
import { FileWorkflowService, resolveFileWorkflow } from './file-workflow-service';
import { matchWorkflowFilesIsolated, type WorkflowMatchFile } from './file-workflow-matcher';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const config = (): FileWorkflowConfig => fileWorkflowConfigSchema.parse({ defaultPresetId: DEFAULT_FILE_WORKFLOW.id, presets: [DEFAULT_FILE_WORKFLOW] });
const file = (relativePath: string, namespace = 'root'): WorkflowMatchFile => ({ id: relativePath, relativePath, fileName: path.basename(relativePath), namespace, preset: DEFAULT_FILE_WORKFLOW });

describe('folder workflow matching', () => {
  it('associates stages and candidates, keeping roots and projects separate', async () => {
    const files = [file('原图/DSC1.CR3'), file('后期/DSC1-曝光.tiff'), file('美颜/DSC1-美颜.jpg'), file('AI/DSC1-AI-2.png'), file('原图/DSC1.CR3', 'other'), file('other.jpg')];
    const result = await matchWorkflowFilesIsolated(files);
    expect(new Set(result.slice(0, 4).map((item) => item.group)).size).toBe(1);
    expect(result[3]?.variant).toBe('2');
    expect(result[4]?.group).not.toBe(result[0]?.group);
    expect(result[5]?.group).toBeNull();
    const preset = { ...DEFAULT_FILE_WORKFLOW, steps: [{ ...DEFAULT_FILE_WORKFLOW.steps[0]!, pattern: '^(?<project>[^/]+)/(?<key>[^.]+)\\.jpg$' }] };
    const projects = await matchWorkflowFilesIsolated(['A/same.jpg', 'B/same.jpg'].map((name) => ({ ...file(name), preset })));
    expect(projects[0]?.group).not.toBe(projects[1]?.group);
  });

  it('keeps ambiguous files independent and aborts pathological regular expressions', async () => {
    const first = DEFAULT_FILE_WORKFLOW.steps[0]!;
    const conflict = await matchWorkflowFilesIsolated([{ ...file('原图/one.jpg'), preset: { ...DEFAULT_FILE_WORKFLOW, steps: [first, { ...first, id: 'duplicate' }] } }]);
    expect(conflict[0]).toMatchObject({ group: null, conflict: true });
    await expect(matchWorkflowFilesIsolated([{ ...file('a'.repeat(40) + '!'), preset: { ...DEFAULT_FILE_WORKFLOW, steps: [{ ...first, pattern: '^(?<key>a+)+$' }] } }], 100)).rejects.toThrow('超时');
    expect(fileWorkflowConfigSchema.safeParse({ presets: [{ ...DEFAULT_FILE_WORKFLOW, steps: [{ ...first, pattern: '(' }] }] }).success).toBe(false);
  });

  it('groups the complete scope before pagination and keeps full membership under filters', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photo-workflow-')); roots.push(root);
    const source = path.join(root, 'photos');
    await Promise.all(['原图', '调色'].map((directory) => mkdir(path.join(source, directory), { recursive: true })));
    await Promise.all(Array.from({ length: 260 }, (_, index) => ['原图', '调色'].map((directory) => writeFile(path.join(source, directory, `${String(index).padStart(3, '0')}${directory === '调色' ? '-调色' : ''}.jpg`), 'fixture'))).flat());
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      await catalog.importFolders([source]);
      const service = new FileWorkflowService(path.join(root, 'config.json'), catalog);
      const saved = await service.save(config());
      expect(saved.revision).toBe(1);
      await expect(service.save(config())).rejects.toThrow('其他位置更新');
      const first = await service.page({ limit: 200, sortBy: 'fileName' });
      expect(first.totalCount).toBe(260);
      expect(first.items).toHaveLength(200);
      expect(first.items.every((asset) => asset.workflow?.members.length === 2)).toBe(true);
      const second = await service.page({ limit: 200, sortBy: 'fileName', cursor: first.nextCursor });
      expect(second.items).toHaveLength(60);
      expect(new Set([...first.items, ...second.items].map((asset) => asset.workflow!.id)).size).toBe(260);
      const filtered = await service.page({ query: '001-调色', limit: 20 });
      expect(filtered.items[0]?.workflow?.members).toHaveLength(2);
      const original = filtered.items[0]!.workflow!.members[0]!.asset;
      expect((await service.page({ assetIds: [original.id] })).items[0]?.workflow).toBeUndefined();
      expect((await new FileWorkflowService(path.join(root, 'config.json'), catalog).get()).defaultPresetId).toBe(DEFAULT_FILE_WORKFLOW.id);
      await mkdir(path.join(source, 'AI'));
      await writeFile(path.join(source, 'AI', '001-AI-1.png'), 'new');
      await catalog.reconcileImportedFolders();
      const changed = await service.page({ query: '001', limit: 20 });
      expect(changed.items[0]?.workflow?.members).toHaveLength(3);
      expect(changed.items[0]?.fileName).toBe('001-AI-1.png');
      const folders = catalog.listFolders();
      const parent = folders.find((folder) => folder.isRoot)!;
      const child = folders.find((folder) => folder.name === '原图')!;
      const local = { ...saved, folders: { [parent.id]: { mode: 'off' as const } } };
      expect(resolveFileWorkflow(local, folders, child.id, null).preset).toBeNull();
      local.folders = { ...local.folders, [child.id]: { mode: 'off' } };
      const album = catalog.saveAlbum({ name: 'test' });
      const withAlbum = { ...local, albums: { [album.id]: { mode: 'preset' as const, presetId: DEFAULT_FILE_WORKFLOW.id } } };
      expect(resolveFileWorkflow(withAlbum, folders, child.id, album.id).preset?.id).toBe(DEFAULT_FILE_WORKFLOW.id);
      expect((await service.page({}, local)).totalCount).toBe(521);
    } finally { catalog.close(); }
  });

  it('isolates imported roots and applies album and nearest-folder overrides independently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'photo-workflow-scopes-')); roots.push(root);
    const catalog = new CatalogService(path.join(root, 'catalog.sqlite'));
    try {
      for (const project of ['A', 'B']) {
        for (const stage of ['原图', '调色']) {
          await mkdir(path.join(root, project, stage), { recursive: true });
          await writeFile(path.join(root, project, stage, 'same.jpg'), 'fixture');
        }
      }
      await catalog.importFolders([path.join(root, 'A'), path.join(root, 'B')]);
      const service = new FileWorkflowService(path.join(root, 'config.json'), catalog);
      const global = config();
      const roots = catalog.listFolders().filter((folder) => folder.isRoot);
      const firstRoot = roots.find((folder) => folder.name === 'A')!;
      expect((await service.page({}, global)).items.map((asset) => asset.workflow?.members.length)).toEqual([2, 2]);
      const local = { ...global, folders: { [firstRoot.id]: { mode: 'off' as const } } };
      expect((await service.page({}, local)).totalCount).toBe(3);
      const colorFolder = catalog.listFolders().find((folder) => folder.name === '调色' && folder.rootId === firstRoot.id)!;
      const custom = { ...DEFAULT_FILE_WORKFLOW, id: 'local', name: 'Local', steps: [{ ...DEFAULT_FILE_WORKFLOW.steps[0]!, field: 'fileName' as const, pattern: '^(?<key>[^.]+)\\.jpg$' }] };
      const overridden = { ...local, folders: { ...local.folders, [colorFolder.id]: { mode: 'custom' as const, preset: custom } } };
      expect((await service.page({ folderId: colorFolder.id }, overridden)).items[0]?.workflow?.name).toBe('Local');
      const album = catalog.saveAlbum({ name: 'both' });
      catalog.updateAlbumAssets({ albumId: album.id, assetIds: catalog.listAssets().map((asset) => asset.id), mode: 'add' });
      const albumConfig = { ...local, albums: { [album.id]: { mode: 'preset' as const, presetId: DEFAULT_FILE_WORKFLOW.id } } };
      expect((await service.page({ albumId: album.id }, albumConfig)).totalCount).toBe(2);
      expect((await service.page({ folderId: firstRoot.id }, albumConfig)).totalCount).toBe(2);
    } finally { catalog.close(); }
  });
});
