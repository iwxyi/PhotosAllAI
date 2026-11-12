import { isAbsolute, relative, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { z } from 'zod';
import {
  appSettingsSchema, copyCatalogAssetsInputSchema, createCatalogFolderInputSchema,
  listTaskPageInputSchema, moveCatalogFolderInputSchema, moveQueuedTaskInputSchema, renameCatalogAssetsInputSchema,
  renameCatalogFolderInputSchema,
  saveCatalogAlbumInputSchema, saveExportPresetInputSchema, savePromptTemplateInputSchema,
  updateQueuedGenerationTaskInputSchema
} from '@photoallisai/contracts';
import type { AgentTool, AgentToolContext } from './agent-tools';
import type { CatalogService } from './catalog-service';
import type { FileOperationService } from './file-operation-service';
import type { GenerationService } from './generation-service';
import type { TaskService } from './task-service';
import type { TemplateService } from './template-service';
import type { ExportPresetService } from './export-preset-service';
import type { AppSettingsService } from './app-settings-service';
import { toRendererTask } from './task-sanitizer';

export function createAgentProgramTools(d: {
  catalog: CatalogService; files: FileOperationService; generation: GenerationService; tasks: TaskService;
  templates: TemplateService; exportPresets: ExportPresetService; settings: AppSettingsService;
  wake(): void; cancelTask(id: string): void; changed(): void; watchFolders(): void;
  relocate(assetId: string, previous: { path: string; fileName: string } | null): Promise<void>;
  settingsChanged(): Promise<void>; diagnostics(): Promise<unknown>;
}): AgentTool[] {
  const define = <T extends z.ZodType>(name: string, description: string, schema: T, approval: boolean, replayable: boolean,
    run: (a: z.output<T>, c: AgentToolContext) => unknown | Promise<unknown>): AgentTool => ({ name, description, schema, approval, replayable,
      execute: async (raw, c) => ({ result: await run(schema.parse(raw), c) }) });
  const ids = z.array(z.string().min(1)).min(1).max(500);
  const scope = (assetIds: string[], c: AgentToolContext) => {
    if (assetIds.some((id) => !c.session.assetIds.includes(id))) throw new Error('超出会话图片范围，请先 scope.request。');
  };
  const resultScope = (id: string, c: AgentToolContext, trash = false) => {
    if (!c.session.assetIds.some((assetId) => (trash ? d.generation.listTrashed(assetId) : d.generation.list(assetId)).some((r) => r.id === id))) throw new Error('版本超出会话范围');
  };
  const taskSchema = z.object({ taskId: z.string().uuid(), action: z.enum(['pause', 'resume', 'cancel', 'retry']) }).strict();
  const controlTask = (a: z.infer<typeof taskSchema>) => {
    const result = d.tasks[a.action](a.taskId);
    if (a.action === 'pause' || a.action === 'cancel') d.cancelTask(a.taskId); else d.wake();
    return toRendererTask(result);
  };
  const taskScope = (id: string, c: AgentToolContext) => {
    if (!c.session.calls.some((call) => call.taskIds.includes(id))) throw new Error('不是本会话作业，使用 tasks.control-global 并确认。');
  };
  const idSchema = z.object({ id: z.string().uuid() }).strict();
  const templateBatchSchema = z.object({ templates: z.array(savePromptTemplateInputSchema).min(1).max(50) }).strict();
  const templateIdsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
  const renamePatternSchema = z.object({
    scope: z.enum(['folder', 'all-associated']),
    folderId: z.string().min(1).optional(),
    fromExtension: z.string().regex(/^\.[a-z0-9]{1,8}$/iu),
    toExtension: z.string().regex(/^\.[a-z0-9]{1,8}$/iu)
  }).strict().superRefine((value, ctx) => {
    if (value.scope === 'folder' && !value.folderId) ctx.addIssue({ code: 'custom', path: ['folderId'], message: '指定文件夹范围需要 folderId' });
    if (value.fromExtension.toLowerCase() === value.toExtension.toLowerCase()) ctx.addIssue({ code: 'custom', path: ['toExtension'], message: '目标扩展名必须不同' });
  });
  const collectPatternItems = (raw: z.input<typeof renamePatternSchema>) => {
    const parsed = renamePatternSchema.parse(raw);
    const pattern = { ...parsed, fromExtension: parsed.fromExtension.toLowerCase(), toExtension: parsed.toExtension.toLowerCase() };
    const folderIds = pattern.scope === 'folder' ? [pattern.folderId!] : d.catalog.listFolders().filter((folder) => folder.isRoot).map((folder) => folder.id);
    const seen = new Set<string>();
    const items: Array<{ assetId: string; previousFileName: string; fileName: string }> = [];
    for (const folderId of folderIds) {
      let page = d.catalog.listAssetPage({ folderId, workflow: false, limit: 500 });
      for (;;) {
        for (const asset of page.items) {
          if (seen.has(asset.id) || !asset.fileName.toLowerCase().endsWith(pattern.fromExtension)) continue;
          seen.add(asset.id);
          items.push({ assetId: asset.id, previousFileName: asset.fileName, fileName: `${asset.fileName.slice(0, -pattern.fromExtension.length)}${pattern.toExtension}` });
        }
        if (!page.nextCursor) break;
        page = d.catalog.listAssetPage({ folderId, workflow: false, limit: 500, cursor: page.nextCursor });
      }
    }
    return { pattern, items };
  };
  const programSchema = z.object({
    code: z.string().min(1).max(40_000),
    inputs: z.array(z.object({ path: z.string().min(1), maxBytes: z.number().int().min(1).max(2_000_000).default(500_000) }).strict()).max(20).default([]),
    timeoutMs: z.number().int().min(50).max(10_000).default(2_000)
  }).strict();
  const safeProgramPath = (filePath: string) => {
    if (!isAbsolute(filePath)) throw new Error('程序化处理的文件路径必须是绝对路径');
    const canonical = (item: string) => process.platform === 'darwin' && item.startsWith('/var/') ? `/private${item}` : item;
    const roots = d.catalog.listFolderPaths().map((item) => canonical(resolve(item)));
    const target = canonical(resolve(filePath));
    if (!roots.some((root) => { const rel = relative(root, target); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); })) throw new Error('程序化处理只能访问已关联文件夹内的文件');
    return target;
  };
  return [
    define('files.rename-pattern.preview', '预览指定文件夹或全部已关联文件夹中的扩展名批量重命名。只读，不执行写入；先展示匹配数量、示例和目标范围。', renamePatternSchema, false, true, (a) => {
      const { pattern, items } = collectPatternItems(a);
      return { scope: pattern.scope, folderId: pattern.folderId ?? null, fromExtension: pattern.fromExtension, toExtension: pattern.toExtension, count: items.length, examples: items.slice(0, 30), truncated: items.length > 30 };
    }),
    define('files.rename-pattern', '执行已预览的扩展名批量重命名。scope=folder 只处理指定文件夹及其子文件夹；scope=all-associated 会处理所有已关联文件夹，属于全库高影响操作，必须确认。执行前应先调用 files.rename-pattern.preview。', renamePatternSchema, true, false, async (a) => {
      const { pattern, items } = collectPatternItems(a);
      if (!items.length) return { scope: pattern.scope, count: 0, message: '没有匹配文件' };
      if (items.length > 10_000) throw new Error('匹配文件超过 10000 个，请缩小范围');
      const before = new Map(items.map((item) => [item.assetId, d.catalog.resolveAssetFile(item.assetId)]));
      const result = await d.files.renameMany({ items: items.map((item) => ({ assetId: item.assetId, fileName: item.fileName })) });
      for (const item of items) await d.relocate(item.assetId, before.get(item.assetId) ?? null);
      d.changed();
      return { scope: pattern.scope, folderId: pattern.folderId ?? null, fromExtension: pattern.fromExtension, toExtension: pattern.toExtension, matched: items.length, result };
    }),
    define('program.run', '在受限 JavaScript 沙箱中处理明确列出的文本/CSV/TSV/JSON 文件。脚本只能读取 inputs，并通过返回 writes 计划写回已关联文件夹；不能访问网络、密钥、Shell 或未声明路径。写入需要确认，单次最多 20 个输入、2 MB/文件、10 秒。XLSX 等二进制格式需先确认当前环境是否有解析工具，不能伪造支持。', programSchema, true, false, async (a) => {
      const files: Record<string, string> = {};
      for (const input of a.inputs) {
        const path = safeProgramPath(input.path);
        const bytes = await readFile(path);
        if (bytes.byteLength > input.maxBytes) throw new Error(`输入文件过大：${input.path}`);
        files[input.path] = bytes.toString('utf8');
      }
      const writes: Record<string, string> = {};
      const context = vm.createContext({ files: Object.freeze(files), JSON, TextEncoder, TextDecoder,
        write: (path: string, content: unknown) => { if (typeof path !== 'string' || typeof content !== 'string') throw new Error('write(path, content) 需要字符串'); writes[path] = content; }
      }, { codeGeneration: { strings: false, wasm: false } });
      new vm.Script(`'use strict';\n${a.code}`, { filename: 'photoallisai-agent-program.js' }).runInContext(context, { timeout: a.timeoutMs, displayErrors: false });
      const entries = Object.entries(writes);
      if (entries.length > 20) throw new Error('单次最多写入 20 个文件');
      let total = 0;
      for (const [path, content] of entries) {
        const target = safeProgramPath(path);
        total += Buffer.byteLength(content, 'utf8');
        if (total > 10_000_000) throw new Error('单次写入总量不能超过 10 MB');
        await writeFile(target, content, { encoding: 'utf8' });
      }
      d.changed();
      return { read: Object.keys(files), written: entries.map(([path, content]) => ({ path, bytes: Buffer.byteLength(content, 'utf8') })) };
    }),
    define('scope.request', '申请新增图片到会话操作范围。先查询得到明确 ID，用户确认一次后可自动处理；不能静默扩大全库权限。', z.object({ assetIds: ids, reason: z.string().min(1).max(2000) }).strict(), true, true, (a, c) => {
      const all = [...new Set([...c.session.assetIds, ...a.assetIds])];
      if (all.length > 500) throw new Error('单会话最多 500 张');
      if (d.catalog.listAssetPage({ assetIds: all, workflow: false, limit: 500 }).items.length !== all.length) throw new Error('图片不存在');
      c.session.assetIds = all; c.save(); return { assetIds: all };
    }),
    define('catalog.stats', '图库图片总数和离线数量。', z.object({}).strict(), false, true, () => d.catalog.getStats()),
    define('tags.list', '读取图库标签。', z.object({}).strict(), false, true, () => d.catalog.listTags()),
    define('collections.list', '读取智能集合及其筛选规则。', z.object({}).strict(), false, true, () => d.catalog.listSmartCollections()),
    define('albums.save', '创建或重命名相册，不移动原文件。', saveCatalogAlbumInputSchema, false, false, (a) => { const r = d.catalog.saveAlbum(a); d.changed(); return r; }),
    define('albums.delete', '删除相册定义，照片保留。', idSchema, true, false, (a) => { d.catalog.deleteAlbum(a.id); d.changed(); return { deleted: a.id }; }),
    define('folders.import', '关联明确的绝对目录并导入其照片，不移动原文件。', z.object({ paths: z.array(z.string().min(1)).min(1).max(20) }).strict(), true, false, async (a) => {
      if (a.paths.some((p) => !isAbsolute(p))) throw new Error('需要绝对目录');
      const imported = await d.catalog.importFolders(a.paths); d.watchFolders(); d.changed(); return { imported, folders: d.catalog.listFolders() };
    }),
    define('folders.synchronize', '重新扫描已关联文件夹的新增和离线图片。', z.object({ folderId: z.string().min(1) }).strict(), false, true, async (a) => { const r = await d.catalog.synchronizeFolder(a.folderId); d.changed(); return r; }),
    define('folders.create', '在已关联父目录创建新文件夹，返回名称与 ID。', createCatalogFolderInputSchema, false, false, async (a) => { const r = await d.catalog.createFolder(a); d.watchFolders(); d.changed(); return r; }),
    define('folders.rename', '重命名已关联文件夹并同步目录内 AI 版本位置。', renameCatalogFolderInputSchema, true, false, async (a) => {
      const before = new Map<string, { path: string; fileName: string } | null>();
      let page = d.catalog.listAssetPage({ folderId: a.folderId, workflow: false, limit: 500 });
      for (;;) {
        for (const asset of page.items) before.set(asset.id, d.catalog.resolveAssetFile(asset.id));
        if (!page.nextCursor) break;
        page = d.catalog.listAssetPage({ folderId: a.folderId, workflow: false, limit: 500, cursor: page.nextCursor });
      }
      const r = await d.catalog.renameFolder(a);
      for (const [id, previous] of before) await d.relocate(id, previous);
      d.watchFolders(); d.changed(); return r;
    }),
    define('folders.move', '移动已关联文件夹并同步目录内 AI 版本位置。', moveCatalogFolderInputSchema, true, false, async (a) => {
      const r = await d.catalog.moveFolder(a);
      for (const item of r.relocations) await d.relocate(item.assetId, { path: item.previousPath, fileName: item.previousFileName });
      d.watchFolders(); d.changed(); return r;
    }),
    define('folders.unregister', '取消关联文件夹，保留磁盘文件。', z.object({ folderId: z.string().min(1) }).strict(), true, false, (a) => { const r = d.catalog.unregisterFolder(a.folderId); d.watchFolders(); d.changed(); return r; }),
    define('files.copy', '复制会话照片到已关联目录，保留操作记录。', copyCatalogAssetsInputSchema, false, false, async (a, c) => { scope(a.assetIds, c); const r = await d.files.copy(a); d.changed(); return r; }),
    define('files.rename-many', '批量重命名会话照片，先列出具体新名称供确认。', renameCatalogAssetsInputSchema, true, false, async (a, c) => { scope(a.items.map((item) => item.assetId), c); const r = await d.files.renameMany(a); d.changed(); return r; }),
    define('files.history', '读取文件操作及可撤销状态。', z.object({}).strict(), false, true, () => d.files.listHistory()),
    define('files.undo', '撤销指定文件操作，确认具体记录。', z.object({ operationId: z.string().uuid() }).strict(), true, false, async (a, c) => { scope(d.files.getUndoAssetIds(a.operationId), c); const r = await d.files.undo(a); d.changed(); return r; }),
    define('generation.trash-list', '读取会话照片已移入回收站的 AI 版本。', z.object({ assetIds: ids }).strict(), false, true, (a, c) => { scope(a.assetIds, c); return a.assetIds.map((id) => ({ assetId: id, results: d.generation.listTrashed(id) })); }),
    define('generation.trash', '将指定 AI 结果移入可恢复回收站。', idSchema, true, false, async (a, c) => { resultScope(a.id, c); const r = await d.generation.trash(a.id); d.changed(); return r; }),
    define('generation.restore', '恢复会话照片在回收站中的指定 AI 版本。', idSchema, false, false, async (a, c) => { resultScope(a.id, c, true); const r = await d.generation.restore(a.id); d.changed(); return r; }),
    define('tasks.search', '分页查询应用作业，保留真实状态；不自动授权控制其他会话作业。', listTaskPageInputSchema, false, true, (a) => { const r = d.tasks.listPage(a); return { ...r, items: r.items.map(toRendererTask) }; }),
    define('tasks.control', '暂停、恢复、取消或重试本会话的作业。', taskSchema, false, false, (a, c) => { taskScope(a.taskId, c); return controlTask(a); }),
    define('tasks.control-global', '控制其他来源作业，需用户确认避免打断其他工作。', taskSchema, true, false, controlTask),
    define('tasks.reorder', '调整本会话排队任务顺序。', moveQueuedTaskInputSchema, false, false, (a, c) => { taskScope(a.taskId, c); return toRendererTask(d.tasks.moveQueued(a)); }),
    define('tasks.update-generation', '修改本会话尚未执行的生成任务提示词。', updateQueuedGenerationTaskInputSchema, false, true, (a, c) => { taskScope(a.taskId, c); return toRendererTask(d.tasks.updateQueuedGeneration(a)); }),
    define('templates.list', '读取全部活动提示词模板及当前版本。创建、修改前先读取，依据已有模板判断新建还是创建下一版本。', z.object({}).strict(), false, true, () => d.templates.list()),
    define('templates.save', '创建提示词模板或保存指定模板的新版本；传 id 表示修改，历史版本会保留。根据用户的简短意图主动扩写为专业、具体、可执行的修图提示词，包含目标、操作边界、主体/身份保护、光影与质感保留、伪影检查和变量占位符；不要只把用户原话复制进 body。保存后再调用 templates.list 核实实际结果。', savePromptTemplateInputSchema, false, false, (a) => { const result = d.templates.save(a); d.changed(); return result; }),
    define('templates.save-batch', '批量创建模板或保存多个模板的新版本，最多 50 项；每项都应根据意图优化为完整、专业、可执行的修图提示词。已有模板传 id 创建新版本。先 templates.list 检查目标，再保存并读取核实；回执会分别列出成功与失败。', templateBatchSchema, false, false, (a) => { const templates: unknown[] = []; const failed: Array<{ name: string; error: string }> = []; for (const item of a.templates) { try { templates.push(d.templates.save(item)); } catch (error) { failed.push({ name: item.name, error: error instanceof Error ? error.message : String(error) }); } } if (templates.length) d.changed(); return { saved: templates.length, templates, failed }; }),
    define('templates.archive', '归档指定提示词模板，使其不再用于新任务，历史任务和版本保留。', idSchema, true, false, (a) => { d.templates.archive(a.id); d.changed(); return { archived: a.id }; }),
    define('templates.archive-batch', '批量归档指定提示词模板，最多 100 个；只接受 templates.list 返回的现有模板 ID；回执会分别列出成功与失败。', templateIdsSchema, true, false, (a) => { const archived: string[] = []; const failed: Array<{ id: string; error: string }> = []; for (const id of a.ids) { try { d.templates.archive(id); archived.push(id); } catch (error) { failed.push({ id, error: error instanceof Error ? error.message : String(error) }); } } if (archived.length) d.changed(); return { archived, count: archived.length, failed }; }),
    define('export.presets', '读取导出预设。', z.object({}).strict(), false, true, () => d.exportPresets.list()),
    define('export.preset-save', '保存导出预设，包含尺寸、格式和文件命名。', saveExportPresetInputSchema, false, false, (a) => d.exportPresets.save(a)),
    define('export.preset-delete', '删除指定导出预设，已导出文件不变。', idSchema, true, false, (a) => { d.exportPresets.delete(a.id); return { deleted: a.id }; }),
    define('settings.read', '读取程序通用设置，不含模型密钥。', z.object({}).strict(), false, true, () => d.settings.get()),
    define('settings.update', '更新指定通用设置，其余设置保留。影响全局，需确认。', appSettingsSchema.partial().strict(), true, true, async (a) => { const r = await d.settings.save(appSettingsSchema.parse({ ...await d.settings.get(), ...a })); await d.settingsChanged(); d.changed(); return r; }),
    define('app.diagnostics', '读取应用运行诊断和完整性状态，不包含密钥。', z.object({}).strict(), false, true, () => d.diagnostics())
  ];
}
