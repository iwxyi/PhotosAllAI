import { describe, expect, it, vi } from 'vitest';

import { AgentProcessor } from './agent-processor';

describe('AgentProcessor', () => {
  it('rates and tags selected assets while preserving high impact delete confirmation', async () => {
    const catalog = {
      listAssets: vi.fn(() => [{ id: 'a', fileName: 'a.jpg' }, { id: 'b', fileName: 'b.jpg' }]),
      updateMetadata: vi.fn(),
      updateTags: vi.fn(),
      removeFromCatalog: vi.fn(async () => undefined)
    };
    const generation = { generate: vi.fn() };
    const providers = { list: vi.fn(async () => []) };
    const processor = new AgentProcessor({ catalog: catalog as never, generation: generation as never, providers: providers as never });
    const result = await processor.run({
      instruction: '评分并删除糊图',
      globalPrompt: '',
      selection: { assetIds: ['a'] },
      perAssetPrompts: [],
      steps: [
        { id: 'rate', kind: 'rate', rating: 2, instruction: '', prompt: '', perAssetPrompts: [], providerProfileId: null, templateId: null, outputDirectory: null, targetFolderId: null, confirm: false, style: null, dependsOn: [] },
        { id: 'adjust', kind: 'adjust', instruction: '', prompt: '', perAssetPrompts: [], providerProfileId: null, templateId: null, outputDirectory: null, targetFolderId: null, confirm: false, style: '精选', dependsOn: ['rate'] },
        { id: 'delete', kind: 'delete', instruction: '', prompt: '', perAssetPrompts: [], providerProfileId: null, templateId: null, outputDirectory: null, targetFolderId: null, confirm: false, style: null, dependsOn: ['adjust'] }
      ],
      outputDirectory: null,
      dryRun: false,
      confirmHighImpact: false,
      planVersion: 1
    });
    expect(catalog.updateMetadata).toHaveBeenCalledWith({ assetIds: ['a'], rating: 2 });
    expect(catalog.updateTags).toHaveBeenCalledWith({ assetIds: ['a'], addTags: ['精选'], removeTagIds: [] });
    expect(result.completedSteps).toEqual(['rate', 'adjust']);
    expect(result.skippedSteps).toContain('delete');
    expect(result.warnings[0]).toContain('高影响操作');
  });

  it('uses per-asset prompts before the global prompt for generation', async () => {
    const catalog = { listAssets: vi.fn(() => [{ id: 'a', fileName: 'a.jpg' }]), updateMetadata: vi.fn(), updateTags: vi.fn() };
    const generation = { generate: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000001' })) };
    const providers = { list: vi.fn(async () => [{ id: '00000000-0000-4000-8000-000000000002', purpose: 'generation', enabled: true }]) };
    const processor = new AgentProcessor({ catalog: catalog as never, generation: generation as never, providers: providers as never });
    await processor.run({
      instruction: '生成', globalPrompt: '全局要求', selection: { assetIds: ['a'] },
      perAssetPrompts: [{ assetId: 'a', prompt: '单图要求', negativePrompt: '', enabled: true }],
      steps: [{ id: 'generate', kind: 'generate', instruction: '', selection: undefined, assetIds: ['a'], rating: undefined, prompt: '', perAssetPrompts: [], providerProfileId: '00000000-0000-4000-8000-000000000002', templateId: null, outputDirectory: null, targetFolderId: null, confirm: false, style: null, dependsOn: [] }],
      outputDirectory: null, confirmHighImpact: false, dryRun: false, planVersion: 1
    });
    expect(generation.generate).toHaveBeenCalledWith('a', expect.objectContaining({ prompt: '单图要求' }), undefined);
  });

  it('requires confirmation before removing assets and moves only after confirmation', async () => {
    const removeFromCatalog = vi.fn(async () => undefined);
    const move = vi.fn(async () => undefined);
    const catalog = { listAssets: vi.fn(() => [{ id: 'a', fileName: 'a.jpg' }]), updateMetadata: vi.fn(), updateTags: vi.fn(), removeFromCatalog };
    const processor = new AgentProcessor({ catalog: catalog as never, files: { move }, generation: { generate: vi.fn() } as never, providers: { list: vi.fn(async () => []) } as never });
    const base = { instruction: '移动并移出图库', globalPrompt: '', selection: { assetIds: ['a'] }, perAssetPrompts: [], outputDirectory: null, dryRun: false, planVersion: 1 };
    const steps = [
      { id: 'move', kind: 'move' as const, instruction: '', assetIds: ['a'], targetFolderId: 'folder-b', confirm: true, prompt: '', perAssetPrompts: [], providerProfileId: null, templateId: null, outputDirectory: null, style: null, dependsOn: [] },
      { id: 'delete', kind: 'delete' as const, instruction: '', assetIds: ['a'], targetFolderId: null, confirm: true, prompt: '', perAssetPrompts: [], providerProfileId: null, templateId: null, outputDirectory: null, style: null, dependsOn: ['move'] }
    ];
    await processor.run({ ...base, steps, confirmHighImpact: false });
    expect(move).not.toHaveBeenCalled();
    expect(removeFromCatalog).not.toHaveBeenCalled();
    await processor.run({ ...base, steps, confirmHighImpact: true });
    expect(move).toHaveBeenCalledWith({ assetIds: ['a'], targetFolderId: 'folder-b', includeCompanions: false });
    expect(removeFromCatalog).toHaveBeenCalledWith({ assetIds: ['a'] });
  });
});
