import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExportService, type ImageEncoder } from './export-service';

const temporaryDirectories: string[] = [];
const firstId = '32b027ec-aa41-4d0e-a9ea-5c42a2393108';
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
  await Promise.all([mkdir(managedDirectory, { recursive: true }), mkdir(destination, { recursive: true })]);
  await writeFile(source, 'generated-content');
  const service = new ExportService(path.join(directory, 'catalog.sqlite'), {
    resolveResultFile: (id) => id === firstId ? source : null
  }, imageEncoder);
  return { service, source, destination };
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
});
