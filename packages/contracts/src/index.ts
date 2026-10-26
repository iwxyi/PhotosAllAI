import { z } from 'zod';
import type { FileWorkflowConfig, FileWorkflowScope } from './file-workflow';
export * from './file-workflow';

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux'])
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export const libraryIntegrityReportSchema = z.object({
  status: z.enum(['healthy', 'warning', 'error']),
  databaseStatus: z.enum(['ok', 'corrupt', 'unreadable']),
  activeGenerationResults: z.number().int().nonnegative(),
  trashedGenerationResults: z.number().int().nonnegative(),
  pendingGenerationWrites: z.number().int().nonnegative(),
  staleGenerationWriteIntents: z.number().int().nonnegative(),
  unsafeGenerationWriteIntents: z.number().int().nonnegative(),
  missingActiveFiles: z.number().int().nonnegative(),
  missingTrashFiles: z.number().int().nonnegative(),
  unsafeManagedPaths: z.number().int().nonnegative(),
  unsafeTrashPaths: z.number().int().nonnegative(),
  nonRegularFiles: z.number().int().nonnegative(),
  inaccessibleFiles: z.number().int().nonnegative(),
  unexpectedGeneratedFiles: z.number().int().nonnegative(),
  unexpectedTrashFiles: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative()
});
export type LibraryIntegrityReport = z.infer<typeof libraryIntegrityReportSchema>;

export const diagnosticSnapshotSchema = z.object({
  appVersion: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  catalog: z.object({ assets: z.number().int().nonnegative(), offline: z.number().int().nonnegative() }),
  catalogWatcher: z.object({
    watchedFolders: z.number().int().nonnegative(),
    activeWatchers: z.number().int().nonnegative(),
    watchFailures: z.number().int().nonnegative(),
    reconciliationFailures: z.number().int().nonnegative()
  }),
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
  }),
  startupRecovery: z.object({
    trashPurges: z.object({
      total: z.number().int().nonnegative(),
      recovered: z.number().int().nonnegative(),
      conflicts: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative()
    }),
    fileOperations: z.object({
      total: z.number().int().nonnegative(),
      resolved: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative()
    }),
    generationWrites: z.object({
      total: z.number().int().nonnegative(),
      recovered: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative()
    }),
    automaticBackup: z.object({
      status: z.enum(['pending', 'completed', 'skipped', 'failed'])
    })
  }),
  integrity: libraryIntegrityReportSchema
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
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  cacheMaxBytes: z.number().int().min(1024 ** 3).max(50 * 1024 ** 3).default(5 * 1024 ** 3)
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const workspaceTabSchema = z.union([
  z.enum(['library', 'viewer', 'batch', 'workflow', 'templates', 'tasks', 'settings']),
  z.templateLiteral(['task:', z.string().max(160)])
]);
export type WorkspaceTab = z.infer<typeof workspaceTabSchema>;

