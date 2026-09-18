import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExportPresetService } from './export-preset-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('export presets', () => {
  it('persists, updates, lists, and deletes presets', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-export-presets-'));
    directories.push(directory);
    const service = new ExportPresetService(path.join(directory, 'catalog.sqlite'));
    const created = service.save({ name: '交付 JPG', format: 'original', conflictPolicy: 'auto-rename', namingPattern: '{name}_{version}' });
    expect(service.list()).toHaveLength(1);
    const updated = service.save({ id: created.id, name: '客户交付', format: 'original', conflictPolicy: 'skip', namingPattern: '{name}_{date}' });
    expect(updated).toMatchObject({ id: created.id, name: '客户交付', conflictPolicy: 'skip' });
    service.delete(created.id);
    expect(service.list()).toEqual([]);
    service.close();
  });

  it('rejects duplicate names', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-export-presets-'));
    directories.push(directory);
    const service = new ExportPresetService(path.join(directory, 'catalog.sqlite'));
    const input = { name: '交付', format: 'original' as const, conflictPolicy: 'auto-rename' as const, namingPattern: '{name}' };
    service.save(input);
    expect(() => service.save(input)).toThrow('EXPORT_PRESET_NAME_EXISTS');
    service.close();
  });
});
