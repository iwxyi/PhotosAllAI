import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { updateCatalogMetadataInputSchema, updateCatalogTagsInputSchema, type AgentCall, type AgentSession } from '@photoallisai/contracts';
import type { CatalogService } from './catalog-service';
import type { ProviderService } from './provider-service';
import type { AnalysisService } from './analysis-service';
import type { GenerationService } from './generation-service';
import type { FileOperationService } from './file-operation-service';
import type { TaskService } from './task-service';

export type AgentToolContext = { session: AgentSession; call: AgentCall; signal: AbortSignal; save(): void };
export type AgentTool = {
  name: string; description: string; schema: z.ZodType; approval: boolean; replayable: boolean;
  execute(args: unknown, context: AgentToolContext): Promise<{ waiting?: boolean; result?: unknown }>;
};
export type AgentToolDependencies = {
  catalog: Pick<CatalogService, 'listAssetPage' | 'listFolders' | 'updateMetadata' | 'updateTags'>;
  providers: Pick<ProviderService, 'list'>;
  analysis: Pick<AnalysisService, 'list'>;
  generation: Pick<GenerationService, 'list'>;
  files: Pick<FileOperationService, 'move' | 'removeFromCatalog'>;
  tasks: Pick<TaskService, 'enqueue' | 'find'>;
  wake(): void;
  changed(): void;
  inspect(input: { assetIds: string[]; resultIds: string[]; goal: string }, signal: AbortSignal): Promise<unknown>;
};

const ids = z.array(z.string().min(1)).min(1).max(500).refine((v) => new Set(v).size === v.length, 'Duplicate asset IDs');
const scoped = z.object({ assetIds: ids }).strict();

