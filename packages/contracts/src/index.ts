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

export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
  listCatalogAssets(): Promise<CatalogAsset[]>;
  importFolders(): Promise<CatalogSnapshot | null>;
}
