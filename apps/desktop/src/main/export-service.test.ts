import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { ExportService, type ImageEncoder } from './export-service';

const temporaryDirectories: string[] = [];
const firstId = '32b027ec-aa41-4d0e-a9ea-5c42a2393108';
const secondId = '3379ff69-2d5f-4ead-9f80-4e112bd58714';
const missingId = '7bd73c3e-abde-444a-a435-2b1e087cfb70';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(imageEncoder?: ImageEncoder) {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-export-'));
  temporaryDirectories.push(directory);
  const managedDirectory = path.join(directory, 'managed');
  const destination = path.join(directory, 'destination');
  const source = path.join(managedDirectory, 'PORTRAIT__ai__v0001__A1B2C3D4.jpg');
  const secondSource = path.join(managedDirectory, 'LANDSCAPE__ai__v0001__D4C3B2A1.jpg');
  await Promise.all([mkdir(managedDirectory, { recursive: true }), mkdir(destination, { recursive: true })]);
  await Promise.all([
    writeFile(source, 'generated-content'),
    writeFile(secondSource, 'second-generated-content')
  ]);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const service = new ExportService(databasePath, {
    resolveResultFile: (id) => id === firstId ? source : id === secondId ? secondSource : null
  }, imageEncoder);
  return { service, source, secondSource, destination, databasePath };
}

