import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExportService } from './export-service';

const temporaryDirectories: string[] = [];
const firstId = '32b027ec-aa41-4d0e-a9ea-5c42a2393108';
const missingId = '7bd73c3e-abde-444a-a435-2b1e087cfb70';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-export-'));
  temporaryDirectories.push(directory);
  const managedDirectory = path.join(directory, 'managed');
  const destination = path.join(directory, 'destination');
  const source = path.join(managedDirectory, 'PORTRAIT__ai__v0001__A1B2C3D4.jpg');
  await Promise.all([mkdir(managedDirectory, { recursive: true }), mkdir(destination, { recursive: true })]);
  await writeFile(source, 'generated-content');
  const service = new ExportService(path.join(directory, 'catalog.sqlite'), {
    resolveResultFile: (id) => id === firstId ? source : null
  });
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
});
