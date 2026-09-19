import { z } from 'zod';

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux'])
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export const diagnosticSnapshotSchema = z.object({
  appVersion: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  catalog: z.object({ assets: z.number().int().nonnegative(), offline: z.number().int().nonnegative() }),
  providers: z.object({ total: z.number().int().nonnegative(), enabled: z.number().int().nonnegative() }),
  tasks: z.record(z.string(), z.number().int().nonnegative()),
  cache: z.object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    performance: z.object({
      hits: z.number().int().nonnegative(),
      misses: z.number().int().nonnegative(),
      decodes: z.number().int().nonnegative(),
      decodeMsTotal: z.number().nonnegative()
    }),
    raw: z.object({ nativeImage: z.boolean(), imageMagick: z.boolean(), sips: z.boolean() })
  })
});
export type DiagnosticSnapshot = z.infer<typeof diagnosticSnapshotSchema>;

export const diagnosticExportResultSchema = z.object({
  canceled: z.boolean(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
});
export type DiagnosticExportResult = z.infer<typeof diagnosticExportResultSchema>;

export const databaseBackupResultSchema = z.object({
  canceled: z.boolean(),
  destinationPath: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
});
export type DatabaseBackupResult = z.infer<typeof databaseBackupResultSchema>;
export const libraryBackupResultSchema = z.object({
  canceled: z.boolean(),
  databaseBytes: z.number().int().nonnegative(),
  generatedFiles: z.number().int().nonnegative(),
  generatedBytes: z.number().int().nonnegative(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
});
export type LibraryBackupResult = z.infer<typeof libraryBackupResultSchema>;
export const libraryBackupVerificationResultSchema = z.object({
  canceled: z.boolean(),
  createdAt: z.string().datetime().nullable(),
  databaseBytes: z.number().int().nonnegative(),
  generatedFiles: z.number().int().nonnegative(),
  generatedBytes: z.number().int().nonnegative()
});
export type LibraryBackupVerificationResult = z.infer<typeof libraryBackupVerificationResultSchema>;
export const libraryRestoreResultSchema = z.object({
  canceled: z.boolean(),
  createdAt: z.string().datetime().nullable(),
  databaseBytes: z.number().int().nonnegative(),
  generatedFiles: z.number().int().nonnegative(),
  generatedBytes: z.number().int().nonnegative()
});
export type LibraryRestoreResult = z.infer<typeof libraryRestoreResultSchema>;

export const appSettingsSchema = z.object({
  generationStorageMode: z.enum(['managed', 'portable']).default('managed'),
  theme: z.enum(['system', 'dark', 'light']).default('system')
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const workspaceTabSchema = z.enum(['library', 'templates', 'tasks', 'settings']);
export type WorkspaceTab = z.infer<typeof workspaceTabSchema>;

export const workspaceSessionSchema = z.object({
  version: z.literal(1),
  openTabs: z.array(workspaceTabSchema).min(1).max(4)
    .refine((items) => new Set(items).size === items.length, 'Workspace tabs must be unique')
    .refine((items) => items.includes('library'), 'Library tab must remain open'),
  activeTab: workspaceTabSchema,
  library: z.object({
    selectedFolderId: z.string().min(1).nullable(),
    selectedTagId: z.string().uuid().nullable(),
    selectedAssetId: z.string().min(1).nullable(),
    searchQuery: z.string().max(500)
  })
}).refine((session) => session.openTabs.includes(session.activeTab), {
  message: 'Active workspace tab must be open'
});
export type WorkspaceSession = z.infer<typeof workspaceSessionSchema>;

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
export const deleteCatalogTagInputSchema = z.string().uuid();
export type DeleteCatalogTagInput = z.input<typeof deleteCatalogTagInputSchema>;

export const catalogAssetSchema = z.object({
  id: z.string(),
  folderId: z.string(),
  fileName: z.string(),
  format: z.string(),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.number().nonnegative(),
  rating: z.number().int().min(0).max(5),
  favorite: z.boolean(),
  offline: z.boolean(),
  tags: z.array(catalogTagSchema.omit({ assetCount: true })),
  thumbnailUrl: z.string(),
  previewUrl: z.string()
});

export type CatalogAsset = z.infer<typeof catalogAssetSchema>;

export const catalogAssetCursorSchema = z.object({
  modifiedAt: z.number().nonnegative(),
  id: z.string().min(1),
  sortValue: z.union([z.string(), z.number()]).optional()
});
export type CatalogAssetCursor = z.infer<typeof catalogAssetCursorSchema>;

export const listCatalogAssetsInputSchema = z.object({
  folderId: z.string().min(1).nullable().default(null),
  tagId: z.string().uuid().nullable().default(null),
  albumId: z.string().uuid().nullable().default(null),
  smartCollection: z.enum(['favorites', 'unrated', 'unanalyzed', 'generated', 'to-review']).nullable().default(null),
  favoriteOnly: z.boolean().default(false),
  sortBy: z.enum(['modifiedAt', 'fileName', 'rating']).default('modifiedAt'),
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
  assetCount: z.number().int().nonnegative(),
  offlineCount: z.number().int().nonnegative()
});

export type CatalogFolder = z.infer<typeof catalogFolderSchema>;

export const relinkCatalogFolderResultSchema = z.object({
  folder: catalogFolderSchema,
  matched: z.number().int().nonnegative(),
  discovered: z.number().int().nonnegative(),
  offline: z.number().int().nonnegative()
});
export type RelinkCatalogFolderResult = z.infer<typeof relinkCatalogFolderResultSchema>;

export const catalogAlbumSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  assetCount: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative()
});
export type CatalogAlbum = z.infer<typeof catalogAlbumSchema>;

export const saveCatalogAlbumInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120)
});
export type SaveCatalogAlbumInput = z.infer<typeof saveCatalogAlbumInputSchema>;

