import { z } from 'zod';

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux'])
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export const openPathResultSchema = z.object({
  canceled: z.boolean(),
  paths: z.array(z.string())
});

export type OpenPathResult = z.infer<typeof openPathResultSchema>;

export const catalogTagSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  assetCount: z.number().int().nonnegative()
});
export type CatalogTag = z.infer<typeof catalogTagSchema>;

export const catalogAssetSchema = z.object({
  id: z.string(),
  folderId: z.string(),
  fileName: z.string(),
  format: z.string(),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.number().nonnegative(),
  rating: z.number().int().min(0).max(5),
  favorite: z.boolean(),
  tags: z.array(catalogTagSchema.omit({ assetCount: true })),
  thumbnailUrl: z.string(),
  previewUrl: z.string()
});

export type CatalogAsset = z.infer<typeof catalogAssetSchema>;

export const catalogAssetCursorSchema = z.object({
  modifiedAt: z.number().nonnegative(),
  id: z.string().min(1)
});
export type CatalogAssetCursor = z.infer<typeof catalogAssetCursorSchema>;

export const listCatalogAssetsInputSchema = z.object({
  folderId: z.string().min(1).nullable().default(null),
  tagId: z.string().uuid().nullable().default(null),
  favoriteOnly: z.boolean().default(false),
  query: z.string().max(500).default(''),
  cursor: catalogAssetCursorSchema.nullable().default(null),
  limit: z.number().int().min(1).max(500).default(200)
});

export type ListCatalogAssetsInput = z.input<typeof listCatalogAssetsInputSchema>;

export const catalogAssetPageSchema = z.object({
  items: z.array(catalogAssetSchema),
  totalCount: z.number().int().nonnegative(),
  nextCursor: catalogAssetCursorSchema.nullable()
});

export type CatalogAssetPage = z.infer<typeof catalogAssetPageSchema>;

export const catalogFolderSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  assetCount: z.number().int().nonnegative()
});

export type CatalogFolder = z.infer<typeof catalogFolderSchema>;

export const moveCatalogAssetsInputSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10_000),
  targetFolderId: z.string().min(1)
});

export type MoveCatalogAssetsInput = z.infer<typeof moveCatalogAssetsInputSchema>;

export const moveCatalogAssetsReportSchema = z.object({
  operationId: z.string().uuid(),
  status: z.enum(['completed', 'failed']),
  total: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  rolledBack: z.boolean(),
  files: z.array(z.object({
    assetId: z.string().min(1),
    fileName: z.string().min(1),
    previousFileName: z.string().min(1)
  })),
  errorCode: z.string().min(1).nullable()
});

export type MoveCatalogAssetsReport = z.infer<typeof moveCatalogAssetsReportSchema>;

export const copyCatalogAssetsInputSchema = moveCatalogAssetsInputSchema;
export type CopyCatalogAssetsInput = z.infer<typeof copyCatalogAssetsInputSchema>;

export const copyCatalogAssetsReportSchema = z.object({
  operationId: z.string().uuid(),
  status: z.enum(['completed', 'failed']),
  total: z.number().int().nonnegative(),
  copied: z.number().int().nonnegative(),
  rolledBack: z.boolean(),
  files: z.array(z.object({
    sourceAssetId: z.string().min(1),
    assetId: z.string().min(1),
    fileName: z.string().min(1)
  })),
  errorCode: z.string().min(1).nullable()
});
export type CopyCatalogAssetsReport = z.infer<typeof copyCatalogAssetsReportSchema>;

export const renameCatalogAssetInputSchema = z.object({
  assetId: z.string().min(1),
  fileName: z.string().min(1).max(255)
});
export type RenameCatalogAssetInput = z.infer<typeof renameCatalogAssetInputSchema>;

export const renameCatalogAssetReportSchema = z.object({
  operationId: z.string().uuid(),
  status: z.enum(['completed', 'failed']),
  assetId: z.string().min(1),
  previousFileName: z.string().min(1),
  fileName: z.string().min(1),
  rolledBack: z.boolean(),
  errorCode: z.string().min(1).nullable()
});
export type RenameCatalogAssetReport = z.infer<typeof renameCatalogAssetReportSchema>;

export const updateCatalogMetadataInputSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10_000),
  rating: z.number().int().min(0).max(5).optional(),
  favorite: z.boolean().optional()
}).refine((input) => input.rating !== undefined || input.favorite !== undefined, {
  message: 'At least one metadata field is required'
});

export type UpdateCatalogMetadataInput = z.infer<typeof updateCatalogMetadataInputSchema>;