export function createAgentTools(d: AgentToolDependencies): AgentTool[] {
  const define = <T extends z.ZodType>(name: string, description: string, schema: T, approval: boolean, replayable: boolean,
    run: (args: z.output<T>, ctx: AgentToolContext) => unknown | Promise<unknown>): AgentTool => ({
      name, description, schema, approval, replayable,
      execute: async (raw, ctx) => ({ result: await run(schema.parse(raw), ctx) })
    });
  const scope = (assetIds: string[], ctx: AgentToolContext) => {
    if (assetIds.some((id) => !ctx.session.assetIds.includes(id))) throw new Error('图片超出会话范围，请用 scope.request 申请扩展，或使用新的选择开启会话。');
    const assets = d.catalog.listAssetPage({ assetIds, workflow: false, limit: 500 }).items;
    if (assets.length !== assetIds.length) throw new Error('部分图片已移出图库，请重新选择。');
    return assets;
  };
  const jobSchema = z.object({ assetIds: ids.max(100), providerProfileId: z.string().uuid(),
    kind: z.enum(['analysis', 'collection-analysis', 'generation']),
    prompt: z.string().max(20000).default(''), count: z.number().int().min(1).max(8).default(1),
    sourceResultId: z.string().uuid().optional()
  }).strict().superRefine((v, ctx) => {
    if (v.kind === 'generation' && !v.prompt.trim()) ctx.addIssue({ code: 'custom', message: '生成需要明确提示词' });
    if (v.kind !== 'generation' && v.count !== 1) ctx.addIssue({ code: 'custom', message: '分析数量必须为 1' });
    if (v.kind === 'collection-analysis' && v.assetIds.length < 2) ctx.addIssue({ code: 'custom', message: '集合分析至少需要两张图片的分析结果' });
    if (v.kind === 'generation' && v.assetIds.length * v.count > 100) ctx.addIssue({ code: 'custom', message: '一次最多生成 100 张' });
    if (v.sourceResultId && (v.kind !== 'generation' || v.assetIds.length !== 1)) ctx.addIssue({ code: 'custom', message: '迭代源版本必须对应单张图片生成' });
  });
  const jobs: AgentTool = {
    name: 'jobs.submit', description: '提交图片分析、集合分析或 AI 生成并等待真实结果。只有视觉目标才使用分析与 vision.inspect；生成前应有针对当前目标的检查和方案。用 providers.list 选择可用模型。count 是每图数量；不同图片使用分别优化的 prompt；sourceResultId 可基于已有生成版迭代。',
    schema: jobSchema, approval: false, replayable: true,
    execute: async (raw, ctx) => {
      const args = jobSchema.parse(raw);
      if (!ctx.call.taskIds.length) scope(args.assetIds, ctx);
      if (args.kind === 'generation') {
        const currentCalls = ctx.session.calls.slice(ctx.session.requestCallStart ?? 0);
        if (!currentCalls.some((c) => c.name === 'runtime.plan' && c.status === 'done')) throw new Error('生成前请先记录当前要求的行动方案。');
        if (args.assetIds.some((id) => !currentCalls.some((c) => c.name === 'vision.inspect' && c.status === 'done' && (c.arguments.assetIds as string[]).includes(id)))) throw new Error('生成前必须按当前要求实际检查每张图片，再决定如何生成。');
        if (args.sourceResultId && !d.generation.list(args.assetIds[0]!).some((r) => r.id === args.sourceResultId)) throw new Error('迭代源不属于当前图片');
        if (args.sourceResultId && !currentCalls.some((c) => c.name === 'vision.inspect' && c.status === 'done' && (c.arguments.resultIds as string[] | undefined)?.includes(args.sourceResultId!))) throw new Error('必须先检查迭代源版本，再根据实际问题继续修图。');
      }
      if (!ctx.call.taskIds.length) {
        const profile = (await d.providers.list()).find((p) => p.id === args.providerProfileId && p.enabled);
        if (!profile || profile.purpose !== (args.kind === 'generation' ? 'generation' : 'vision')) throw new Error('模型不可用或类型不匹配');
      }
      const total = args.kind === 'collection-analysis' ? 1 : args.assetIds.length * args.count;
      if (!ctx.call.taskIds.length) {
        if (args.kind === 'generation') {
          if (ctx.session.outputs + total > 100) throw new Error('生成预算已达到 100 张，请在新的请求中继续。');
          ctx.session.outputs += total;
        }
        ctx.call.taskIds = Array.from({ length: total }, () => randomUUID());
        ctx.save();
      }
      for (const [index, id] of ctx.call.taskIds.entries()) {
        if (d.tasks.find(id)) continue;
        const assetId = args.assetIds[Math.floor(index / args.count)]!;
        d.tasks.enqueue({ kind: args.kind, assetId: args.kind === 'collection-analysis' ? null : assetId,
          payload: args.kind === 'generation' ? {
            providerProfileId: args.providerProfileId, batchId: ctx.call.id, submissionId: ctx.call.id,
            prompt: args.prompt, resultIndex: index % args.count + 1, storageMode: 'managed', agentSessionId: ctx.session.id,
            ...(args.sourceResultId ? { sourceResultId: args.sourceResultId } : {})
          } : { providerProfileId: args.providerProfileId, mode: 'full', batchId: ctx.call.id,
            submissionId: ctx.call.id, assetIds: args.assetIds, agentSessionId: ctx.session.id }
        }, id);
      }
      d.wake();
      const tasks = ctx.call.taskIds.map((id) => d.tasks.find(id)!);
      if (tasks.some((t) => !['completed', 'failed', 'canceled'].includes(t.status))) return { waiting: true };
      ctx.call.resultIds = tasks.flatMap((t) => {
        const generated = t.result?.generation as { id?: string } | undefined;
        return typeof generated?.id === 'string' ? [generated.id] : [];
      });
      d.changed();
      return { result: tasks.map((t) => ({ id: t.id, assetId: t.assetId, status: t.status, result: t.result, error: t.errorCode })) };
    }
  };
  return [
    define('catalog.read', '读取明确指定的范围内照片（含评分、标签、文件名）；不推断图片内容。', scoped, false, true, (a, c) => scope(a.assetIds, c)),
    define('catalog.folders', '列出图库已注册的文件夹。', z.object({}).strict(), false, true, () => d.catalog.listFolders()),
    define('providers.list', '列出可用模型、用途和默认配置，不含密钥。', z.object({}).strict(), false, true, async () => (await d.providers.list()).map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, enabled: p.enabled, isDefault: p.isDefault, modelId: p.modelId }))),
    define('runtime.plan', '记录当前目标的可交付结果、行动步骤、分支/等待条件和验收标准。适用于修图、文件管理、表格、配置和混合任务；这是对用户负责的简明执行计划，不是内部思维链。简单任务可直接调用工具，不必为了形式创建计划。', z.object({ goal: z.string().min(1).max(4000), steps: z.array(z.string().min(1).max(1000)).min(1).max(20), acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20) }).strict(), false, true, (a) => a),
    define('vision.inspect', '实际查看原图和/或生成结果。原图用于专业逐图诊断；生成结果与对应原图一起检查是否达标、是否改变身份或出现伪影。最多一次 4 张原图和 4 个结果，分批检查。', z.object({ assetIds: ids.max(4), resultIds: z.array(z.string().uuid()).max(4).default([]), goal: z.string().min(1).max(8000) }).strict(), false, true, (a, c) => { scope(a.assetIds, c); if (a.resultIds.some((id) => !a.assetIds.some((assetId) => d.generation.list(assetId).some((r) => r.id === id)))) throw new Error('结果不属于指定图片'); return d.inspect(a, c.signal); }),
    define('analysis.read', '读取已有图片分析。修图前必须优先调用；返回空 revisions 的图片需要用 jobs.submit 的 kind=analysis 提交分析并等待真实结果后再次读取。分析是诊断依据，不能替代 vision.inspect 的真实像素检查。', scoped, false, true, (a, c) => { scope(a.assetIds, c); return a.assetIds.map((id) => ({ assetId: id, revisions: d.analysis.list(id).slice(0, 1) })); }),
    define('generation.read', '读取范围内照片的 AI 生成版本。', scoped, false, true, (a, c) => { scope(a.assetIds, c); return a.assetIds.map((id) => ({ assetId: id, results: d.generation.list(id) })); }),
    define('metadata.update', '修改明确图片的评分（0 到 5）、收藏、颜色或旗标。', updateCatalogMetadataInputSchema, false, true, (a, c) => { scope(a.assetIds, c); const result = d.catalog.updateMetadata(a); d.changed(); return result; }),
    define('tags.update', '为明确图片添加或移除标签。', updateCatalogTagsInputSchema, false, true, (a, c) => { scope(a.assetIds, c); const result = d.catalog.updateTags(a); d.changed(); return result; }),
    jobs,
    define('tasks.read', '读取此会话关联的作业状态。', z.object({}).strict(), false, true, (_a, c) => c.session.calls.flatMap((call) => call.taskIds).map((id) => { const t = d.tasks.find(id); return t ? { id, status: t.status, progress: t.progress, error: t.errorCode } : { id, status: 'missing' }; })),
    define('files.move', '移动范围内照片到已注册文件夹，保留文件操作记录。需要确认。', scoped.extend({ targetFolderId: z.string().min(1) }), true, false, async (a, c) => { scope(a.assetIds, c); const result = await d.files.move({ ...a, includeCompanions: false }); d.changed(); return result; }),
    define('files.remove', '仅移出图库，磁盘原文件保留。需要确认。不是永久删除。', scoped, true, false, async (a, c) => { scope(a.assetIds, c); const result = await d.files.removeFromCatalog(a); d.changed(); return result; }),
    { name: 'runtime.wait', description: '等待指定秒数（最多一天），随后继续观察；不阻塞任务执行器。', schema: z.object({ seconds: z.number().int().min(1).max(86400) }).strict(), approval: false, replayable: true,
      execute: async (raw, c) => {
        const a = z.object({ seconds: z.number().int().min(1).max(86400) }).parse(raw);
        if (c.call.wakeAt === null) { c.call.wakeAt = Date.now() + a.seconds * 1000; c.save(); }
        return c.call.wakeAt > Date.now() ? { waiting: true } : { result: { waitedSeconds: a.seconds } };
      } }
  ];
}