export const updateCatalogAlbumAssetsInputSchema = z.object({
  albumId: z.string().uuid(),
  assetIds: z.array(z.string().min(1)).min(1).max(10_000),
  mode: z.enum(['add', 'remove'])
});
export type UpdateCatalogAlbumAssetsInput = z.infer<typeof updateCatalogAlbumAssetsInputSchema>;

export const catalogSmartCollectionSchema = z.object({
  id: z.enum(['favorites', 'unrated', 'unanalyzed', 'generated', 'to-review']),
  assetCount: z.number().int().nonnegative()
});
export type CatalogSmartCollection = z.infer<typeof catalogSmartCollectionSchema>;

export const moveCatalogAssetsInputSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10_000),
  targetFolderId: z.string().min(1),
  includeCompanions: z.boolean().optional()
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

export const catalogCompanionPreviewSchema = z.object({
  files: z.array(z.object({
    fileName: z.string().min(1),
    kind: z.enum(['raw', 'jpeg', 'xmp']),
    assetId: z.string().min(1).nullable(),
    bytes: z.number().int().nonnegative()
  })),
  totalBytes: z.number().int().nonnegative()
});
export type CatalogCompanionPreview = z.infer<typeof catalogCompanionPreviewSchema>;
export const catalogCompanionPreviewInputSchema = z.array(z.string().min(1)).min(1).max(10_000);

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
export const renameCatalogAssetsInputSchema = z.object({
  items: z.array(renameCatalogAssetInputSchema).min(1).max(10_000)
});
export type RenameCatalogAssetsInput = z.infer<typeof renameCatalogAssetsInputSchema>;
export const renameCatalogAssetsReportSchema = z.object({
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reports: z.array(renameCatalogAssetReportSchema)
});
export type RenameCatalogAssetsReport = z.infer<typeof renameCatalogAssetsReportSchema>;

export const catalogAssetRemovalInputSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10_000)
});
export type CatalogAssetRemovalInput = z.infer<typeof catalogAssetRemovalInputSchema>;

export const catalogAssetRemovalReportSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.enum(['remove', 'trash']),
  status: z.enum(['completed', 'partial', 'failed']),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures: z.array(z.object({ assetId: z.string().min(1), errorCode: z.string().min(1) }))
});
export type CatalogAssetRemovalReport = z.infer<typeof catalogAssetRemovalReportSchema>;