export const updateCatalogTagsInputSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10_000),
  addTags: z.array(z.string().min(1).max(100)).max(50).default([]),
  removeTagIds: z.array(z.string().uuid()).max(50).default([])
}).refine((input) => input.addTags.length > 0 || input.removeTagIds.length > 0, {
  message: 'At least one tag operation is required'
});
export type UpdateCatalogTagsInput = z.input<typeof updateCatalogTagsInputSchema>;

export const catalogSnapshotSchema = z.object({
  assets: z.array(catalogAssetSchema),
  importedCount: z.number().int().nonnegative()
});

export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;

export const providerKindSchema = z.enum(['openai-compatible', 'nanobanana-compatible']);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const providerPurposeSchema = z.enum(['vision', 'generation']);
export type ProviderPurpose = z.infer<typeof providerPurposeSchema>;

export const providerProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  kind: providerKindSchema,
  purpose: providerPurposeSchema,
  baseUrl: z.string().url(),
  modelId: z.string().min(1).max(200),
  hasCredential: z.boolean(),
  enabled: z.boolean(),
  updatedAt: z.number().nonnegative()
});

export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const saveProviderProfileInputSchema = providerProfileSchema
  .omit({ id: true, hasCredential: true, updatedAt: true })
  .extend({
    id: z.string().uuid().optional(),
    apiKey: z.string().max(10_000).optional()
  });

export type SaveProviderProfileInput = z.infer<typeof saveProviderProfileInputSchema>;

export const connectionTestSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nonnegative()
});

export type ConnectionTest = z.infer<typeof connectionTestSchema>;

export const taskKindSchema = z.enum(['analysis', 'generation', 'export']);
export const taskStatusSchema = z.enum([
  'draft', 'queued', 'preparing', 'uploading', 'processing',
  'downloading', 'saving', 'completed', 'failed', 'canceled'
]);

export const persistedTaskSchema = z.object({
  id: z.string().uuid(),
  kind: taskKindSchema,
  assetId: z.string().nullable(),
  status: taskStatusSchema,
  position: z.number().int().nonnegative(),
  progress: z.number().min(0).max(1),
  attempt: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  errorCode: z.string().nullable(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative()
});

export type PersistedTask = z.infer<typeof persistedTaskSchema>;

export const enqueueTaskInputSchema = z.object({
  kind: taskKindSchema,
  assetId: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({})
});

export type EnqueueTaskInput = z.infer<typeof enqueueTaskInputSchema>;
export const taskIdSchema = z.string().uuid();
export const reorderTaskIdsSchema = z.array(taskIdSchema).max(10_000);

export const normalizedRegionSchema = z.object({
  kind: z.literal('normalized_box'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1)
}).refine((region) => region.x + region.width <= 1.001 && region.y + region.height <= 1.001, {
  message: 'Region must fit inside normalized image bounds'
});

export const analysisIssueSchema = z.object({
  type: z.string().min(1).max(100),
  severity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  description: z.string().min(1).max(2_000)
});

export const adjustmentSuggestionSchema = z.object({
  parameter: z.string().min(1).max(100),
  value: z.number(),
  unit: z.string().max(30),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1_000)
});

export const generativeActionSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum([
    'remove_object', 'replace_background', 'relight', 'outpaint',
    'repair', 'recompose', 'other'
  ]),
  target: z.string().min(1).max(1_000),
  region: normalizedRegionSchema.nullable(),
  instruction: z.string().min(1).max(4_000),
  preserve: z.array(z.string().min(1).max(500)).max(50),
  risk: z.enum(['low', 'medium', 'high']),
  confidence: z.number().min(0).max(1),
  enabled: z.boolean()
});

export const catalogAnnotationSchema = z.object({
  shortDescription: z.string().min(1).max(500),
  longDescription: z.string().max(5_000),
  scenes: z.array(z.string().min(1).max(100)).max(50),
  subjects: z.array(z.string().min(1).max(100)).max(50),
  objects: z.array(z.string().min(1).max(100)).max(100),
  mood: z.array(z.string().min(1).max(100)).max(30),
  colors: z.array(z.string().min(1).max(100)).max(30),
  keywords: z.array(z.string().min(1).max(100)).max(100),
  ocrText: z.string().max(10_000).default('')
});

