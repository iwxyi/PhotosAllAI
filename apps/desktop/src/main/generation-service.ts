import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  generationResultSchema,
  generationTaskPayloadSchema,
  generationTrashSummarySchema,
  emptyGenerationTrashReportSchema,
  trashedGenerationResultSchema,
  type GenerationResult,
  type GenerationTrashSummary,
  type EmptyGenerationTrashReport,
  type TrashedGenerationResult,
  type UpdateGenerationResultReviewInput,
  updateGenerationResultReviewInputSchema,
  type ProviderProfile
} from '@photoallisai/contracts';

import type { CatalogService } from './catalog-service';
import type { ImageCacheService } from './image-cache-service';
import { downloadPinned, fetchBounded, isPrivateNetworkAddress } from './network-safety';
import type { ProviderService, ResolvedProvider } from './provider-service';
import { createProviderRequestHeaders } from './provider-request-headers';
import { publishTemporaryFileSafely } from './safe-file-write';

type ProviderResolver = Pick<ProviderService, 'resolve'>;
type GenerationImageSource = Pick<ImageCacheService, 'getOrCreate'>;
type CatalogSource = Pick<CatalogService, 'resolveAssetFile'>;
type TemporaryFilePublisher = typeof publishTemporaryFileSafely;
type VerifiedFileMover = typeof moveFileVerified;

type ResultRow = {
  id: string;
  asset_id: string;
  batch_id: string;
  input_sources: string | null;
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
  trashed_at: number | null;
  trash_path: string | null;
  purge_path: string | null;
};

type GenerationWriteIntentRow = {
  result_id: string;
  asset_id: string;
  batch_id: string;
  file_name: string;
  file_path: string;
  temporary_path: string;
  storage_mode: 'managed' | 'portable';
};

export type TrashPurgeRecoveryReport = {
  total: number;
  recovered: number;
  conflicts: number;
  failed: number;
};

export type GenerationWriteRecoveryReport = {
  total: number;
  recovered: number;
  failed: number;
};

const MAX_RESULT_BYTES = 50 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 75 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 5 * 60 * 1_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1_000;

export class GenerationService {
  readonly #database: DatabaseSync;
  readonly #generatedDirectory: string;
  readonly #trashDirectory: string;
  readonly #providers: ProviderResolver;
  readonly #images: GenerationImageSource;
  readonly #catalog: CatalogSource;
  readonly #publishTemporaryFile: TemporaryFilePublisher;
  readonly #moveFile: VerifiedFileMover;

