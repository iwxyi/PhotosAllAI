import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  generationResultSchema,
  generationTaskPayloadSchema,
  type GenerationResult,
  type UpdateGenerationResultReviewInput,
  updateGenerationResultReviewInputSchema,
  type ProviderProfile
} from '@photoallisai/contracts';

import type { CatalogService } from './catalog-service';
import type { ImageCacheService } from './image-cache-service';
import type { ProviderService, ResolvedProvider } from './provider-service';

type ProviderResolver = Pick<ProviderService, 'resolve'>;
type GenerationImageSource = Pick<ImageCacheService, 'getOrCreate'>;
type CatalogSource = Pick<CatalogService, 'resolveAssetFile'>;

type ResultRow = {
  id: string;
  asset_id: string;
  batch_id: string;
  version: number;
  file_name: string;
  file_path: string;
  prompt: string;
  provider_profile_id: string;
  template_id: string | null;
  template_version: number | null;
  storage_mode: 'managed' | 'portable';
  review_state: GenerationResult['reviewState'];
  created_at: number;
};

const MAX_RESULT_BYTES = 50 * 1024 * 1024;

export class GenerationService {
  readonly #database: DatabaseSync;
  readonly #generatedDirectory: string;
  readonly #providers: ProviderResolver;
  readonly #images: GenerationImageSource;
  readonly #catalog: CatalogSource;

  constructor(
    databasePath: string,
    generatedDirectory: string,
    providers: ProviderResolver,
    images: GenerationImageSource,
    catalog: CatalogSource
  ) {
    this.#generatedDirectory = generatedDirectory;
    this.#providers = providers;
    this.#images = images;
    this.#catalog = catalog;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS generation_results (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL,
        template_id TEXT,
        template_version INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(asset_id, version)
      );
      CREATE INDEX IF NOT EXISTS generation_asset_idx
        ON generation_results(asset_id, version DESC);
    `);
    const columns = this.#database.prepare('PRAGMA table_info(generation_results)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'review_state')) {
      this.#database.exec("ALTER TABLE generation_results ADD COLUMN review_state TEXT NOT NULL DEFAULT 'undecided' CHECK(review_state IN ('undecided', 'accepted', 'rejected', 'preferred'))");
    }
    if (!columns.some((column) => column.name === 'storage_mode')) {
      this.#database.exec("ALTER TABLE generation_results ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'managed' CHECK(storage_mode IN ('managed', 'portable'))");
    }
  }

  close(): void {
    this.#database.close();
  }

  list(assetId: string): GenerationResult[] {
    return (this.#database.prepare(`
      SELECT * FROM generation_results WHERE asset_id = ? ORDER BY version DESC
    `).all(assetId) as ResultRow[]).map((row) => this.#toResult(row));
  }

  resolveResultFile(resultId: string): string | null {
    const row = this.#database.prepare('SELECT file_path FROM generation_results WHERE id = ?').get(resultId) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  updateReview(rawInput: UpdateGenerationResultReviewInput): GenerationResult {
    const input = updateGenerationResultReviewInputSchema.parse(rawInput);
    const row = this.#database.prepare('SELECT asset_id FROM generation_results WHERE id = ?').get(input.resultId) as { asset_id: string } | undefined;
    if (!row) throw new Error('GENERATION_RESULT_NOT_FOUND');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (input.reviewState === 'preferred') {
        this.#database.prepare(`UPDATE generation_results SET review_state = 'accepted' WHERE asset_id = ? AND review_state = 'preferred'`).run(row.asset_id);
      }
      this.#database.prepare('UPDATE generation_results SET review_state = ? WHERE id = ?').run(input.reviewState, input.resultId);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    const updated = this.#database.prepare('SELECT * FROM generation_results WHERE id = ?').get(input.resultId) as ResultRow;
    return this.#toResult(updated);
  }

  async generate(assetId: string, rawPayload: unknown, signal?: AbortSignal): Promise<GenerationResult> {
    const payload = generationTaskPayloadSchema.parse(rawPayload);
    const provider = await this.#providers.resolve(payload.providerProfileId);
    if (provider.profile.purpose !== 'generation') throw new Error('PROVIDER_DOES_NOT_SUPPORT_GENERATION');
    const source = this.#catalog.resolveAssetFile(assetId);
    if (!source) throw new Error('ASSET_NOT_FOUND');
    const previewPath = await this.#images.getOrCreate(assetId, 'preview');
    if (!previewPath) throw new Error('ASSET_PREVIEW_NOT_FOUND');
    const inputImage = await readFile(previewPath);

    const bytes = await requestGeneratedImage(provider, payload.prompt, inputImage, signal);
    signal?.throwIfAborted();
    const format = detectImageFormat(bytes);
    const id = randomUUID();
    const maximum = this.#database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS value FROM generation_results WHERE asset_id = ?
    `).get(assetId) as { value: number };
    const version = maximum.value + 1;
    const originalStem = sanitizeFileStem(path.parse(source.fileName).name);
    const shortId = id.replaceAll('-', '').slice(0, 8).toUpperCase();
    const fileName = `${originalStem}__ai__v${String(version).padStart(4, '0')}__${shortId}.${format}`;
    const batchDirectory = payload.storageMode === 'portable'
      ? path.join(path.dirname(source.path), '_PhotoAllIsAI', `${originalStem}__${assetId.replaceAll('-', '').slice(0, 8).toUpperCase()}`, payload.batchId)
      : path.join(this.#generatedDirectory, assetId.slice(0, 2), assetId, payload.batchId);
    const filePath = path.join(batchDirectory, fileName);
    await mkdir(batchDirectory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, filePath);

    const createdAt = Date.now();
    try {
      signal?.throwIfAborted();
      this.#database.prepare(`
        INSERT INTO generation_results (
          id, asset_id, batch_id, version, file_name, file_path, prompt,
          provider_profile_id, template_id, template_version, storage_mode, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, assetId, payload.batchId, version, fileName, filePath, payload.prompt,
        payload.providerProfileId, payload.templateId, payload.templateVersion, payload.storageMode, createdAt
      );
      await this.#writeManifest(batchDirectory, assetId, payload.batchId, provider.profile, payload.storageMode);
    } catch (error) {
      this.#database.prepare('DELETE FROM generation_results WHERE id = ?').run(id);
      await unlink(filePath).catch(() => undefined);
      throw error;
    }

    return generationResultSchema.parse({
      id, assetId, batchId: payload.batchId, version, fileName,
      resultUrl: `photoresult://result/${id}`, prompt: payload.prompt,
      providerProfileId: payload.providerProfileId, templateId: payload.templateId,
      templateVersion: payload.templateVersion, storageMode: payload.storageMode,
      reviewState: 'undecided', createdAt
    });
  }

  async #writeManifest(directory: string, assetId: string, batchId: string, profile: ProviderProfile, storageMode: 'managed' | 'portable'): Promise<void> {
    const rows = this.#database.prepare(`
      SELECT id, version, file_name, created_at FROM generation_results
      WHERE batch_id = ? ORDER BY version ASC
    `).all(batchId);
    const manifest = {
      schemaVersion: '1.0', assetId, batchId, storageMode,
      provider: { profileId: profile.id, modelId: profile.modelId },
      results: rows
    };
    const destination = path.join(directory, 'manifest.json');
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(temporary, destination);
  }

  #toResult(row: ResultRow): GenerationResult {
    return generationResultSchema.parse({
      id: row.id, assetId: row.asset_id, batchId: row.batch_id, version: row.version,
      fileName: row.file_name, resultUrl: `photoresult://result/${row.id}`,
      prompt: row.prompt, providerProfileId: row.provider_profile_id,
      templateId: row.template_id, templateVersion: row.template_version, reviewState: row.review_state, createdAt: row.created_at
      , storageMode: row.storage_mode
    });
  }
}