export const workspaceSessionV1Schema = z.object({
  version: z.literal(1),
  openTabs: z.array(workspaceTabSchema).min(1).max(100)
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
export type WorkspaceSessionV1 = z.infer<typeof workspaceSessionV1Schema>;

export const workspaceSessionSchema = z.object({
  version: z.literal(2),
  openTabs: z.array(workspaceTabSchema).min(1).max(100)
    .refine((items) => new Set(items).size === items.length, 'Workspace tabs must be unique')
    .refine((items) => items.includes('library'), 'Library tab must remain open'),
  activeTab: workspaceTabSchema,
  library: z.object({
    selectedFolderId: z.string().min(1).nullable(),
    selectedAlbumId: z.string().uuid().nullable(),
    selectedSmartCollection: z.enum(['recent', 'favorites', 'unrated', 'unanalyzed', 'generated', 'to-review']).nullable(),
    selectedTagId: z.string().uuid().nullable(),
    selectedAssetId: z.string().min(1).nullable(),
    favoriteOnly: z.boolean(),
    sortBy: z.enum(['modifiedAt', 'fileName', 'rating']),
    sortDirection: z.enum(['asc', 'desc']).optional(),
    searchQuery: z.string().max(500)
  })
}).refine((session) => session.openTabs.includes(session.activeTab), {
  message: 'Active workspace tab must be open'
});
export type WorkspaceSession = z.infer<typeof workspaceSessionSchema>;

export const menuCommandSchema = z.enum([
  'open-library', 'open-viewer', 'open-batch', 'open-workflow', 'open-templates', 'open-tasks', 'open-settings',
  'import-folders', 'refresh-catalog', 'select-all', 'clear-selection',
  'analyze-selection', 'generate-selection', 'open-task-center', 'open-prompt-templates',
  'toggle-original', 'fit-image', 'zoom-100', 'close-workspace', 'show-shortcuts'
]);
export type MenuCommand = z.infer<typeof menuCommandSchema>;

export const menuStateSchema = z.object({
  activeTab: workspaceTabSchema,
  hasSelection: z.boolean(),
  selectionCount: z.number().int().nonnegative(),
  hasVisionProvider: z.boolean(),
  hasGenerationProvider: z.boolean(),
  taskCount: z.number().int().nonnegative(),
  hasRunningTask: z.boolean()
});
export type MenuState = z.infer<typeof menuStateSchema>;

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

const catalogAssetBaseSchema = z.object({
  id: z.string(),
  folderId: z.string(),
  directoryId: z.string().optional(),
  fileName: z.string(),
  format: z.string(),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.number().nonnegative(),
  rating: z.number().int().min(0).max(5),
  labelColor: z.enum(['red', 'yellow', 'green', 'blue', 'purple']).nullable().default(null),
  flag: z.enum(['picked', 'rejected', 'unflagged']).default('unflagged'),
  favorite: z.boolean(),
  offline: z.boolean(),
  tags: z.array(catalogTagSchema.omit({ assetCount: true })),
  thumbnailUrl: z.string(),
  previewUrl: z.string()
});

export const fileWorkflowGroupSchema = z.object({
  id: z.string(), key: z.string(), name: z.string(),
  members: z.array(z.object({ stageId: z.string(), stageName: z.string(), variant: z.string(), asset: catalogAssetBaseSchema }))
});
export type FileWorkflowGroup = z.infer<typeof fileWorkflowGroupSchema>;
export const fileWorkflowStatusSchema = z.object({
  enabled: z.boolean(), matched: z.number(), unmatched: z.number(), conflicts: z.number()
});
export const catalogAssetSchema = catalogAssetBaseSchema.extend({
  workflow: fileWorkflowGroupSchema.optional(),
  workflowConflict: z.boolean().optional()
});

export type CatalogAsset = z.infer<typeof catalogAssetSchema>;

export const fileDetailsSchema = z.object({
  path: z.string(), sizeBytes: z.number().nonnegative(), modifiedAt: z.number().nonnegative(),
  width: z.number().positive().optional(), height: z.number().positive().optional(),
  camera: z.string().optional(), lens: z.string().optional(), takenAt: z.string().optional(),
  cameraMake: z.string().optional(), cameraModel: z.string().optional(),
  lensMake: z.string().optional(), lensModel: z.string().optional(),
  city: z.string().optional(), country: z.string().optional(),
  exposure: z.string().optional(), aperture: z.number().positive().optional(),
  exposureSeconds: z.number().positive().optional(),
  iso: z.number().positive().optional(), focalLength: z.number().positive().optional(),
  metadataWarning: z.string().optional()
});
export type FileDetails = z.infer<typeof fileDetailsSchema>;
export const quickViewSessionSchema = z.object({
  items: z.array(catalogAssetSchema), selectedId: z.string(), directory: z.string()
});
export type QuickViewSession = z.infer<typeof quickViewSessionSchema>;

export const catalogAssetCursorSchema = z.object({
  modifiedAt: z.number().nonnegative(),
  id: z.string().min(1),
  sortValue: z.union([z.string(), z.number()]).optional()
});
export type CatalogAssetCursor = z.infer<typeof catalogAssetCursorSchema>;

export const listCatalogAssetsInputSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  folderId: z.string().min(1).nullable().default(null),
  tagId: z.string().uuid().nullable().default(null),
  albumId: z.string().uuid().nullable().default(null),
  smartCollection: z.enum(['recent', 'favorites', 'unrated', 'unanalyzed', 'generated', 'to-review']).nullable().default(null),
  favoriteOnly: z.boolean().default(false),
  folderIds: z.array(z.string().min(1)).max(500).default([]),
  dateFrom: z.number().nonnegative().nullable().default(null),
  dateTo: z.number().nonnegative().nullable().default(null),
  months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u)).max(120).default([]),
  formats: z.array(z.string().min(1).max(20)).max(50).default([]),
  minimumRating: z.number().int().min(0).max(5).nullable().default(null),
  ratingOperator: z.enum(['eq', 'gte', 'lte']).default('gte'),
  flags: z.array(z.enum(['picked', 'rejected', 'unflagged'])).default([]),
  colors: z.array(z.enum(['red', 'yellow', 'green', 'blue', 'purple'])).default([]),
  sortBy: z.enum(['modifiedAt', 'fileName', 'rating']).default('modifiedAt'),
  sortDirection: z.enum(['asc', 'desc']).optional(),
  query: z.string().max(500).default(''),
  workflow: z.boolean().default(true),
  cursor: catalogAssetCursorSchema.nullable().default(null),
  limit: z.number().int().min(1).max(500).default(200)
});

