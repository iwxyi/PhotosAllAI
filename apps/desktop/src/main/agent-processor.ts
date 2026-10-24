import {
  agentTaskPayloadSchema,
  agentTaskResultSchema,
  generationTaskPayloadSchema,
  type AgentTaskResult,
  type CatalogAsset,
  type ProviderProfile
} from '@photoallisai/contracts';

import type { CatalogService } from './catalog-service';
import type { GenerationService } from './generation-service';
import type { ProviderService } from './provider-service';

type AgentDependencies = {
  catalog: Pick<CatalogService, 'listAssets' | 'updateMetadata' | 'updateTags'> & { removeFromCatalog?: (input: { assetIds: string[] }) => Promise<unknown> };
  files?: { move: (input: { assetIds: string[]; targetFolderId: string; includeCompanions?: boolean }) => Promise<unknown> };
  generation: Pick<GenerationService, 'generate'>;
  providers: Pick<ProviderService, 'list'>;
};

export class AgentProcessor {
  readonly #catalog: AgentDependencies['catalog'];
  readonly #generation: AgentDependencies['generation'];
  readonly #providers: AgentDependencies['providers'];
  readonly #files: AgentDependencies['files'];

  constructor(dependencies: AgentDependencies) {
    this.#catalog = dependencies.catalog;
    this.#generation = dependencies.generation;
    this.#providers = dependencies.providers;
    this.#files = dependencies.files;
  }

  async run(rawPayload: unknown, signal?: AbortSignal, onProgress?: (progress: number) => void): Promise<AgentTaskResult> {
    const payload = agentTaskPayloadSchema.parse(rawPayload);
    const allAssets = this.#catalog.listAssets();
    let selectedIds = payload.selection.assetIds?.length ? [...payload.selection.assetIds] : allAssets.map((asset) => asset.id);
    const completedSteps: string[] = [];
    const skippedSteps: string[] = [];
    const warnings: string[] = [];
    const generatedResultIds: string[] = [];
    const removedAssetIds: string[] = [];
    const ratedAssetIds: string[] = [];
    const movedAssetIds: string[] = [];
    const total = Math.max(1, payload.steps.length);
    const assetsById = new Map(allAssets.map((asset) => [asset.id, asset]));

    for (const [index, step] of payload.steps.entries()) {
      signal?.throwIfAborted();
      const stepIds = step.assetIds?.length ? step.assetIds : selectedIds;
      const validIds = stepIds.filter((id) => assetsById.has(id));
      if (step.kind === 'select' || step.kind === 'deduplicate' || step.kind === 'rank') {
        selectedIds = validIds.slice(0, step.selection?.limit ?? validIds.length);
        completedSteps.push(step.id);
      } else if (step.kind === 'rate') {
        const rating = step.rating ?? 0;
        if (validIds.length) {
          this.#catalog.updateMetadata({ assetIds: validIds, rating });
          ratedAssetIds.push(...validIds);
        }
        completedSteps.push(step.id);
      } else if (step.kind === 'adjust') {
        const tags = step.style ? [step.style] : [];
        if (tags.length && validIds.length) this.#catalog.updateTags({ assetIds: validIds, addTags: tags, removeTagIds: [] });
        completedSteps.push(step.id);
      } else if (step.kind === 'generate') {
        const providers = await this.#providers.list();
        const providerId = step.providerProfileId ?? providers.find((profile: ProviderProfile) => profile.purpose === 'generation' && profile.enabled)?.id;
        if (!providerId || !validIds.length) {
          skippedSteps.push(step.id);
          warnings.push(`${step.id}: 没有可用的生成模型或照片。`);
        } else if (payload.dryRun) {
          skippedSteps.push(step.id);
          warnings.push(`${step.id}: 预览模式未执行生成。`);
        } else {
          for (const assetId of validIds) {
            const perAssetPrompt = step.perAssetPrompts.find((item) => item.assetId === assetId && item.enabled)?.prompt
              ?? payload.perAssetPrompts.find((item) => item.assetId === assetId && item.enabled)?.prompt;
            const result = await this.#generation.generate(assetId, generationTaskPayloadSchema.parse({
              providerProfileId: providerId,
              batchId: crypto.randomUUID(),
              prompt: perAssetPrompt || step.prompt || payload.globalPrompt || payload.instruction,
              templateId: step.templateId,
              templateVersion: null,
              resultIndex: 1,
              storageMode: 'managed',
              analysisRevisionId: undefined,
              disabledActionIds: [],
              userInstruction: step.instruction
            }), signal);
            generatedResultIds.push(result.id);
          }
        }
        completedSteps.push(step.id);
      } else if (step.kind === 'delete') {
        skippedSteps.push(step.id);
        if (payload.confirmHighImpact && step.confirm && this.#catalog.removeFromCatalog) {
          await this.#catalog.removeFromCatalog({ assetIds: validIds });
          removedAssetIds.push(...validIds);
          completedSteps.push(step.id);
        } else {
          warnings.push(`${step.id}: 已识别 ${validIds.length} 张待删除候选；这是高影响操作，删除原图需要在界面确认。`);
          skippedSteps.push(step.id);
        }
      } else if (step.kind === 'move') {
        if (payload.confirmHighImpact && step.confirm && step.targetFolderId && this.#files) {
          await this.#files.move({ assetIds: validIds, targetFolderId: step.targetFolderId, includeCompanions: false });
          movedAssetIds.push(...validIds);
          completedSteps.push(step.id);
        } else {
          skippedSteps.push(step.id);
          warnings.push(`${step.id}: 已记录 ${validIds.length} 张照片和目标位置；移动原图需要确认。`);
        }
      } else if (step.kind === 'export') {
        skippedSteps.push(step.id);
        warnings.push(`${step.id}: 已记录 ${validIds.length} 张照片和目标位置；导出需要由生成版本任务执行。`);
      } else {
        skippedSteps.push(step.id);
      }
      onProgress?.((index + 1) / total);
    }

    return agentTaskResultSchema.parse({ selectedAssetIds: selectedIds, removedAssetIds, ratedAssetIds, generatedResultIds, movedAssetIds, completedSteps, skippedSteps, warnings, dryRun: payload.dryRun });
  }
}
