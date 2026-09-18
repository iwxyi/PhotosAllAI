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

export const catalogAssetSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  format: z.string(),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.number().nonnegative(),
  thumbnailUrl: z.string(),
  previewUrl: z.string()
});

export type CatalogAsset = z.infer<typeof catalogAssetSchema>;

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

export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
  listCatalogAssets(): Promise<CatalogAsset[]>;
  importFolders(): Promise<CatalogSnapshot | null>;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
  testProviderConnection(input: SaveProviderProfileInput): Promise<ConnectionTest>;
  listTasks(): Promise<PersistedTask[]>;
  enqueueTask(input: EnqueueTaskInput): Promise<PersistedTask>;
  cancelTask(taskId: string): Promise<PersistedTask>;
  retryTask(taskId: string): Promise<PersistedTask>;
  reorderTasks(taskIds: string[]): Promise<PersistedTask[]>;
}