export type ListCatalogAssetsInput = z.input<typeof listCatalogAssetsInputSchema>;

export const catalogAssetPageSchema = z.object({
  items: z.array(catalogAssetSchema),
  totalCount: z.number().int().nonnegative(),
  nextCursor: catalogAssetCursorSchema.nullable(),
  workflowStatus: fileWorkflowStatusSchema.optional()
});

export type CatalogAssetPage = z.infer<typeof catalogAssetPageSchema>;

export const catalogFolderSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  assetCount: z.number().int().nonnegative(),
  offlineCount: z.number().int().nonnegative(),
  parentId: z.string().nullable().default(null),
  rootId: z.string(),
  depth: z.number().int().nonnegative().default(0),
  isRoot: z.boolean().default(true)
});

export type CatalogFolder = z.infer<typeof catalogFolderSchema>;

export const renameCatalogFolderInputSchema = z.object({
  folderId: z.string().regex(/^[a-f0-9]{32}$/u),
  name: z.string().trim().min(1).max(255).refine((value) => !/[\\/]/u.test(value), 'Folder name must not contain path separators')
});
export type RenameCatalogFolderInput = z.infer<typeof renameCatalogFolderInputSchema>;
export const renameCatalogFolderResultSchema = z.object({ folder: catalogFolderSchema });
export type RenameCatalogFolderResult = z.infer<typeof renameCatalogFolderResultSchema>;

export const moveCatalogFolderInputSchema = z.object({
  sourceFolderId: z.string().regex(/^[a-f0-9]{32}$/u),
  targetFolderId: z.string().regex(/^[a-f0-9]{32}$/u)
});
export type MoveCatalogFolderInput = z.infer<typeof moveCatalogFolderInputSchema>;
export const moveCatalogFolderResultSchema = z.object({ folder: catalogFolderSchema });
export type MoveCatalogFolderResult = z.infer<typeof moveCatalogFolderResultSchema>;

export const catalogFolderSyncReportSchema = z.object({
  discovered: z.number().int().nonnegative(),
  offline: z.number().int().nonnegative()
});
export type CatalogFolderSyncReport = z.infer<typeof catalogFolderSyncReportSchema>;