export const fileOperationHistoryItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['move', 'copy', 'rename', 'remove', 'trash']),
  status: z.enum(['planned', 'executing', 'compensating', 'completed', 'partial', 'failed', 'compensation_failed']),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  fileNames: z.array(z.string().min(1)),
  createdAt: z.number().nonnegative(),
  completedAt: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable()
});
export type FileOperationHistoryItem = z.infer<typeof fileOperationHistoryItemSchema>;

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
export const updateQueuedGenerationTaskInputSchema = z.object({
  taskId: taskIdSchema,
  prompt: z.string().trim().min(1).max(50_000)
});
export type UpdateQueuedGenerationTaskInput = z.infer<typeof updateQueuedGenerationTaskInputSchema>;
export const updateQueuedGenerationTasksInputSchema = z.object({
  taskIds: z.array(taskIdSchema).min(1).max(10_000),
  providerProfileId: z.string().uuid().optional(),
  prompt: z.string().trim().min(1).max(50_000).optional(),
  templateId: z.string().uuid().nullable().optional(),
  templateVersion: z.number().int().positive().nullable().optional(),
  resize: z.object({
    batchId: z.string().uuid(),
    assetId: z.string().min(1),
    count: z.number().int().min(1).max(20)
  }).optional()
}).refine((input) => input.providerProfileId !== undefined || input.prompt !== undefined, {
  message: 'GENERATION_TASK_PATCH_EMPTY'
}).refine((input) => (input.templateId === undefined) === (input.templateVersion === undefined), {
  message: 'GENERATION_TEMPLATE_SNAPSHOT_INCOMPLETE'
});
export type UpdateQueuedGenerationTasksInput = z.infer<typeof updateQueuedGenerationTasksInputSchema>;
export const resizeQueuedGenerationBatchInputSchema = z.object({
  batchId: z.string().uuid(),
  assetId: z.string().min(1),
  count: z.number().int().min(1).max(20)
});
export type ResizeQueuedGenerationBatchInput = z.infer<typeof resizeQueuedGenerationBatchInputSchema>;

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
  exampleId: z.enum(['portrait', 'street', 'coast', 'none']),
  version: z.number().int().positive(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative()
});

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;

export const savePromptTemplateInputSchema = promptTemplateSchema.omit({
  id: true, version: true, createdAt: true, updatedAt: true
}).extend({ id: z.string().uuid().optional(), exampleId: z.enum(['portrait', 'street', 'coast', 'none']).optional().default('none') });

export type SavePromptTemplateInput = Omit<z.infer<typeof savePromptTemplateInputSchema>, 'exampleId'> & {
  exampleId?: PromptTemplate['exampleId'];
};

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
  resultIndex: z.number().int().positive(),
  storageMode: z.enum(['managed', 'portable']).default('managed'),
  analysisRevisionId: z.string().uuid().optional(),
  disabledActionIds: z.array(z.string().min(1).max(200)).max(1_000).optional().default([]),
  userInstruction: z.string().max(20_000).optional().default('')
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
  storageMode: z.enum(['managed', 'portable']).default('managed'),
  reviewState: z.enum(['undecided', 'accepted', 'rejected', 'preferred']),
  createdAt: z.number().nonnegative()
});

export type GenerationResult = z.infer<typeof generationResultSchema>;

export const updateGenerationResultReviewInputSchema = z.object({
  resultId: z.string().uuid(),
  reviewState: z.enum(['undecided', 'accepted', 'rejected', 'preferred'])
});
export type UpdateGenerationResultReviewInput = z.infer<typeof updateGenerationResultReviewInputSchema>;

export const exportGenerationResultsInputSchema = z.object({
  resultIds: z.array(z.string().uuid()).min(1).max(10_000),
  presetId: z.string().uuid().nullable().default(null)
});

export type ExportGenerationResultsInput = z.infer<typeof exportGenerationResultsInputSchema>;

export const exportPresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  format: z.enum(['original', 'jpeg', 'png']),
  quality: z.number().int().min(1).max(100),
  maxDimension: z.number().int().min(256).max(20_000).nullable(),
  conflictPolicy: z.enum(['auto-rename', 'skip']),
  namingPattern: z.string().min(1).max(160),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
});
export type ExportPreset = z.infer<typeof exportPresetSchema>;

export const saveExportPresetInputSchema = exportPresetSchema.omit({ id: true, createdAt: true, updatedAt: true }).extend({
  id: z.string().uuid().optional(),
  quality: z.number().int().min(1).max(100).optional().default(90),
  maxDimension: z.number().int().min(256).max(20_000).nullable().optional().default(null)
});
export type SaveExportPresetInput = z.input<typeof saveExportPresetInputSchema>;

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

export const imageCacheStatsSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative()
});
export type ImageCacheStats = z.infer<typeof imageCacheStatsSchema>;
export const pruneImageCacheInputSchema = z.object({ maxBytes: z.number().int().nonnegative().max(100 * 1024 * 1024 * 1024) });

