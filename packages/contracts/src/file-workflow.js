import { z } from 'zod';
export const fileWorkflowStepSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(80),
    field: z.enum(['relativePath', 'fileName']).default('relativePath'),
    pattern: z.string().min(1).max(1000).refine((value) => {
        try {
            new RegExp(value, 'u');
            return value.includes('(?<key>');
        }
        catch {
            return false;
        }
    }, '正则需要有效的命名捕获组 (?<key>...)'),
    ignoreCase: z.boolean().default(true)
});
export const fileWorkflowPresetSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(80),
    steps: z.array(fileWorkflowStepSchema).min(1).max(30)
        .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, '步骤 ID 重复')
});
export const fileWorkflowBindingSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('off') }),
    z.object({ mode: z.literal('preset'), presetId: z.string().min(1).max(100) }),
    z.object({ mode: z.literal('custom'), preset: fileWorkflowPresetSchema })
]);
export const fileWorkflowConfigSchema = z.object({
    revision: z.number().int().nonnegative().default(0),
    defaultPresetId: z.string().nullable().default(null),
    presets: z.array(fileWorkflowPresetSchema).max(100).default([]),
    folders: z.record(z.string().min(1).max(100), fileWorkflowBindingSchema).default({}),
    albums: z.record(z.string().uuid(), fileWorkflowBindingSchema).default({})
}).superRefine((config, context) => {
    const ids = new Set(config.presets.map((preset) => preset.id));
    if (ids.size !== config.presets.length)
        context.addIssue({ code: 'custom', message: '流程 ID 重复' });
    if (config.defaultPresetId && !ids.has(config.defaultPresetId))
        context.addIssue({ code: 'custom', message: '默认流程不存在' });
    for (const binding of [...Object.values(config.folders), ...Object.values(config.albums)]) {
        if (binding.mode === 'preset' && !ids.has(binding.presetId))
            context.addIssue({ code: 'custom', message: '引用的流程不存在' });
    }
});
export const fileWorkflowScopeSchema = z.object({
    folderId: z.string().min(1).nullable().default(null),
    albumId: z.string().uuid().nullable().default(null)
});
export const previewFileWorkflowInputSchema = fileWorkflowScopeSchema.extend({ config: fileWorkflowConfigSchema });
export const DEFAULT_FILE_WORKFLOW = {
    id: 'photo-editing', name: '摄影后期', steps: [
        { id: 'original', name: '原图', field: 'relativePath', pattern: '^(?:原图|RAW)/(?<key>[^/]+)\\.(?:cr2|cr3|nef|arw|dng|raf|jpe?g|png)$', ignoreCase: true },
        { id: 'exposure', name: '后期', field: 'relativePath', pattern: '^(?:后期|曝光还原|LR输出)/(?<key>[^/]+?)(?:-曝光)?\\.(?:jpe?g|tiff?|png)$', ignoreCase: true },
        { id: 'beauty', name: '美颜', field: 'relativePath', pattern: '^(?:美颜|像素蛋糕)/(?<key>[^/]+?)(?:-美颜)?\\.(?:jpe?g|tiff?|png)$', ignoreCase: true },
        { id: 'color', name: '调色', field: 'relativePath', pattern: '^(?:调色|成片)/(?<key>[^/]+?)(?:-调色)?\\.(?:jpe?g|tiff?|png)$', ignoreCase: true },
        { id: 'ai', name: 'AI 修图', field: 'relativePath', pattern: '^(?:AI|AI修图|AI修图结果)/(?<key>[^/]+?)(?:-AI-(?<variant>\\d+))?\\.(?:jpe?g|png|webp)$', ignoreCase: true }
    ]
};