export const unregisterCatalogFolderInputSchema = z.object({
  folderId: z.string().regex(/^[a-f0-9]{32}$/u)
});
export type UnregisterCatalogFolderInput = z.infer<typeof unregisterCatalogFolderInputSchema>;
export const unregisterCatalogFolderReportSchema = z.object({
  folderId: z.string().regex(/^[a-f0-9]{32}$/u),
  assetCount: z.number().int().nonnegative()
});
export type UnregisterCatalogFolderReport = z.infer<typeof unregisterCatalogFolderReportSchema>;

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
  id: z.enum(['recent', 'favorites', 'unrated', 'unanalyzed', 'generated', 'to-review']),
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
  status: z.enum(['planned', 'executing', 'compensating', 'undoing', 'completed', 'undone', 'partial', 'failed', 'compensation_failed']),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  fileNames: z.array(z.string().min(1)),
  createdAt: z.number().nonnegative(),
  completedAt: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  undoable: z.boolean()
});
export type FileOperationHistoryItem = z.infer<typeof fileOperationHistoryItemSchema>;

export const undoFileOperationInputSchema = z.object({ operationId: z.string().uuid() });
export type UndoFileOperationInput = z.infer<typeof undoFileOperationInputSchema>;
export const undoFileOperationReportSchema = z.object({
  operationId: z.string().uuid(),
  status: z.enum(['completed', 'failed']),
  total: z.number().int().nonnegative(),
  undone: z.number().int().nonnegative(),
  rolledBack: z.boolean(),
  files: z.array(z.object({
    assetId: z.string().min(1),
    previousFileName: z.string().min(1),
    fileName: z.string().min(1)
  })),
  errorCode: z.string().min(1).nullable()
});
export type UndoFileOperationReport = z.infer<typeof undoFileOperationReportSchema>;

export const updateCatalogMetadataInputSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(10_000),
  rating: z.number().int().min(0).max(5).optional(),
  labelColor: z.enum(['red', 'yellow', 'green', 'blue', 'purple']).nullable().optional(),
  flag: z.enum(['picked', 'rejected', 'unflagged']).optional(),
  favorite: z.boolean().optional()
}).refine((input) => input.rating !== undefined || input.labelColor !== undefined || input.flag !== undefined || input.favorite !== undefined, {
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

export const providerKindSchema = z.enum(['openai-compatible', 'nanobanana-compatible', 'acedata-nano-banana']);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const providerPurposeSchema = z.enum(['vision', 'generation']);
export type ProviderPurpose = z.infer<typeof providerPurposeSchema>;

const providerHeaderNameSchema = z.string().min(1).max(100).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u);
const providerHeaderValueSchema = z.string().max(2_000).refine((value) => !/[\r\n]/u.test(value));
const forbiddenProviderHeaders = new Set([
  'accept', 'authorization', 'connection', 'content-length', 'content-type', 'cookie', 'cookie2',
  'expect', 'forwarded', 'host', 'origin', 'proxy-authorization', 'referer', 'set-cookie', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto'
]);

export const providerCustomHeadersSchema = z.record(providerHeaderNameSchema, providerHeaderValueSchema)
  .refine((headers) => Object.keys(headers).length <= 20, { message: 'Too many custom headers' })
  .superRefine((headers, context) => {
    const names = new Set<string>();
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (names.has(normalized)) {
        context.addIssue({ code: 'custom', message: 'Duplicate custom header name', path: [name] });
      }
      names.add(normalized);
      if (forbiddenProviderHeaders.has(normalized) || normalized.startsWith('proxy-') || normalized.startsWith('sec-')) {
        context.addIssue({ code: 'custom', message: 'Forbidden custom header', path: [name] });
      }
    }
  });

export const providerProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  kind: providerKindSchema,
  purpose: providerPurposeSchema,
  baseUrl: z.string().url(),
  modelId: z.string().min(1).max(200),
  requestTimeoutMs: z.number().int().min(10_000).max(600_000).default(300_000),
  retryCount: z.number().int().min(0).max(5).default(2),
  customHeaders: providerCustomHeadersSchema.default({}),
  hasCredential: z.boolean(),
  enabled: z.boolean(),
  isDefault: z.boolean().optional(),
  updatedAt: z.number().nonnegative()
});

export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const saveProviderProfileInputSchema = providerProfileSchema
  .omit({ id: true, hasCredential: true, updatedAt: true })
  .extend({
    id: z.string().uuid().optional(),
    apiKey: z.string().max(10_000).optional()
  });

export type SaveProviderProfileInput = z.input<typeof saveProviderProfileInputSchema>;