export const analysisResultSchema = z.object({
  schemaVersion: z.literal('1.0'),
  summary: z.string().min(1).max(1_000),
  report: z.string().min(1).max(20_000),
  quality: z.object({
    overallScore: z.number().min(0).max(100),
    issues: z.array(analysisIssueSchema).max(100)
  }),
  adjustments: z.object({
    global: z.array(adjustmentSuggestionSchema).max(100),
    local: z.array(adjustmentSuggestionSchema.extend({
      target: z.string().min(1).max(500),
      region: normalizedRegionSchema.nullable()
    })).max(100)
  }),
  generativeActions: z.array(generativeActionSchema).max(100),
  catalog: catalogAnnotationSchema,
  generationRecommendation: z.object({
    recommended: z.boolean(),
    templateId: z.string().nullable(),
    reason: z.string().max(2_000)
  })
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const promptTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(2_000),
  category: z.string().min(1).max(100),
  body: z.string().min(1).max(20_000),
  version: z.number().int().positive(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative()
});

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;

export const savePromptTemplateInputSchema = promptTemplateSchema.omit({
  id: true, version: true, createdAt: true, updatedAt: true
}).extend({ id: z.string().uuid().optional() });

export type SavePromptTemplateInput = z.infer<typeof savePromptTemplateInputSchema>;

export const analysisRevisionSchema = z.object({
  id: z.string().uuid(),
  assetId: z.string(),
  providerProfileId: z.string().uuid(),
  result: analysisResultSchema,
  createdAt: z.number().nonnegative()
});

export type AnalysisRevision = z.infer<typeof analysisRevisionSchema>;

export const listAnalysisInputSchema = z.object({ assetId: z.string().min(1) });
export const listGenerationResultsInputSchema = z.object({ assetId: z.string().min(1) });
export const analysisTaskPayloadSchema = z.object({
  providerProfileId: z.string().uuid(),
  mode: z.enum(['catalog', 'full']).default('full')
});

export const generationTaskPayloadSchema = z.object({
  providerProfileId: z.string().uuid(),
  batchId: z.string().uuid(),
  prompt: z.string().min(1).max(50_000),
  templateId: z.string().uuid().nullable().default(null),
  templateVersion: z.number().int().positive().nullable().default(null),
  resultIndex: z.number().int().positive()
});

export const generationResultSchema = z.object({
  id: z.string().uuid(),
  assetId: z.string(),
  batchId: z.string().uuid(),
  version: z.number().int().positive(),
  fileName: z.string().min(1),
  resultUrl: z.string(),
  prompt: z.string(),
  providerProfileId: z.string().uuid(),
  templateId: z.string().uuid().nullable(),
  templateVersion: z.number().int().positive().nullable(),
  createdAt: z.number().nonnegative()
});

export type GenerationResult = z.infer<typeof generationResultSchema>;

export const exportGenerationResultsInputSchema = z.object({
  resultIds: z.array(z.string().uuid()).min(1).max(10_000)
});

export type ExportGenerationResultsInput = z.infer<typeof exportGenerationResultsInputSchema>;

export const exportReportSchema = z.object({
  id: z.string().uuid().nullable(),
  canceled: z.boolean(),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  files: z.array(z.object({ resultId: z.string().uuid(), fileName: z.string().min(1) })),
  failures: z.array(z.object({ resultId: z.string().uuid(), errorCode: z.string().min(1) }))
});

export type ExportReport = z.infer<typeof exportReportSchema>;

export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
  listCatalogAssets(): Promise<CatalogAsset[]>;
  listCatalogAssetPage(input: ListCatalogAssetsInput): Promise<CatalogAssetPage>;
  listCatalogFolders(): Promise<CatalogFolder[]>;
  listCatalogTags(): Promise<CatalogTag[]>;
  updateCatalogMetadata(input: UpdateCatalogMetadataInput): Promise<CatalogAsset[]>;
  updateCatalogTags(input: UpdateCatalogTagsInput): Promise<CatalogTag[]>;
  moveCatalogAssets(input: MoveCatalogAssetsInput): Promise<MoveCatalogAssetsReport>;
  copyCatalogAssets(input: CopyCatalogAssetsInput): Promise<CopyCatalogAssetsReport>;
  renameCatalogAsset(input: RenameCatalogAssetInput): Promise<RenameCatalogAssetReport>;
  importFolders(): Promise<CatalogSnapshot | null>;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
  testProviderConnection(input: SaveProviderProfileInput): Promise<ConnectionTest>;
  listTasks(): Promise<PersistedTask[]>;
  enqueueTask(input: EnqueueTaskInput): Promise<PersistedTask>;
  cancelTask(taskId: string): Promise<PersistedTask>;
  retryTask(taskId: string): Promise<PersistedTask>;
  reorderTasks(taskIds: string[]): Promise<PersistedTask[]>;
  listPromptTemplates(): Promise<PromptTemplate[]>;
  savePromptTemplate(input: SavePromptTemplateInput): Promise<PromptTemplate>;
  listAnalysisRevisions(assetId: string): Promise<AnalysisRevision[]>;
  listGenerationResults(assetId: string): Promise<GenerationResult[]>;
  exportGenerationResults(input: ExportGenerationResultsInput): Promise<ExportReport>;
}
