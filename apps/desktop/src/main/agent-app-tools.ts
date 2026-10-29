import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { exportTaskPayloadSchema, fileWorkflowConfigSchema, listCatalogAssetsInputSchema, renameCatalogAssetInputSchema, updateCatalogAlbumAssetsInputSchema, updateGenerationResultReviewInputSchema } from '@photoallisai/contracts';
import type { AgentTool, AgentToolContext } from './agent-tools';
import type { CatalogService } from './catalog-service';
import type { GenerationService } from './generation-service';
import type { FileOperationService } from './file-operation-service';
import type { FileWorkflowService } from './file-workflow-service';
import type { TaskService } from './task-service';

export function createAgentAppTools(d: {
  catalog: CatalogService; generation: GenerationService; files: FileOperationService;
  workflows: FileWorkflowService; tasks: TaskService; wake(): void; changed(): void;
}): AgentTool[] {
  const scope = (ids: string[], c: AgentToolContext) => {
    if (!ids.length || ids.some((id) => !c.session.assetIds.includes(id))) throw new Error('图片不属于会话授权范围。');
  };
  const resultsScope = (ids: string[], c: AgentToolContext) => {
    const allowed = new Set(c.session.assetIds.flatMap((id) => d.generation.list(id).map((r) => r.id)));
    if (ids.some((id) => !allowed.has(id))) throw new Error('版本不属于会话授权范围。');
  };
  const define = <T extends z.ZodType>(name: string, description: string, schema: T, approval: boolean, replayable: boolean,
    run: (a: z.output<T>, c: AgentToolContext) => unknown | Promise<unknown>): AgentTool => ({ name, description, schema, approval, replayable,
      execute: async (raw, c) => ({ result: await run(schema.parse(raw), c) }) });
  const exports: AgentTool = { name: 'export.results', description: '导出范围内 AI 版本到用户明确指定的绝对目录，支持尺寸、格式、品质和命名预设。先确认具体目录，不覆盖已有文件。',
    schema: exportTaskPayloadSchema, approval: true, replayable: true,
    execute: async (raw, c) => {
      const a = exportTaskPayloadSchema.parse(raw);
      if (!isAbsolute(a.destinationDirectory)) throw new Error('导出目录需要绝对路径。');
      if (!c.call.taskIds.length) { resultsScope(a.resultIds, c); c.call.taskIds = [randomUUID()]; c.save(); }
      const id = c.call.taskIds[0]!;
      if (!d.tasks.find(id)) d.tasks.enqueue({ kind: 'export', assetId: null, payload: { ...a, agentSessionId: c.session.id, submissionId: c.call.id } }, id);
      d.wake();
      const task = d.tasks.find(id)!;
      return ['completed', 'failed', 'canceled'].includes(task.status) ? { result: { status: task.status, report: task.result, error: task.errorCode } } : { waiting: true };
    } };
  return [
    define('catalog.search', '按文件名、评分、文件夹、标签等查询图库，返回分页。查询不扩大写入授权；修改查询所得的范围外照片先用 scope.request 请求扩展。', listCatalogAssetsInputSchema, false, true, (a) => d.catalog.listAssetPage(a)),
    define('albums.list', '列出图库相册。', z.object({}).strict(), false, true, () => d.catalog.listAlbums()),
    define('albums.create', '创建命名相册（不复制原文件）。', z.object({ name: z.string().trim().min(1).max(120) }).strict(), false, false, (a) => { const album = d.catalog.saveAlbum(a); d.changed(); return album; }),
    define('albums.update', '向相册添加或移除授权范围内的图片。', updateCatalogAlbumAssetsInputSchema, false, true, (a, c) => { scope(a.assetIds, c); const album = d.catalog.updateAlbumAssets(a); d.changed(); return album; }),
    define('generation.review', '设置生成版的接受/拒绝/首选状态。仅在实际检查后使用；preferred 只在用户明确要求替其确定首选时使用。拒绝仅为审阅状态，不删除文件。', updateGenerationResultReviewInputSchema, false, true, (a, c) => {
      resultsScope([a.resultId], c);
      if (!c.session.calls.slice(c.session.requestCallStart ?? 0).some((call) => call.name === 'vision.inspect' && call.status === 'done' && (call.arguments.resultIds as string[] | undefined)?.includes(a.resultId))) throw new Error('必须先实际检查当前生成版本，再设置审阅状态。');
      const result = d.generation.updateReview(a); d.changed(); return result;
    }),
    define('files.rename', '重命名指定照片，保留操作记录。需要确认具体新名称。', renameCatalogAssetInputSchema, true, false, async (a, c) => { scope([a.assetId], c); const result = await d.files.rename(a); d.changed(); return result; }),
    define('workflow.read', '读取全局/继承文件流程配置。流程与 AI 版本是分开的。', z.object({}).strict(), false, true, () => d.workflows.get()),
    define('workflow.configure', '保存流程配置，先读取当前 revision，修改需用户确认。', fileWorkflowConfigSchema, true, false, async (a) => { const result = await d.workflows.save(a); d.changed(); return result; }),
    exports
  ];
}