export const connectionTestSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nonnegative()
});

export type ConnectionTest = z.infer<typeof connectionTestSchema>;

/** A durable, multi-step photo editing workflow planned from natural language. */
export const taskKindSchema = z.enum(['analysis', 'collection-analysis', 'generation', 'agent', 'export']);
export const taskBatchInputSchema = z.object({ kind: taskKindSchema, batchId: z.string().min(1).max(160) });
export type TaskBatchInput = z.infer<typeof taskBatchInputSchema>;
export const taskStatusSchema = z.enum([
  'draft', 'queued', 'paused', 'preparing', 'uploading', 'processing',
  'downloading', 'saving', 'completed', 'failed', 'canceled'
]);

export const persistedTaskSchema = z.object({
  id: z.string().uuid(),
  kind: taskKindSchema,
  assetId: z.string().nullable(),
  assetFileName: z.string().optional(),
  status: taskStatusSchema,
  position: z.number().int().nonnegative(),
  progress: z.number().min(0).max(1),
  attempt: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
  errorCode: z.string().nullable(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative()
});

export type PersistedTask = z.infer<typeof persistedTaskSchema>;

export const taskListCursorSchema = z.object({
  sortGroup: z.number().int().min(0).max(2),
  position: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
  id: z.string().uuid()
});
export type TaskListCursor = z.infer<typeof taskListCursorSchema>;

export const listTaskPageInputSchema = z.object({
  includeBatchMembers: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: taskListCursorSchema.nullable().default(null)
});
export type ListTaskPageInput = z.input<typeof listTaskPageInputSchema>;

export const taskPageSchema = z.object({
  items: z.array(persistedTaskSchema),
  totalCount: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  pausedCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  failedGenerationCount: z.number().int().nonnegative(),
  nextCursor: taskListCursorSchema.nullable()
});
export type TaskPage = z.infer<typeof taskPageSchema>;

export const moveQueuedTaskInputSchema = z.object({
  taskId: z.string().uuid(),
  direction: z.union([z.literal(-1), z.literal(1)])
});
export type MoveQueuedTaskInput = z.infer<typeof moveQueuedTaskInputSchema>;

export const retryFailedGenerationTasksInputSchema = z.object({
  limit: z.number().int().min(1).max(1_000).default(1_000)
});
export type RetryFailedGenerationTasksInput = z.input<typeof retryFailedGenerationTasksInputSchema>;

export const retryFailedGenerationTasksReportSchema = z.object({
  retried: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative()
});
export type RetryFailedGenerationTasksReport = z.infer<typeof retryFailedGenerationTasksReportSchema>;

export const enqueueTaskInputSchema = z.object({
  kind: taskKindSchema,
  assetId: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({})
});

export type EnqueueTaskInput = z.infer<typeof enqueueTaskInputSchema>;
export const taskIdSchema = z.string().uuid();
export const deleteTasksInputSchema = z.object({
  scope: z.enum(['task', 'batch', 'below', 'below-batches', 'batch-unfinished', 'all', 'unfinished']),
  taskId: taskIdSchema.optional(),
  orderedTaskIds: z.array(taskIdSchema).max(10_000).default([])
}).refine((input) => ['all', 'unfinished'].includes(input.scope) || Boolean(input.taskId), 'Task ID is required');
export type DeleteTasksInput = z.input<typeof deleteTasksInputSchema>;
export const taskBatchActionInputSchema = z.object({ taskId: taskIdSchema, action: z.enum(['retry', 'pause', 'resume', 'cancel']) });
export type TaskBatchActionInput = z.input<typeof taskBatchActionInputSchema>;

export const agentStepKindSchema = z.enum([
  'select', 'deduplicate', 'rank', 'rate', 'adjust', 'generate', 'move', 'delete', 'export'
]);
export type AgentStepKind = z.infer<typeof agentStepKindSchema>;

export const agentSelectionRuleSchema = z.object({
  /** Optional explicit input set. Omit to use the workspace selection. */
  assetIds: z.array(z.string().min(1)).max(10_000).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
  minimumQuality: z.number().min(0).max(100).optional(),
  excludeBlurry: z.boolean().default(false),
  excludeNearDuplicates: z.boolean().default(false),
  ranking: z.enum(['quality', 'aesthetic', 'sharpness', 'composition', 'custom']).default('aesthetic'),
  rankingInstruction: z.string().max(4_000).default('')
}).refine((rule) => !rule.assetIds || new Set(rule.assetIds).size === rule.assetIds.length, {
  message: 'Agent assetIds must be unique'
});
export type AgentSelectionRule = z.infer<typeof agentSelectionRuleSchema>;

export const agentPerAssetPromptSchema = z.object({
  assetId: z.string().min(1),
  prompt: z.string().max(50_000),
  negativePrompt: z.string().max(20_000).default(''),
  enabled: z.boolean().default(true)
});
export type AgentPerAssetPrompt = z.infer<typeof agentPerAssetPromptSchema>;

export const agentStepSchema = z.object({
  id: z.string().min(1).max(100),
  kind: agentStepKindSchema,
  instruction: z.string().max(20_000).default(''),
  selection: agentSelectionRuleSchema.optional(),
  assetIds: z.array(z.string().min(1)).max(10_000).optional(),
  rating: z.number().int().min(0).max(5).optional(),
  prompt: z.string().max(50_000).default(''),
  perAssetPrompts: z.array(agentPerAssetPromptSchema).max(10_000).default([]),
  providerProfileId: z.string().uuid().nullable().default(null),
  templateId: z.string().uuid().nullable().default(null),
  outputDirectory: z.string().trim().max(4_096).nullable().default(null),
  targetFolderId: z.string().min(1).nullable().default(null),
  confirm: z.boolean().default(false),
  style: z.string().max(500).nullable().default(null),
  dependsOn: z.array(z.string().min(1).max(100)).max(100).default([])
}).refine((step) => new Set(step.dependsOn).size === step.dependsOn.length, {
  message: 'Agent step dependencies must be unique'
});
export type AgentStep = z.infer<typeof agentStepSchema>;

export const agentTaskPayloadSchema = z.object({
  instruction: z.string().trim().min(1).max(50_000),
  globalPrompt: z.string().max(50_000).default(''),
  selection: z.preprocess((value) => value ?? {}, agentSelectionRuleSchema),
  perAssetPrompts: z.array(agentPerAssetPromptSchema).max(10_000).default([]),
  steps: z.array(agentStepSchema).min(1).max(100),
  outputDirectory: z.string().trim().max(4_096).nullable().default(null),
  confirmHighImpact: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  planVersion: z.number().int().positive().default(1)
}).superRefine((payload, context) => {
  const ids = new Set<string>();
  for (const [index, step] of payload.steps.entries()) {
    if (ids.has(step.id)) context.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: 'Agent step ids must be unique' });
    ids.add(step.id);
    if (step.kind === 'generate' && !step.providerProfileId) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'providerProfileId'], message: 'Generation steps require a provider profile' });
    }
  }
  for (const [index, step] of payload.steps.entries()) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) context.addIssue({ code: 'custom', path: ['steps', index, 'dependsOn'], message: `Unknown dependency: ${dependency}` });
    }
  }
  if (new Set(payload.perAssetPrompts.map((item) => item.assetId)).size !== payload.perAssetPrompts.length) {
    context.addIssue({ code: 'custom', path: ['perAssetPrompts'], message: 'Per-asset prompts must be unique by assetId' });
  }
});
export type AgentTaskPayload = z.infer<typeof agentTaskPayloadSchema>;

