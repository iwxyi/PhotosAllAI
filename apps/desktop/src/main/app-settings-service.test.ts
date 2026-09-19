import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    await expect(service.get()).resolves.toEqual({ generationStorageMode: 'managed', theme: 'system' });
    await expect(service.save({ generationStorageMode: 'portable', theme: 'light' })).resolves.toEqual({ generationStorageMode: 'portable', theme: 'light' });
    await expect(service.get()).resolves.toEqual({ generationStorageMode: 'portable', theme: 'light' });
    expect(JSON.parse(await readFile(path.join(directory, 'nested', 'app.json'), 'utf8'))).toEqual({ generationStorageMode: 'portable', theme: 'light' });
  });

  it('quarantines malformed settings and restores defaults', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-settings-corrupt-'));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'app.json');
    await writeFile(settingsPath, '{not-json');
    const service = new AppSettingsService(settingsPath);
    await expect(service.get()).resolves.toEqual({ generationStorageMode: 'managed', theme: 'system' });
    expect((await readdir(directory)).some((name) => name.startsWith('app.json.corrupt-'))).toBe(true);
  });

  it('adds new defaults when loading a valid legacy settings file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-settings-legacy-'));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'app.json');
    await writeFile(settingsPath, JSON.stringify({ generationStorageMode: 'portable' }));
    await expect(new AppSettingsService(settingsPath).get()).resolves.toEqual({ generationStorageMode: 'portable', theme: 'system' });
  });
});