export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
  getAppSettings(): Promise<AppSettings>;
  saveAppSettings(input: AppSettings): Promise<AppSettings>;
  getDiagnosticSnapshot(): Promise<DiagnosticSnapshot>;
  exportDiagnosticSnapshot(): Promise<DiagnosticExportResult>;
  backupDatabase(): Promise<DatabaseBackupResult>;
  backupLibrary(): Promise<LibraryBackupResult>;
  verifyLibraryBackup(): Promise<LibraryBackupVerificationResult>;
  restoreLibraryBackup(): Promise<LibraryRestoreResult>;
  getWorkspaceSession(): Promise<WorkspaceSession>;
  saveWorkspaceSession(session: WorkspaceSession): Promise<WorkspaceSession>;
  listCatalogAssets(): Promise<CatalogAsset[]>;
  listCatalogAssetPage(input: ListCatalogAssetsInput): Promise<CatalogAssetPage>;
  listCatalogFolders(): Promise<CatalogFolder[]>;
  listCatalogTags(): Promise<CatalogTag[]>;
  deleteCatalogTag(tagId: DeleteCatalogTagInput): Promise<void>;
  listCatalogAlbums(): Promise<CatalogAlbum[]>;
  listCatalogSmartCollections(): Promise<CatalogSmartCollection[]>;
  saveCatalogAlbum(input: SaveCatalogAlbumInput): Promise<CatalogAlbum>;
  deleteCatalogAlbum(albumId: string): Promise<void>;
  updateCatalogAlbumAssets(input: UpdateCatalogAlbumAssetsInput): Promise<CatalogAlbum>;
  updateCatalogMetadata(input: UpdateCatalogMetadataInput): Promise<CatalogAsset[]>;
  updateCatalogTags(input: UpdateCatalogTagsInput): Promise<CatalogTag[]>;
  moveCatalogAssets(input: MoveCatalogAssetsInput): Promise<MoveCatalogAssetsReport>;
  copyCatalogAssets(input: CopyCatalogAssetsInput): Promise<CopyCatalogAssetsReport>;
  previewCatalogCompanions(assetIds: string[]): Promise<CatalogCompanionPreview>;
  renameCatalogAsset(input: RenameCatalogAssetInput): Promise<RenameCatalogAssetReport>;
  renameCatalogAssets(input: RenameCatalogAssetsInput): Promise<RenameCatalogAssetsReport>;
  removeCatalogAssets(input: CatalogAssetRemovalInput): Promise<CatalogAssetRemovalReport>;
  trashCatalogAssets(input: CatalogAssetRemovalInput): Promise<CatalogAssetRemovalReport>;
  listFileOperationHistory(): Promise<FileOperationHistoryItem[]>;
  importFolders(): Promise<CatalogSnapshot | null>;
  relinkCatalogFolder(folderId: string): Promise<RelinkCatalogFolderResult | null>;
  revealCatalogAsset(assetId: string): Promise<boolean>;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
  deleteProviderProfile(profileId: string): Promise<void>;
  testProviderConnection(input: SaveProviderProfileInput): Promise<ConnectionTest>;
  listTasks(): Promise<PersistedTask[]>;
  enqueueTask(input: EnqueueTaskInput): Promise<PersistedTask>;
  cancelTask(taskId: string): Promise<PersistedTask>;
  retryTask(taskId: string): Promise<PersistedTask>;
  reorderTasks(taskIds: string[]): Promise<PersistedTask[]>;
  updateQueuedGenerationTask(input: UpdateQueuedGenerationTaskInput): Promise<PersistedTask>;
  updateQueuedGenerationTasks(input: UpdateQueuedGenerationTasksInput): Promise<PersistedTask[]>;
  resizeQueuedGenerationBatch(input: ResizeQueuedGenerationBatchInput): Promise<PersistedTask[]>;
  listPromptTemplates(): Promise<PromptTemplate[]>;
  savePromptTemplate(input: SavePromptTemplateInput): Promise<PromptTemplate>;
  archivePromptTemplate(templateId: string): Promise<void>;
  listAnalysisRevisions(assetId: string): Promise<AnalysisRevision[]>;
  listGenerationResults(assetId: string): Promise<GenerationResult[]>;
  updateGenerationResultReview(input: UpdateGenerationResultReviewInput): Promise<GenerationResult>;
  revealGenerationResult(resultId: string): Promise<boolean>;
  exportGenerationResults(input: ExportGenerationResultsInput): Promise<ExportReport>;
  listExportPresets(): Promise<ExportPreset[]>;
  saveExportPreset(input: SaveExportPresetInput): Promise<ExportPreset>;
  deleteExportPreset(presetId: string): Promise<void>;
  getImageCacheStats(): Promise<ImageCacheStats>;
  pruneImageCache(input: z.input<typeof pruneImageCacheInputSchema>): Promise<{ removedFiles: number; removedBytes: number }>;
}