export const agentTaskResultSchema = z.object({
  selectedAssetIds: z.array(z.string().min(1)).default([]),
  removedAssetIds: z.array(z.string().min(1)).default([]),
  ratedAssetIds: z.array(z.string().min(1)).default([]),
  generatedResultIds: z.array(z.string().uuid()).default([]),
  movedAssetIds: z.array(z.string().min(1)).default([]),
  completedSteps: z.array(z.string().min(1)).default([]),
  skippedSteps: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string().max(2_000)).default([]),
  dryRun: z.boolean().default(false)
});
export type AgentTaskResult = z.infer<typeof agentTaskResultSchema>;
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
  batchId: z.string().uuid().optional(),
  locale: z.enum(['zh-CN', 'en-US']).optional(),
  providerProfileId: z.string().uuid(),
  mode: z.enum(['catalog', 'full']).default('full')
});

export const collectionAnalysisTaskPayloadSchema = z.object({
  locale: z.enum(['zh-CN', 'en-US']).optional(),
  providerProfileId: z.string().uuid(),
  assetIds: z.array(z.string().min(1)).min(2).max(200)
    .refine((items) => new Set(items).size === items.length, 'Collection assets must be unique')
});

export const collectionAnalysisReportSchema = z.object({
  summary: z.string().min(1).max(4_000),
  groups: z.array(z.object({
    title: z.string().min(1).max(200),
    assetIds: z.array(z.string().min(1)).min(2).max(100),
    reason: z.string().min(1).max(2_000)
  })).max(100),
  keepAssetIds: z.array(z.string().min(1)).max(200),
  reviewAssetIds: z.array(z.string().min(1)).max(200),
  recommendations: z.array(z.string().min(1).max(1_000)).max(100)
});
export type CollectionAnalysisReport = z.infer<typeof collectionAnalysisReportSchema>;

