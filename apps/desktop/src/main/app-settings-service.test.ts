import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AppSettingsService } from './app-settings-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('app settings service', () => {
  it('defaults to managed and persists portable atomically', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-settings-'));
    temporaryDirectories.push(directory);
    const service = new AppSettingsService(path.join(directory, 'nested', 'app.json'));
    await expect(service.get()).resolves.toEqual({ generationStorageMode: 'managed' });
    await expect(service.save({ generationStorageMode: 'portable' })).resolves.toEqual({ generationStorageMode: 'portable' });
    await expect(service.get()).resolves.toEqual({ generationStorageMode: 'portable' });
    expect(JSON.parse(await readFile(path.join(directory, 'nested', 'app.json'), 'utf8'))).toEqual({ generationStorageMode: 'portable' });
  });
});
