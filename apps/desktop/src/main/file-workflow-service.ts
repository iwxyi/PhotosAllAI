import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileWorkflowConfigSchema, listCatalogAssetsInputSchema, type CatalogAsset, type CatalogAssetPage, type CatalogFolder, type FileWorkflowBinding, type FileWorkflowConfig, type FileWorkflowPreset, type FileWorkflowScope, type ListCatalogAssetsInput } from '@photoallisai/contracts';
import type { CatalogService } from './catalog-service';
import { matchWorkflowFilesIsolated, type WorkflowMatchFile } from './file-workflow-matcher';
import { quarantineInvalidRegularFile, replaceRegularFileSafely } from './safe-file-write';

export function resolveFileWorkflow(config: FileWorkflowConfig, folders: CatalogFolder[], folderId: string | null, albumId: string | null): { preset: FileWorkflowPreset | null; owner: string | null } {
  const presetFor = (binding: FileWorkflowBinding): FileWorkflowPreset | null => binding.mode === 'off' ? null : binding.mode === 'custom' ? binding.preset : config.presets.find((preset) => preset.id === binding.presetId) ?? null;
  if (albumId && config.albums[albumId]) return { preset: presetFor(config.albums[albumId]!), owner: null };
  let current = folderId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const binding = config.folders[current];
    if (binding) return { preset: presetFor(binding), owner: current };
    current = folders.find((folder) => folder.id === current)?.parentId ?? null;
  }
  return { preset: config.presets.find((preset) => preset.id === config.defaultPresetId) ?? null, owner: null };
}

export class FileWorkflowService {
  readonly #path: string;
  readonly #catalog: CatalogService;
  #saving: Promise<unknown> = Promise.resolve();
  constructor(settingsPath: string, catalog: CatalogService) { this.#path = settingsPath; this.#catalog = catalog; }

  async get(): Promise<FileWorkflowConfig> {
    try {
      return fileWorkflowConfigSchema.parse(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fileWorkflowConfigSchema.parse({});
      if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
        await quarantineInvalidRegularFile(this.#path);
        return fileWorkflowConfigSchema.parse({});
      }
      throw error;
    }
  }

  save(input: FileWorkflowConfig): Promise<FileWorkflowConfig> {
    const operation = this.#saving.then(async () => {
      const config = fileWorkflowConfigSchema.parse(input);
      const previous = await this.get();
      if (config.revision !== previous.revision) throw new Error('流程配置已在其他位置更新，请重新打开后修改。');
      config.revision += 1;
      await mkdir(path.dirname(this.#path), { recursive: true });
      await replaceRegularFileSafely(this.#path, Buffer.from(JSON.stringify(config, null, 2)));
      return config;
    });
    this.#saving = operation.catch(() => undefined);
    return operation;
  }

  #all(input: ListCatalogAssetsInput): CatalogAsset[] {
    const result: CatalogAsset[] = [];
    let cursor = null;
    do {
      const page: CatalogAssetPage = this.#catalog.listAssetPage({ ...input, cursor, limit: 500, workflow: false });
      result.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }

  async page(rawInput: ListCatalogAssetsInput, override?: FileWorkflowConfig): Promise<CatalogAssetPage> {
    const input = listCatalogAssetsInputSchema.parse(rawInput);
    const config = override ?? await this.get();
    if (input.assetIds || !input.workflow || (!config.defaultPresetId && !Object.keys(config.folders).length && !Object.keys(config.albums).length)) return this.#catalog.listAssetPage(input);
    const folders = this.#catalog.listFolders();
    const scope: FileWorkflowScope = { folderId: input.folderId, albumId: input.albumId };
    const assets = this.#all(scope);
    const locations = this.#catalog.workflowFileLocations();
    const matches: WorkflowMatchFile[] = [];
    for (const asset of assets) {
      const location = locations.get(asset.id);
      if (!location) continue;
      // Find the nearest physical directory even when browsing all folders or an album.
      const directory = location.ancestors.find((ancestor) => ancestor.relativePath === location.relativePath.slice(0, location.relativePath.lastIndexOf('/')));
      const effective = resolveFileWorkflow(config, folders, directory?.id ?? asset.folderId, input.albumId);
      if (!effective.preset) continue;
      const prefix = location.ancestors.find((ancestor) => ancestor.id === effective.owner)?.relativePath;
      const relativePath = prefix ? location.relativePath.slice(prefix.length + 1) : location.relativePath;
      matches.push({ id: asset.id, relativePath, fileName: asset.fileName, namespace: `${location.rootId}:${effective.owner ?? 'root'}`, preset: effective.preset });
    }
    if (matches.length === 0) return { ...this.#catalog.listAssetPage(input), workflowStatus: { enabled: false, matched: 0, unmatched: assets.length, conflicts: 0 } };
    const results = await matchWorkflowFilesIsolated(matches);
    const fileById = new Map(matches.map((file) => [file.id, file]));
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const resultById = new Map(results.map((result) => [result.id, result]));
    const grouped = new Map<string, typeof results>();
    for (const result of results) {
      if (!result.group) continue;
      const group = grouped.get(result.group) ?? [];
      group.push(result);
      grouped.set(result.group, group);
    }
    const filtered = this.#all({ ...input, cursor: null });
    const projected: CatalogAsset[] = [];
    const emitted = new Set<string>();
    for (const asset of filtered) {
      const match = resultById.get(asset.id);
      if (!match?.group) { projected.push({ ...asset, ...(match?.conflict ? { workflowConflict: true } : {}) }); continue; }
      if (emitted.has(match.group)) continue;
      emitted.add(match.group);
      const group = grouped.get(match.group)!;
      group.sort((left, right) => left.stageIndex - right.stageIndex || left.variant.localeCompare(right.variant, undefined, { numeric: true }) || byId.get(left.id)!.fileName.localeCompare(byId.get(right.id)!.fileName) || left.id.localeCompare(right.id));
      const lastStage = group.reduce((latest, member) => byId.get(member.id)!.offline ? latest : Math.max(latest, member.stageIndex), -1);
      const representative = group.find((member) => member.stageIndex === lastStage && !byId.get(member.id)!.offline) ?? group[0]!;
      projected.push({ ...byId.get(representative.id)!, workflow: {
        id: createHash('sha256').update(match.group).digest('hex'), key: match.key,
        name: fileById.get(match.id)!.preset.name,
        members: group.map((member) => ({ stageId: member.stageId, stageName: member.stageName, variant: member.variant, asset: byId.get(member.id)! }))
      } });
    }
    // Representatives may differ from the filtered file; group membership determines inclusion.
    const cursorIndex = input.cursor ? projected.findIndex((asset) => asset.id === input.cursor!.id) : -1;
    const start = cursorIndex + 1;
    const items = projected.slice(start, start + input.limit);
    const last = items.at(-1);
    return { items, totalCount: projected.length, nextCursor: start + items.length < projected.length && last ? { id: last.id, modifiedAt: last.modifiedAt } : null,
      workflowStatus: { enabled: true, matched: results.filter((result) => result.group).length, unmatched: assets.length - results.filter((result) => result.group).length, conflicts: results.filter((result) => result.conflict).length } };
  }
}