export const generationTaskPayloadSchema = z.object({
  submissionId: z.string().uuid().optional(),
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

export const trashedGenerationResultSchema = generationResultSchema.extend({
  trashedAt: z.number().nonnegative()
});
export type TrashedGenerationResult = z.infer<typeof trashedGenerationResultSchema>;

export const generationResultIdInputSchema = z.object({ resultId: z.string().uuid() });
export type GenerationResultIdInput = z.infer<typeof generationResultIdInputSchema>;

export const generationTrashSummarySchema = z.object({
  resultCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  missingFiles: z.number().int().nonnegative(),
  unsafePaths: z.number().int().nonnegative()
});
export type GenerationTrashSummary = z.infer<typeof generationTrashSummarySchema>;

export const emptyGenerationTrashReportSchema = z.object({
  total: z.number().int().nonnegative(),
  purged: z.number().int().nonnegative(),
  missingFiles: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative()
});
export type EmptyGenerationTrashReport = z.infer<typeof emptyGenerationTrashReportSchema>;

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

export const exportTaskPayloadSchema = z.object({
  resultIds: z.array(z.string().uuid()).min(1).max(10_000),
  destinationDirectory: z.string().trim().min(1).max(4_096),
  preset: exportPresetSchema.optional()
});

export type ExportTaskPayload = z.infer<typeof exportTaskPayloadSchema>;

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
  getFileWorkflowConfig(): Promise<FileWorkflowConfig>;
  saveFileWorkflowConfig(input: FileWorkflowConfig): Promise<FileWorkflowConfig>;
  previewFileWorkflow(input: FileWorkflowScope & { config: FileWorkflowConfig }): Promise<CatalogAssetPage>;
  onCatalogChanged(listener: () => void): () => void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  updateMenuState(state: MenuState): void;
  getAppInfo(): Promise<AppInfo>;
  getAppSettings(): Promise<AppSettings>;
  saveAppSettings(input: AppSettings): Promise<AppSettings>;
  getDiagnosticSnapshot(): Promise<DiagnosticSnapshot>;
  exportDiagnosticSnapshot(): Promise<DiagnosticExportResult>;
  runLibraryIntegrityCheck(): Promise<LibraryIntegrityReport>;
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
  undoFileOperation(input: UndoFileOperationInput): Promise<UndoFileOperationReport>;
  importFolders(): Promise<CatalogSnapshot | null>;
  relinkCatalogFolder(folderId: string): Promise<RelinkCatalogFolderResult | null>;
  renameCatalogFolder(input: RenameCatalogFolderInput): Promise<RenameCatalogFolderResult>;
  moveCatalogFolder(input: MoveCatalogFolderInput): Promise<MoveCatalogFolderResult>;
  synchronizeCatalogFolder(folderId: string): Promise<CatalogFolderSyncReport>;
  revealCatalogFolder(folderId: string): Promise<boolean>;
  unregisterCatalogFolder(input: UnregisterCatalogFolderInput): Promise<UnregisterCatalogFolderReport>;
  revealCatalogAsset(assetId: string): Promise<boolean>;
  getFileDetails(assetId: string): Promise<FileDetails>;
  openAssetExternally(assetId: string): Promise<void>;
  linkImageDirectory(assetId: string): Promise<void>;
  openImages(paths?: string[]): Promise<QuickViewSession | null>;
  takePendingOpenImages(): Promise<QuickViewSession | null>;
  onOpenImages(listener: (session: QuickViewSession) => void): () => void;
  getDroppedFilePaths(files: File[]): string[];
  listProviderProfiles(): Promise<ProviderProfile[]>;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
  deleteProviderProfile(profileId: string): Promise<void>;
  testProviderConnection(input: SaveProviderProfileInput): Promise<ConnectionTest>;
  listTaskPage(input: ListTaskPageInput): Promise<TaskPage>;
  listTaskBatch(input: TaskBatchInput): Promise<PersistedTask[]>;
  getTask(taskId: string): Promise<PersistedTask | null>;
  enqueueTask(input: EnqueueTaskInput): Promise<PersistedTask>;
  cancelTask(taskId: string): Promise<PersistedTask>;
  deleteTasks(input: DeleteTasksInput): Promise<{ deletedIds: string[] }>;
  actOnTaskBatch(input: TaskBatchActionInput): Promise<number>;
  pauseTask(taskId: string): Promise<PersistedTask>;
  resumeTask(taskId: string): Promise<PersistedTask>;
  retryTask(taskId: string): Promise<PersistedTask>;
  retryFailedTasks(): Promise<number>;
  moveQueuedTask(input: MoveQueuedTaskInput): Promise<PersistedTask>;
  retryFailedGenerationTasks(input?: RetryFailedGenerationTasksInput): Promise<RetryFailedGenerationTasksReport>;
  updateQueuedGenerationTask(input: UpdateQueuedGenerationTaskInput): Promise<PersistedTask>;
  updateQueuedGenerationTasks(input: UpdateQueuedGenerationTasksInput): Promise<PersistedTask[]>;
  resizeQueuedGenerationBatch(input: ResizeQueuedGenerationBatchInput): Promise<PersistedTask[]>;
  listPromptTemplates(): Promise<PromptTemplate[]>;
  savePromptTemplate(input: SavePromptTemplateInput): Promise<PromptTemplate>;
  archivePromptTemplate(templateId: string): Promise<void>;
  listAnalysisRevisions(assetId: string): Promise<AnalysisRevision[]>;
  listGenerationResults(assetId: string): Promise<GenerationResult[]>;
  listTrashedGenerationResults(assetId: string): Promise<TrashedGenerationResult[]>;
  trashGenerationResult(input: GenerationResultIdInput): Promise<TrashedGenerationResult>;
  restoreGenerationResult(input: GenerationResultIdInput): Promise<GenerationResult>;
  getGenerationTrashSummary(): Promise<GenerationTrashSummary>;
  emptyGenerationTrash(): Promise<EmptyGenerationTrashReport>;
  updateGenerationResultReview(input: UpdateGenerationResultReviewInput): Promise<GenerationResult>;
  revealGenerationResult(resultId: string): Promise<boolean>;
  exportGenerationResults(input: ExportGenerationResultsInput): Promise<PersistedTask | null>;
  revealExportDestination(taskId: string): Promise<boolean>;
  listExportPresets(): Promise<ExportPreset[]>;
  saveExportPreset(input: SaveExportPresetInput): Promise<ExportPreset>;
  deleteExportPreset(presetId: string): Promise<void>;
  getImageCacheStats(): Promise<ImageCacheStats>;
  pruneImageCache(input: z.input<typeof pruneImageCacheInputSchema>): Promise<{ removedFiles: number; removedBytes: number }>;
}