  constructor(
    databasePath: string,
    generatedDirectory: string,
    providers: ProviderResolver,
    images: GenerationImageSource,
    catalog: CatalogSource,
    publishTemporaryFile: TemporaryFilePublisher = publishTemporaryFileSafely,
    moveFile: VerifiedFileMover = moveFileVerified
  ) {
    this.#generatedDirectory = generatedDirectory;
    this.#trashDirectory = path.resolve(path.dirname(generatedDirectory), 'trash', 'generation');
    this.#providers = providers;
    this.#images = images;
    this.#catalog = catalog;
    this.#publishTemporaryFile = publishTemporaryFile;
    this.#moveFile = moveFile;
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
      CREATE TABLE IF NOT EXISTS generation_write_intents (
        result_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        temporary_path TEXT NOT NULL,
        storage_mode TEXT NOT NULL CHECK(storage_mode IN ('managed', 'portable')),
        created_at INTEGER NOT NULL
      );
    `);
    const columns = this.#database.prepare('PRAGMA table_info(generation_results)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'review_state')) {
      this.#database.exec("ALTER TABLE generation_results ADD COLUMN review_state TEXT NOT NULL DEFAULT 'undecided' CHECK(review_state IN ('undecided', 'accepted', 'rejected', 'preferred'))");
    }
    if (!columns.some((column) => column.name === 'storage_mode')) {
      this.#database.exec("ALTER TABLE generation_results ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'managed' CHECK(storage_mode IN ('managed', 'portable'))");
    }
    if (!columns.some((column) => column.name === 'trashed_at')) {
      this.#database.exec('ALTER TABLE generation_results ADD COLUMN trashed_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'trash_path')) {
      this.#database.exec('ALTER TABLE generation_results ADD COLUMN trash_path TEXT');
    }
    if (!columns.some((column) => column.name === 'purge_path')) {
      this.#database.exec('ALTER TABLE generation_results ADD COLUMN purge_path TEXT');
    }
    if (!columns.some((column) => column.name === 'input_sources')) {
      this.#database.exec('ALTER TABLE generation_results ADD COLUMN input_sources TEXT');
    }
  }

  close(): void {
    this.#database.close();
  }

  list(assetId: string): GenerationResult[] {
    return (this.#database.prepare(`
      SELECT * FROM generation_results WHERE asset_id = ? AND trashed_at IS NULL ORDER BY version DESC
    `).all(assetId) as ResultRow[]).map((row) => this.#toResult(row));
  }

  listTrashed(assetId: string): TrashedGenerationResult[] {
    return (this.#database.prepare(`
      SELECT * FROM generation_results WHERE asset_id = ? AND trashed_at IS NOT NULL ORDER BY trashed_at DESC
    `).all(assetId) as ResultRow[]).map((row) => trashedGenerationResultSchema.parse({
      ...this.#toResult(row),
      trashedAt: row.trashed_at
    }));
  }

  resolveResultFile(resultId: string): string | null {
    const row = this.#database.prepare('SELECT file_path FROM generation_results WHERE id = ? AND trashed_at IS NULL').get(resultId) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  async trash(resultId: string): Promise<TrashedGenerationResult> {
    const row = this.#findResult(resultId);
    if (row.trashed_at !== null) throw new Error('GENERATION_RESULT_ALREADY_TRASHED');
    if (!await pathExists(row.file_path)) throw new Error('GENERATION_RESULT_FILE_NOT_FOUND');
    const trashPath = path.join(path.dirname(this.#generatedDirectory), 'trash', 'generation', row.id, row.file_name);
    if (await pathExists(trashPath)) throw new Error('GENERATION_RESULT_TRASH_CONFLICT');
    await mkdir(path.dirname(trashPath), { recursive: true });
    await this.#moveFile(row.file_path, trashPath);
    const trashedAt = Date.now();
    try {
      const result = this.#database.prepare(`
        UPDATE generation_results SET trashed_at = ?, trash_path = ? WHERE id = ? AND trashed_at IS NULL
      `).run(trashedAt, trashPath, resultId);
      if (result.changes !== 1) throw new Error('GENERATION_RESULT_CONCURRENT_CHANGE');
      await this.#refreshManifest(path.dirname(row.file_path), row.asset_id, row.batch_id);
    } catch (error) {
      this.#database.prepare(`
        UPDATE generation_results SET trashed_at = NULL, trash_path = NULL
        WHERE id = ? AND trash_path = ?
      `).run(resultId, trashPath);
      try {
        await this.#moveFile(trashPath, row.file_path);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'GENERATION_TRASH_ROLLBACK_FAILED');
      }
      throw error;
    }
    return trashedGenerationResultSchema.parse({ ...this.#toResult(row), trashedAt });
  }

  async restore(resultId: string): Promise<GenerationResult> {
    const row = this.#findResult(resultId);
    if (row.trashed_at === null || !row.trash_path) throw new Error('GENERATION_RESULT_NOT_TRASHED');
    if (row.purge_path || (await this.#findLegacyPurgePaths(row)).length > 0) {
      throw new Error('GENERATION_RESULT_PURGE_PENDING');
    }
    const trashFile = await inspectPurgeFile(row.trash_path, this.#trashDirectory);
    if (trashFile === null) throw new Error('GENERATION_RESULT_TRASH_FILE_NOT_FOUND');
    if (trashFile === false) throw new Error('GENERATION_RESULT_TRASH_PATH_UNSAFE');
    if (await pathExists(row.file_path)) throw new Error('GENERATION_RESULT_RESTORE_CONFLICT');
    await mkdir(path.dirname(row.file_path), { recursive: true });
    await this.#moveFile(row.trash_path, row.file_path);
    try {
      const result = this.#database.prepare(`
        UPDATE generation_results SET trashed_at = NULL, trash_path = NULL WHERE id = ? AND trashed_at IS NOT NULL
      `).run(resultId);
      if (result.changes !== 1) throw new Error('GENERATION_RESULT_CONCURRENT_CHANGE');
      await this.#refreshManifest(path.dirname(row.file_path), row.asset_id, row.batch_id);
    } catch (error) {
      this.#database.prepare(`
        UPDATE generation_results SET trashed_at = ?, trash_path = ?
        WHERE id = ? AND trashed_at IS NULL
      `).run(row.trashed_at, row.trash_path, resultId);
      try {
        await this.#moveFile(row.file_path, row.trash_path);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'GENERATION_RESTORE_ROLLBACK_FAILED');
      }
      throw error;
    }
    await rmdir(path.dirname(row.trash_path)).catch(() => undefined);
    return this.#toResult({ ...row, trashed_at: null, trash_path: null });
  }

  async getTrashSummary(): Promise<GenerationTrashSummary> {
    const rows = this.#database.prepare(`
      SELECT * FROM generation_results WHERE trashed_at IS NOT NULL ORDER BY trashed_at ASC
    `).all() as ResultRow[];
    let totalBytes = 0;
    let missingFiles = 0;
    let unsafePaths = 0;
    for (const row of rows) {
      if (!this.#isSafeTrashPath(row)) {
        unsafePaths += 1;
        continue;
      }
      try {
        const file = await lstat(row.trash_path!);
        if (!file.isFile()) unsafePaths += 1;
        else totalBytes += file.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missingFiles += 1;
        else unsafePaths += 1;
      }
    }
    return generationTrashSummarySchema.parse({ resultCount: rows.length, totalBytes, missingFiles, unsafePaths });
  }

  async emptyTrash(): Promise<EmptyGenerationTrashReport> {
    const interrupted = await this.recoverInterruptedTrashPurges();
    const rows = this.#database.prepare(`
      SELECT * FROM generation_results WHERE trashed_at IS NOT NULL ORDER BY trashed_at ASC
    `).all() as ResultRow[];
    let purged = interrupted.recovered;
    let missingFiles = 0;
    let failed = interrupted.failed + interrupted.conflicts;
    let freedBytes = 0;
    for (const row of rows) {
      if (!this.#isSafeTrashPath(row)) {
        failed += 1;
        continue;
      }
      const trashPath = row.trash_path!;
      if (row.purge_path || (await this.#findLegacyPurgePaths(row)).length > 0) continue;
      const stagedPath = this.#deterministicPurgePath(row);
      try {
        const file = await inspectPurgeFile(trashPath, this.#trashDirectory);
        if (file === null) {
          missingFiles += 1;
          if (this.#database.prepare('DELETE FROM generation_results WHERE id = ? AND trashed_at IS NOT NULL AND purge_path IS NULL').run(row.id).changes !== 1) {
            failed += 1;
            continue;
          }
          purged += 1;
          await rmdir(path.dirname(trashPath)).catch(() => undefined);
          continue;
        }
        if (file === false) {
          failed += 1;
          continue;
        }
        const intent = this.#database.prepare(`
          UPDATE generation_results SET purge_path = ?
          WHERE id = ? AND trashed_at IS NOT NULL AND purge_path IS NULL
        `).run(stagedPath, row.id);
        if (intent.changes !== 1) {
          failed += 1;
          continue;
        }
        await rename(trashPath, stagedPath);
        await unlink(stagedPath);
        if (this.#removePurgedRecord(row.id, stagedPath) !== 1) throw new Error('GENERATION_RESULT_CONCURRENT_CHANGE');
        purged += 1;
        freedBytes += Number(file.size);
        await rmdir(path.dirname(trashPath)).catch(() => undefined);
      } catch {
        failed += 1;
      }
    }
    return emptyGenerationTrashReportSchema.parse({ total: rows.length + interrupted.recovered, purged, missingFiles, failed, freedBytes });
  }

  async recoverInterruptedTrashPurges(): Promise<TrashPurgeRecoveryReport> {
    const rows = this.#database.prepare(`
      SELECT * FROM generation_results WHERE trashed_at IS NOT NULL ORDER BY trashed_at ASC
    `).all() as ResultRow[];
    let total = 0;
    let recovered = 0;
    let conflicts = 0;
    let failed = 0;
    for (const row of rows) {
      if (!this.#isSafeTrashPath(row)) continue;
      const trashPath = row.trash_path!;
      let stagedPath = row.purge_path;
      if (stagedPath && !this.#isSafePurgePath(row, stagedPath)) {
        total += 1;
        failed += 1;
        continue;
      }
      if (!stagedPath) {
        const legacyCandidates = await this.#findLegacyPurgePaths(row);
        if (legacyCandidates.length > 1) {
          total += 1;
          conflicts += 1;
          continue;
        }
        stagedPath = legacyCandidates[0] ?? null;
      }
      if (!stagedPath) continue;
      total += 1;
      const [trashFile, stagedFile] = await Promise.all([
        inspectPurgeFile(trashPath, this.#trashDirectory),
        inspectPurgeFile(stagedPath, this.#trashDirectory)
      ]);
      if (trashFile === false || stagedFile === false) {
        failed += 1;
        continue;
      }
      if (trashFile && stagedFile) {
        conflicts += 1;
        continue;
      }
      try {
        if (!row.purge_path) {
          const claimed = this.#database.prepare(`
            UPDATE generation_results SET purge_path = ?
            WHERE id = ? AND trashed_at IS NOT NULL AND purge_path IS NULL
          `).run(stagedPath, row.id);
          if (claimed.changes !== 1) throw new Error('GENERATION_RESULT_CONCURRENT_CHANGE');
        }
        if (trashFile) await rename(trashPath, stagedPath);
        if (stagedFile || trashFile) await unlink(stagedPath);
        if (this.#removePurgedRecord(row.id, stagedPath) !== 1) throw new Error('GENERATION_RESULT_CONCURRENT_CHANGE');
        recovered += 1;
        await rmdir(path.dirname(trashPath)).catch(() => undefined);
      } catch {
        failed += 1;
      }
    }
    return { total, recovered, conflicts, failed };
  }

  async recoverInterruptedWrites(): Promise<GenerationWriteRecoveryReport> {
    const rows = this.#database.prepare(`
      SELECT result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode
      FROM generation_write_intents ORDER BY created_at ASC
    `).all() as GenerationWriteIntentRow[];
    let recovered = 0;
    let failed = 0;
    for (const row of rows) {
      const directory = this.#expectedResultDirectory(row.asset_id, row.batch_id, row.storage_mode);
      if (!directory || path.basename(row.file_name) !== row.file_name
        || path.resolve(row.file_path) !== path.resolve(directory, row.file_name)
        || !isGenerationTemporaryPath(row.temporary_path, row.file_path)
        || !await this.#isSafeResultDirectory(row.asset_id, row.storage_mode, directory)) {
        failed += 1;
        continue;
      }
      try {
        for (const candidate of [row.temporary_path, row.file_path]) {
          const entry = await inspectOptionalRegularFile(candidate);
          if (entry === false) throw new Error('GENERATION_WRITE_RECOVERY_PATH_UNSAFE');
          if (entry) await unlink(candidate);
        }
        this.#database.prepare('DELETE FROM generation_results WHERE id = ?').run(row.result_id);
        if (await pathExists(path.join(directory, 'manifest.json'))) {
          await this.#refreshManifest(directory, row.asset_id, row.batch_id);
        }
        if (this.#database.prepare('DELETE FROM generation_write_intents WHERE result_id = ?').run(row.result_id).changes !== 1) {
          throw new Error('GENERATION_WRITE_INTENT_CONCURRENT_CHANGE');
        }
        recovered += 1;
        await rmdir(directory).catch(() => undefined);
      } catch {
        failed += 1;
      }
    }
    return { total: rows.length, recovered, failed };
  }

  async relocatePortableResults(
    assetId: string,
    previousSourcePath: string,
    nextSourcePath: string,
    previousFileName: string,
    nextFileName: string
  ): Promise<void> {
    const rows = this.#database.prepare(`
      SELECT id, batch_id, file_name, file_path, trashed_at FROM generation_results
      WHERE asset_id = ? AND storage_mode = 'portable'
    `).all(assetId) as Array<{ id: string; batch_id: string; file_name: string; file_path: string; trashed_at: number | null }>;
    const intents = this.#database.prepare(`
      SELECT result_id, batch_id, file_name, file_path, temporary_path
      FROM generation_write_intents WHERE asset_id = ? AND storage_mode = 'portable'
    `).all(assetId) as Array<Pick<GenerationWriteIntentRow, 'result_id' | 'batch_id' | 'file_name' | 'file_path' | 'temporary_path'>>;
    if (rows.length === 0 && intents.length === 0) return;

    const shortAssetId = assetId.replaceAll('-', '').slice(0, 8).toUpperCase();
    const previousDirectory = path.join(
      path.dirname(previousSourcePath), '_PhotoAllIsAI',
      `${sanitizeFileStem(path.parse(previousFileName).name)}__${shortAssetId}`
    );
    const nextDirectory = path.join(
      path.dirname(nextSourcePath), '_PhotoAllIsAI',
      `${sanitizeFileStem(path.parse(nextFileName).name)}__${shortAssetId}`
    );
    let directoryRelocated = previousDirectory === nextDirectory;
    if (!directoryRelocated) {
      const previousExists = await pathExists(previousDirectory);
      const nextExists = await pathExists(nextDirectory);
      if (previousExists && !nextExists) {
        await mkdir(path.dirname(nextDirectory), { recursive: true });
        await rename(previousDirectory, nextDirectory);
        directoryRelocated = true;
      }
    }

    const update = this.#database.prepare('UPDATE generation_results SET file_path = ? WHERE id = ?');
    for (const row of rows) {
      const candidate = path.join(nextDirectory, row.batch_id, row.file_name);
      if (row.trashed_at !== null || await pathExists(candidate)) update.run(candidate, row.id);
    }
    const updateIntent = this.#database.prepare(`
      UPDATE generation_write_intents SET file_path = ?, temporary_path = ? WHERE result_id = ?
    `);
    for (const intent of intents) {
      const candidate = path.join(nextDirectory, intent.batch_id, intent.file_name);
      const temporary = path.join(path.dirname(candidate), path.basename(intent.temporary_path));
      if (directoryRelocated || await pathExists(candidate) || await pathExists(temporary)) {
        updateIntent.run(candidate, temporary, intent.result_id);
      }
    }
  }

  updateReview(rawInput: UpdateGenerationResultReviewInput): GenerationResult {
    const input = updateGenerationResultReviewInputSchema.parse(rawInput);
    const row = this.#database.prepare('SELECT asset_id FROM generation_results WHERE id = ? AND trashed_at IS NULL').get(input.resultId) as { asset_id: string } | undefined;
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
    if (payload.sourceResultId && payload.inputSources) throw new Error('GENERATION_INPUTS_CONFLICT');
    const inputSources = payload.inputSources ?? (payload.sourceResultId ? [{ kind: 'result' as const, resultId: payload.sourceResultId }] : [{ kind: 'asset' as const, assetId }]);
    if (inputSources[0]?.kind === 'asset' && inputSources[0].assetId !== assetId) throw new Error('GENERATION_PRIMARY_SOURCE_INVALID');
    const primarySource = inputSources[0]!;
    if (primarySource.kind === 'result' && !this.list(assetId).some((result) => result.id === primarySource.resultId)) throw new Error('GENERATION_SOURCE_RESULT_INVALID');
    if (new Set(inputSources.map((input) => input.kind === 'asset' ? `asset:${input.assetId}` : `result:${input.resultId}`)).size !== inputSources.length) throw new Error('GENERATION_DUPLICATE_INPUT');
    const inputs = await Promise.all(inputSources.map(async (input) => {
      if (input.kind === 'asset') {
        if (!this.#catalog.resolveAssetFile(input.assetId)) throw new Error('GENERATION_INPUT_ASSET_NOT_FOUND');
        const file = await this.#images.getOrCreate(input.assetId, 'preview');
        if (!file) throw new Error('ASSET_PREVIEW_NOT_FOUND');
        return { bytes: await readFile(file), mime: 'image/jpeg' };
      }
      const file = this.resolveResultFile(input.resultId);
      if (!file) throw new Error('GENERATION_INPUT_RESULT_NOT_FOUND');
      const bytes = await readFile(file);
      const format = detectImageFormat(bytes);
      return { bytes, mime: format === 'jpg' ? 'image/jpeg' : `image/${format}` };
    }));
    if (inputs.reduce((total, input) => total + input.bytes.byteLength, 0) > 50 * 1024 * 1024) throw new Error('GENERATION_INPUTS_TOO_LARGE');
    const bytes = await requestGeneratedImage(provider, payload.prompt, inputs, signal);
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
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const createdAt = Date.now();
    this.#database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, assetId, payload.batchId, fileName, filePath, temporaryPath, payload.storageMode, createdAt);
    let published = false;
    try {
      await mkdir(batchDirectory, { recursive: true });
      await writeFile(temporaryPath, bytes, { flag: 'wx' });
      await this.#publishTemporaryFile(filePath, temporaryPath);
      published = true;
      signal?.throwIfAborted();
      this.#database.prepare(`
        INSERT INTO generation_results (
          id, asset_id, batch_id, version, file_name, file_path, prompt,
          provider_profile_id, template_id, template_version, storage_mode, input_sources, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, assetId, payload.batchId, version, fileName, filePath, payload.prompt,
        payload.providerProfileId, payload.templateId, payload.templateVersion, payload.storageMode, JSON.stringify(inputSources), createdAt
      );
      await this.#writeManifest(batchDirectory, assetId, payload.batchId, provider.profile, payload.storageMode);
      if (this.#database.prepare('DELETE FROM generation_write_intents WHERE result_id = ?').run(id).changes !== 1) {
        throw new Error('GENERATION_WRITE_INTENT_CONCURRENT_CHANGE');
      }
    } catch (error) {
      this.#database.prepare('DELETE FROM generation_results WHERE id = ?').run(id);
      let cleanupFailed = false;
      await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== 'ENOENT') cleanupFailed = true;
      });
      if (published && !await unlinkPublishedResultIfMatching(filePath, bytes)) cleanupFailed = true;
      if (await pathExists(path.join(batchDirectory, 'manifest.json'))) {
        await this.#refreshManifest(batchDirectory, assetId, payload.batchId).catch(() => { cleanupFailed = true; });
      }
      if (!cleanupFailed) this.#database.prepare('DELETE FROM generation_write_intents WHERE result_id = ?').run(id);
      throw error;
    }

    return generationResultSchema.parse({
      id, assetId, batchId: payload.batchId, inputSources, version, fileName,
      resultUrl: `photoresult://result/${id}`, prompt: payload.prompt,
      providerProfileId: payload.providerProfileId, templateId: payload.templateId,
      templateVersion: payload.templateVersion, storageMode: payload.storageMode,
      reviewState: 'undecided', createdAt
    });
  }

  async #writeManifest(directory: string, assetId: string, batchId: string, profile: ProviderProfile, storageMode: 'managed' | 'portable'): Promise<void> {
    const rows = this.#database.prepare(`
      SELECT id, version, file_name, file_path, input_sources, created_at FROM generation_results
      WHERE asset_id = ? AND batch_id = ? AND trashed_at IS NULL ORDER BY version ASC
    `).all(assetId, batchId) as Array<{ id: string; version: number; file_name: string; file_path: string; input_sources: string | null; created_at: number }>;
    const results = await Promise.all(rows.map(async (row) => {
      const resultBytes = await readFile(row.file_path);
      return {
        id: row.id,
        version: row.version,
        inputSources: row.input_sources ? JSON.parse(row.input_sources) as unknown : [{ kind: 'asset', assetId }],
        fileName: row.file_name,
        format: path.extname(row.file_name).slice(1),
        byteSize: resultBytes.byteLength,
        sha256: createHash('sha256').update(resultBytes).digest('hex'),
        createdAt: row.created_at
      };
    }));
    const source = this.#catalog.resolveAssetFile(assetId);
    const manifest = {
      schemaVersion: '1.0', assetId, batchId, storageMode,
      source: source ? { fileName: source.fileName, modifiedAt: source.modifiedAt } : null,
      provider: { profileId: profile.id, modelId: profile.modelId },
      results
    };
    const destination = path.join(directory, 'manifest.json');
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
      await this.#publishTemporaryFile(destination, temporary);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #refreshManifest(directory: string, assetId: string, batchId: string): Promise<void> {
    const destination = path.join(directory, 'manifest.json');
    const existing = JSON.parse(await readFile(destination, 'utf8')) as Record<string, unknown>;
    const rows = this.#database.prepare(`
      SELECT id, version, file_name, file_path, input_sources, created_at FROM generation_results
      WHERE asset_id = ? AND batch_id = ? AND trashed_at IS NULL ORDER BY version ASC
    `).all(assetId, batchId) as Array<{ id: string; version: number; file_name: string; file_path: string; input_sources: string | null; created_at: number }>;
    const results = await Promise.all(rows.map(async (row) => {
      const resultBytes = await readFile(row.file_path);
      return {
        id: row.id,
        version: row.version,
        inputSources: row.input_sources ? JSON.parse(row.input_sources) as unknown : [{ kind: 'asset', assetId }],
        fileName: row.file_name,
        format: path.extname(row.file_name).slice(1),
        byteSize: resultBytes.byteLength,
        sha256: createHash('sha256').update(resultBytes).digest('hex'),
        createdAt: row.created_at
      };
    }));
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...existing, results }, null, 2), { mode: 0o600, flag: 'wx' });
      await this.#publishTemporaryFile(destination, temporary);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  #toResult(row: ResultRow): GenerationResult {
    return generationResultSchema.parse({
      id: row.id, assetId: row.asset_id, batchId: row.batch_id, inputSources: row.input_sources ? JSON.parse(row.input_sources) as unknown : [{ kind: 'asset', assetId: row.asset_id }], version: row.version,
      fileName: row.file_name, resultUrl: `photoresult://result/${row.id}`,
      prompt: row.prompt, providerProfileId: row.provider_profile_id,
      templateId: row.template_id, templateVersion: row.template_version, reviewState: row.review_state, createdAt: row.created_at
      , storageMode: row.storage_mode
    });
  }

  #findResult(resultId: string): ResultRow {
    const row = this.#database.prepare('SELECT * FROM generation_results WHERE id = ?').get(resultId) as ResultRow | undefined;
    if (!row) throw new Error('GENERATION_RESULT_NOT_FOUND');
    return row;
  }

  #isSafeTrashPath(row: ResultRow): boolean {
    if (!row.trash_path) return false;
    const expected = path.resolve(path.dirname(this.#generatedDirectory), 'trash', 'generation', row.id, row.file_name);
    return path.resolve(row.trash_path) === expected;
  }

  #deterministicPurgePath(row: ResultRow): string {
    return path.join(path.dirname(row.trash_path!), `.${row.file_name}.${row.id}.purge`);
  }

  #isSafePurgePath(row: ResultRow, purgePath: string): boolean {
    return path.resolve(purgePath) === path.resolve(this.#deterministicPurgePath(row))
      || path.dirname(path.resolve(purgePath)) === path.dirname(path.resolve(row.trash_path!))
        && new RegExp(`^\\.${escapeRegExp(row.file_name)}\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.purge$`, 'i')
          .test(path.basename(purgePath));
  }

  async #findLegacyPurgePaths(row: ResultRow): Promise<string[]> {
    const directory = path.dirname(row.trash_path!);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const candidates = names
      .map((name) => path.join(directory, name))
      .filter((candidate) => this.#isSafePurgePath(row, candidate));
    return candidates;
  }

  #removePurgedRecord(resultId: string, stagedPath: string): number {
    return Number(this.#database.prepare(`
      DELETE FROM generation_results
      WHERE id = ? AND trashed_at IS NOT NULL AND purge_path = ?
    `).run(resultId, stagedPath).changes);
  }

  #expectedResultDirectory(assetId: string, batchId: string, storageMode: 'managed' | 'portable'): string | null {
    if (storageMode === 'managed') return path.join(this.#generatedDirectory, assetId.slice(0, 2), assetId, batchId);
    const source = this.#catalog.resolveAssetFile(assetId);
    if (!source) return null;
    const originalStem = sanitizeFileStem(path.parse(source.fileName).name);
    return path.join(
      path.dirname(source.path), '_PhotoAllIsAI',
      `${originalStem}__${assetId.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
      batchId
    );
  }

  async #isSafeResultDirectory(assetId: string, storageMode: 'managed' | 'portable', directory: string): Promise<boolean> {
    let root = this.#generatedDirectory;
    if (storageMode === 'portable') {
      const source = this.#catalog.resolveAssetFile(assetId);
      if (!source) return false;
      root = path.join(path.dirname(source.path), '_PhotoAllIsAI');
    }
    return isSafePlannedDirectory(directory, root);
  }

}