async function requestGeneratedImage(
  provider: ResolvedProvider,
  prompt: string,
  inputImage: Buffer,
  signal?: AbortSignal
): Promise<Buffer> {
  const response = await fetch(`${provider.profile.baseUrl}/images/edits`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    redirect: 'error',
    signal: signal ?? null,
    body: JSON.stringify({
      model: provider.profile.modelId,
      prompt,
      n: 1,
      image: { mime_type: 'image/jpeg', data: inputImage.toString('base64') }
    })
  });
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
  const body = await response.text();
  if (body.length > MAX_RESULT_BYTES * 1.5) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  const payload: unknown = JSON.parse(body);
  const candidate = extractImageCandidate(payload);
  if (candidate.base64) {
    const bytes = Buffer.from(candidate.base64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESULT_BYTES) throw new Error('GENERATED_IMAGE_INVALID_SIZE');
    return bytes;
  }
  if (!candidate.url) throw new Error('PROVIDER_IMAGE_MISSING');
  const url = new URL(candidate.url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('GENERATED_IMAGE_URL_UNSAFE');
  if (!local) {
    const addresses = await lookup(url.hostname, { all: true });
    if (addresses.some((address) => isPrivateAddress(address.address))) throw new Error('GENERATED_IMAGE_URL_PRIVATE');
  }
  const download = await fetch(url, { redirect: 'error', signal: signal ?? null });
  if (!download.ok) throw new Error(`GENERATED_IMAGE_HTTP_${download.status}`);
  const length = Number(download.headers.get('content-length') ?? '0');
  if (length > MAX_RESULT_BYTES) throw new Error('GENERATED_IMAGE_TOO_LARGE');
  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESULT_BYTES) throw new Error('GENERATED_IMAGE_INVALID_SIZE');
  return bytes;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === 'localhost' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function extractImageCandidate(value: unknown): { base64?: string; url?: string } {
  if (typeof value !== 'object' || value === null) return {};
  const response = value as Record<string, unknown>;
  const collections = ['data', 'images'] as const;
  for (const key of collections) {
    const collection = response[key];
    if (!Array.isArray(collection) || collection.length === 0) continue;
    const item: unknown = collection[0];
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;
    for (const field of ['b64_json', 'base64', 'data'] as const) {
      if (typeof candidate[field] === 'string') return { base64: candidate[field] };
    }
    if (typeof candidate.url === 'string') return { url: candidate.url };
  }
  return {};
}

function detectImageFormat(bytes: Buffer): 'png' | 'jpg' | 'webp' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'jpg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new Error('GENERATED_IMAGE_FORMAT_UNSUPPORTED');
}

function sanitizeFileStem(value: string): string {
  const invalidCharacters = '<>:"/\\|?*';
  const sanitized = [...value]
    .map((character) => character.charCodeAt(0) < 32 || invalidCharacters.includes(character) ? '_' : character)
    .join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return sanitized || 'image';
}