describe('generation result export', () => {
  it('copies managed results without modifying the source', async () => {
    const { service, source, destination } = await fixture();
    const report = await service.exportToDirectory([firstId], destination);
    expect(report).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(await readFile(source, 'utf8')).toBe('generated-content');
    expect(await readFile(path.join(destination, report.files[0]!.fileName), 'utf8')).toBe('generated-content');
    service.close();
  });

  it('renames conflicts and reports missing results without aborting the batch', async () => {
    const { service, destination } = await fixture();
    await writeFile(path.join(destination, 'PORTRAIT__ai__v0001__A1B2C3D4.jpg'), 'existing');
    const report = await service.exportToDirectory([firstId, missingId, firstId], destination);
    expect(report).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(report.files[0]?.fileName).toBe('PORTRAIT__ai__v0001__A1B2C3D4 (1).jpg');
    expect(report.failures[0]).toEqual({ resultId: missingId, errorCode: 'EXPORT_RESULT_NOT_FOUND' });
    expect(await readdir(destination)).not.toContain(expect.stringContaining('.tmp'));
    service.close();
  });

  it('applies a preset naming pattern and skip conflict policy', async () => {
    const { service, destination } = await fixture();
    const preset = { id: 'a7f8b80b-8c58-4c10-a689-2f8f14ee8a18', name: '客户交付', format: 'original' as const, quality: 90, maxDimension: null, conflictPolicy: 'skip' as const, namingPattern: '{name}_交付_{version}', createdAt: 0, updatedAt: 0 };
    const first = await service.exportToDirectory([firstId], destination, preset);
    expect(first.files[0]?.fileName).toBe('PORTRAIT__ai__v0001__A1B2C3D4_交付_original.jpg');
    const second = await service.exportToDirectory([firstId], destination, preset);
    expect(second).toMatchObject({ succeeded: 0, failed: 1, failures: [{ errorCode: 'EXPORT_NAME_EXISTS' }] });
    service.close();
  });

  it('converts JPEG and PNG presets with the requested quality and dimensions', async () => {
    const calls: Array<{ format: 'jpeg' | 'png'; quality: number; maxDimension: number | null }> = [];
    const encoder: ImageEncoder = {
      async encode(_sourcePath, options) {
        calls.push(options);
        return Buffer.from(`encoded-${options.format}`);
      }
    };
    const { service, destination } = await fixture(encoder);
    const base = { id: '0d14e429-36e9-4bc4-8d27-bb33f558f139', name: '转换', conflictPolicy: 'auto-rename' as const, namingPattern: '{name}_{version}', createdAt: 0, updatedAt: 0 };
    const jpeg = await service.exportToDirectory([firstId], destination, { ...base, format: 'jpeg', quality: 82, maxDimension: 2048 });
    const png = await service.exportToDirectory([firstId], destination, { ...base, format: 'png', quality: 90, maxDimension: null });
    expect(jpeg.files[0]?.fileName).toBe('PORTRAIT__ai__v0001__A1B2C3D4_original.jpg');
    expect(png.files[0]?.fileName).toBe('PORTRAIT__ai__v0001__A1B2C3D4_original.png');
    expect(await readFile(path.join(destination, jpeg.files[0]!.fileName), 'utf8')).toBe('encoded-jpeg');
    expect(await readFile(path.join(destination, png.files[0]!.fileName), 'utf8')).toBe('encoded-png');
    expect(calls).toEqual([
      { format: 'jpeg', quality: 82, maxDimension: 2048 },
      { format: 'png', quality: 90, maxDimension: null }
    ]);
    service.close();
  });

  it('uses the converted extension for conflict numbering and isolates encoder failures', async () => {
    let invocation = 0;
    const encoder: ImageEncoder = {
      async encode() {
        invocation += 1;
        if (invocation === 2) throw new Error('EXPORT_DECODE_FAILED');
        return Buffer.from('converted');
      }
    };
    const { service, destination } = await fixture(encoder);
    const preset = { id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const, quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const, namingPattern: '{name}', createdAt: 0, updatedAt: 0 };
    await writeFile(path.join(destination, 'PORTRAIT__ai__v0001__A1B2C3D4.png'), 'existing');
    const first = await service.exportToDirectory([firstId], destination, preset);
    const second = await service.exportToDirectory([firstId], destination, preset);
    expect(first.files[0]?.fileName).toBe('PORTRAIT__ai__v0001__A1B2C3D4 (1).png');
    expect(second).toMatchObject({ succeeded: 0, failed: 1, failures: [{ errorCode: 'EXPORT_DECODE_FAILED' }] });
    expect(await readdir(destination)).not.toContain(expect.stringContaining('.tmp'));
    service.close();
  });

  it('stops a canceled conversion before publishing and records the partial run', async () => {
    const controller = new AbortController();
    const encoder: ImageEncoder = {
      async encode() {
        controller.abort();
        return Buffer.from('must-not-be-published');
      }
    };
    const { service, destination, databasePath } = await fixture(encoder);
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const,
      quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };

    const report = await service.exportToDirectory([firstId], destination, preset, controller.signal);

    expect(report).toMatchObject({ canceled: true, total: 1, succeeded: 0, failed: 0, files: [] });
    expect(await readdir(destination)).toEqual([]);
    const database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT status, report_json FROM export_runs WHERE id = ?').get(report.id!)).toMatchObject({
      status: 'canceled',
      report_json: expect.stringContaining('"canceled":true')
    });
    database.close();
    service.close();
  });

  it('keeps completed files and skips the rest after a batch is canceled', async () => {
    const controller = new AbortController();
    let invocation = 0;
    const encoder: ImageEncoder = {
      async encode() {
        invocation += 1;
        if (invocation === 2) controller.abort();
        return Buffer.from(`converted-${invocation}`);
      }
    };
    const { service, destination, databasePath } = await fixture(encoder);
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const,
      quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };

    const report = await service.exportToDirectory([firstId, secondId], destination, preset, controller.signal);

    expect(report).toMatchObject({ canceled: true, total: 2, succeeded: 1, failed: 0 });
    expect(invocation).toBe(2);
    expect(report.files).toEqual([{ resultId: firstId, fileName: 'PORTRAIT__ai__v0001__A1B2C3D4.png' }]);
    expect(await readdir(destination)).toEqual(['PORTRAIT__ai__v0001__A1B2C3D4.png']);
    const database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT status, report_json FROM export_runs WHERE id = ?').get(report.id!)).toMatchObject({
      status: 'canceled',
      report_json: expect.stringContaining('"succeeded":1')
    });
    database.close();
    service.close();
  });

  it('rejects symbolic-link sources without copying their targets', async () => {
    const { service, source, destination } = await fixture();
    const outside = path.join(path.dirname(destination), 'outside-secret.txt');
    await writeFile(outside, 'must-not-be-exported');
    await unlink(source);
    await symlink(outside, source);

    const report = await service.exportToDirectory([firstId], destination);

    expect(report).toMatchObject({ succeeded: 0, failed: 1 });
    expect(report.failures).toEqual([{ resultId: firstId, errorCode: 'EXPORT_SOURCE_NOT_FILE' }]);
    expect(await readdir(destination)).toEqual([]);
    service.close();
  });

  it('does not publish a conversion when its source changes during encoding', async () => {
    let sourceToChange = '';
    const encoder: ImageEncoder = {
      async encode() {
        await writeFile(sourceToChange, 'changed-generated-content-with-a-different-size');
        return Buffer.from('stale-conversion');
      }
    };
    const { service, source, destination } = await fixture(encoder);
    sourceToChange = source;
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const,
      quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };

    const report = await service.exportToDirectory([firstId], destination, preset);

    expect(report.failures).toEqual([{ resultId: firstId, errorCode: 'EXPORT_SOURCE_CHANGED' }]);
    expect(await readdir(destination)).toEqual([]);
    service.close();
  });

  it('replaces unexpected failure details with a path-free error code', async () => {
    const encoder: ImageEncoder = {
      async encode(sourcePath) {
        throw new Error(`unable to read ${sourcePath}`);
      }
    };
    const { service, source, destination } = await fixture(encoder);
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const,
      quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };

    const report = await service.exportToDirectory([firstId], destination, preset);

    expect(report.failures).toEqual([{ resultId: firstId, errorCode: 'EXPORT_COPY_FAILED' }]);
    expect(JSON.stringify(report)).not.toContain(source);
    expect(await readdir(destination)).toEqual([]);
    service.close();
  });

  it('reuses verified files and completes interrupted publications without duplicates', async () => {
    const runId = '40a5083b-52ae-44f0-bb1e-f47b08bdc9c2';
    const firstFileName = 'PORTRAIT__ai__v0001__A1B2C3D4.png';
    const secondFileName = 'LANDSCAPE__ai__v0001__D4C3B2A1.png';
    const firstPayload = 'published-before-crash';
    const encodedSources: string[] = [];
    const encoder: ImageEncoder = {
      async encode(sourcePath) {
        encodedSources.push(path.basename(sourcePath));
        return Buffer.from('rebuilt-after-crash');
      }
    };
    const { service, destination, databasePath } = await fixture(encoder);
    await writeFile(path.join(destination, firstFileName), firstPayload);
    const staleTemporary = path.join(destination, `.photoallisai-export-${runId}-${secondId}.tmp`);
    await writeFile(staleTemporary, 'interrupted-temporary-data');
    const database = new DatabaseSync(databasePath);
    database.prepare(`
      INSERT INTO export_runs (id, destination_path, status, report_json, created_at)
      VALUES (?, ?, 'running', '{}', ?)
    `).run(runId, await realpath(destination), Date.now());
    database.prepare(`
      INSERT INTO export_run_items (run_id, result_id, file_name, sha256, size_bytes, status)
      VALUES (?, ?, ?, ?, ?, 'publishing'), (?, ?, ?, ?, ?, 'publishing')
    `).run(
      runId, firstId, firstFileName, createHash('sha256').update(firstPayload).digest('hex'), Buffer.byteLength(firstPayload),
      runId, secondId, secondFileName, '0'.repeat(64), 99
    );
    database.close();
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const,
      quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };

    const report = await service.exportToDirectory(
      [firstId, secondId], destination, preset, undefined, runId
    );

    expect(report).toMatchObject({ id: runId, canceled: false, total: 2, succeeded: 2, failed: 0 });
    expect(report.files).toEqual([
      { resultId: firstId, fileName: firstFileName },
      { resultId: secondId, fileName: secondFileName }
    ]);
    expect(encodedSources).toEqual(['LANDSCAPE__ai__v0001__D4C3B2A1.jpg']);
    expect((await readdir(destination)).sort()).toEqual([secondFileName, firstFileName].sort());
    expect(await readFile(path.join(destination, firstFileName), 'utf8')).toBe(firstPayload);
    expect(await readFile(path.join(destination, secondFileName), 'utf8')).toBe('rebuilt-after-crash');
    const verified = new DatabaseSync(databasePath);
    expect(verified.prepare('SELECT status FROM export_runs WHERE id = ?').get(runId)).toEqual({ status: 'completed' });
    expect(verified.prepare(`
      SELECT result_id, status FROM export_run_items WHERE run_id = ? ORDER BY result_id
    `).all(runId)).toEqual([
      { result_id: firstId, status: 'completed' },
      { result_id: secondId, status: 'completed' }
    ].sort((left, right) => left.result_id.localeCompare(right.result_id)));
    verified.close();
    service.close();
  });

  it('does not duplicate completed files when the same task run is retried', async () => {
    const runId = '97bdccf5-146c-4d9e-9e80-ce426d923855';
    let invocations = 0;
    const encoder: ImageEncoder = {
      async encode() {
        invocations += 1;
        return Buffer.from('stable-export');
      }
    };
    const { service, destination } = await fixture(encoder);
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const,
      quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };

    const first = await service.exportToDirectory([firstId], destination, preset, undefined, runId);
    const retried = await service.exportToDirectory([firstId], destination, preset, undefined, runId);

    expect(retried).toEqual(first);
    expect(invocations).toBe(1);
    expect(await readdir(destination)).toEqual(['PORTRAIT__ai__v0001__A1B2C3D4.png']);
    service.close();
  });

  it('preserves a modified completed file and republishes a verified replacement', async () => {
    const runId = '705da125-a9c1-4328-b6f7-f15a6d0a30ee';
    let invocations = 0;
    const encoder: ImageEncoder = {
      async encode() {
        invocations += 1;
        return Buffer.from(`verified-export-${invocations}`);
      }
    };
    const { service, destination } = await fixture(encoder);
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'PNG', format: 'png' as const,
      quality: 90, maxDimension: 3840, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };
    const first = await service.exportToDirectory([firstId], destination, preset, undefined, runId);
    const originalName = first.files[0]!.fileName;
    await writeFile(path.join(destination, originalName), 'externally-modified');

    const retried = await service.exportToDirectory([firstId], destination, preset, undefined, runId);

    expect(invocations).toBe(2);
    expect(retried.files).toEqual([{
      resultId: firstId,
      fileName: 'PORTRAIT__ai__v0001__A1B2C3D4 (1).png'
    }]);
    expect(await readFile(path.join(destination, originalName), 'utf8')).toBe('externally-modified');
    expect(await readFile(path.join(destination, retried.files[0]!.fileName), 'utf8')).toBe('verified-export-2');
    service.close();
  });

  it('rejects reuse of a run id for a different export request', async () => {
    const runId = 'ce611bf9-cdca-440f-a60f-810514f0cf31';
    const { service, destination } = await fixture();
    const preset = {
      id: '72e43f40-36f4-48bd-a4b0-9032f299b0a2', name: 'Original', format: 'original' as const,
      quality: 90, maxDimension: null, conflictPolicy: 'auto-rename' as const,
      namingPattern: '{name}', createdAt: 0, updatedAt: 0
    };
    await service.exportToDirectory([firstId], destination, preset, undefined, runId);

    await expect(service.exportToDirectory(
      [firstId, secondId], destination, preset, undefined, runId
    )).rejects.toThrow('EXPORT_RUN_REQUEST_CHANGED');
    expect(await readdir(destination)).toEqual(['PORTRAIT__ai__v0001__A1B2C3D4.jpg']);
    service.close();
  });

  it('adds request fingerprints when opening an older export run schema', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-export-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE export_runs (
        id TEXT PRIMARY KEY,
        destination_path TEXT NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);
    database.close();

    const service = new ExportService(databasePath, { resolveResultFile: () => null });
    const migrated = new DatabaseSync(databasePath);
    const columns = migrated.prepare('PRAGMA table_info(export_runs)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('request_hash');
    migrated.close();
    service.close();
  });
});