async function isSafePlannedDirectory(directory: string, requiredRoot: string): Promise<boolean> {
  const root = path.resolve(requiredRoot);
  const target = path.resolve(directory);
  if (!isPathWithin(root, target)) return false;
  try {
    const rootEntry = await lstat(root);
    if (!rootEntry.isDirectory()) return false;
    const resolvedRoot = await realpath(root);
    let candidate = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
      candidate = path.join(candidate, segment);
      try {
        const entry = await lstat(candidate);
        if (!entry.isDirectory() || !isPathWithin(resolvedRoot, await realpath(candidate))) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        return false;
      }
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function inspectOptionalRegularFile(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null | false> {
  try {
    const entry = await lstat(filePath);
    return entry.isFile() ? entry : false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
  }
}

function isGenerationTemporaryPath(temporaryPath: string, filePath: string): boolean {
  if (path.dirname(path.resolve(temporaryPath)) !== path.dirname(path.resolve(filePath))) return false;
  const suffix = path.basename(temporaryPath).slice(path.basename(filePath).length);
  return /^\.\d+\.(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/iu.test(suffix)
    || /^\.\d+\.tmp$/u.test(suffix);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function inspectPurgeFile(filePath: string, trashRoot: string): Promise<Awaited<ReturnType<typeof lstat>> | null | false> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile()) return false;
    const [rootEntry, directoryEntry] = await Promise.all([lstat(trashRoot), lstat(path.dirname(filePath))]);
    if (!rootEntry.isDirectory() || !directoryEntry.isDirectory()) return false;
    const [resolvedRoot, resolvedDirectory] = await Promise.all([realpath(trashRoot), realpath(path.dirname(filePath))]);
    return path.dirname(resolvedDirectory) === resolvedRoot ? entry : false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function unlinkPublishedResultIfMatching(filePath: string, expectedBytes: Buffer): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.size !== expectedBytes.byteLength) return false;
    const actualBytes = await readFile(filePath);
    if (createHash('sha256').update(actualBytes).digest('hex') !== createHash('sha256').update(expectedBytes).digest('hex')) return false;
    await unlink(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function moveFileVerified(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  try {
    const [sourceStats, destinationStats, sourceBytes, destinationBytes] = await Promise.all([
      stat(source),
      stat(destination),
      readFile(source),
      readFile(destination)
    ]);
    if (sourceStats.size !== destinationStats.size
      || createHash('sha256').update(sourceBytes).digest('hex') !== createHash('sha256').update(destinationBytes).digest('hex')) {
      throw new Error('GENERATION_RESULT_MOVE_VERIFICATION_FAILED');
    }
    await unlink(source);
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function requestGeneratedImage(
  provider: ResolvedProvider,
  prompt: string,
  inputs: Array<{ bytes: Buffer; mime: string }>,
  signal?: AbortSignal
): Promise<Buffer> {
  const aceData = provider.profile.kind === 'acedata-nano-banana';
  const endpoint = aceData
    ? `${provider.profile.baseUrl}/nano-banana/images`
    : `${provider.profile.baseUrl}/images/edits`;
  const body = aceData
    ? {
        action: 'edit',
        model: provider.profile.modelId,
        prompt,
        image_urls: inputs.map((input) => `data:${input.mime};base64,${input.bytes.toString('base64')}`),
        count: 1
      }
    : {
        model: provider.profile.modelId,
        prompt,
        n: 1,
        image: inputs.length === 1
          ? { mime_type: inputs[0]!.mime, data: inputs[0]!.bytes.toString('base64') }
          : inputs.map((input) => ({ mime_type: input.mime, data: input.bytes.toString('base64') }))
      };
  const response = await fetchBounded(endpoint, {
    method: 'POST',
    headers: createProviderRequestHeaders(provider.profile.customHeaders, provider.apiKey),
    redirect: 'error',
    body: JSON.stringify(body)
  }, {
    maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
    timeoutMs: provider.profile.requestTimeoutMs ?? GENERATION_TIMEOUT_MS,
    retryCount: provider.profile.retryCount,
    signal
  });
  if (!response.ok) throw new Error(providerHttpError(response.status, response.bytes.toString('utf8')));
  const payload: unknown = JSON.parse(response.bytes.toString('utf8'));
  const candidate = extractImageCandidate(payload);
  if (candidate.base64) {
    const bytes = Buffer.from(candidate.base64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESULT_BYTES) throw new Error('GENERATED_IMAGE_INVALID_SIZE');
    return bytes;
  }
  if (!candidate.url) throw new Error('PROVIDER_IMAGE_MISSING');
  const url = validateGeneratedImageUrl(provider.profile.baseUrl, candidate.url);
  const download = await downloadPinned(
    url,
    { maxBytes: MAX_RESULT_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS, signal },
    isPrivateNetworkAddress
  );
  const bytes = download.bytes;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESULT_BYTES) throw new Error('GENERATED_IMAGE_INVALID_SIZE');
  return bytes;
}

function providerHttpError(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; detail?: unknown; code?: unknown };
    const error = parsed.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : undefined;
    const candidates = [error?.message, error?.detail, error?.code, parsed.message, parsed.detail, parsed.code];
    detail = candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
  } catch {
    detail = body.replace(/\s+/gu, ' ').trim();
  }
  detail = detail.replace(/(?:api[_ -]?key|authorization|bearer)\s*[:=]\s*[^,;\s]+/giu, '$1=[redacted]').slice(0, 760);
  return detail ? `PROVIDER_HTTP_${status}: ${detail}` : `PROVIDER_HTTP_${status}`;
}

export function isPrivateAddress(address: string): boolean {
  return isPrivateNetworkAddress(address);
}

export function validateGeneratedImageUrl(providerBaseUrl: string, candidateUrl: string): URL {
  const url = new URL(candidateUrl);
  const providerUrl = new URL(providerBaseUrl);
  const local = isLocalHostname(url.hostname);
  if (url.username || url.password) throw new Error('GENERATED_IMAGE_URL_UNSAFE');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('GENERATED_IMAGE_URL_UNSAFE');
  if (local && !isLocalHostname(providerUrl.hostname)) throw new Error('GENERATED_IMAGE_URL_PRIVATE');
  return url;
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname.replace(/^\[|\]$/g, '').toLowerCase());
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
    if (typeof candidate.image_url === 'string') return { url: candidate.image_url };
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
