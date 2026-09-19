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
    await expect(service.get()).resolves.toEqual({ generationStorageMode: 'managed', theme: 'system', cacheMaxBytes: 5 * 1024 ** 3 });
    const settings = { generationStorageMode: 'portable' as const, theme: 'light' as const, cacheMaxBytes: 10 * 1024 ** 3 };
    await expect(service.save(settings)).resolves.toEqual(settings);
    await expect(service.get()).resolves.toEqual(settings);
    expect(JSON.parse(await readFile(path.join(directory, 'nested', 'app.json'), 'utf8'))).toEqual(settings);
  });

  it('quarantines malformed settings and restores defaults', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-settings-corrupt-'));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'app.json');
    await writeFile(settingsPath, '{not-json');
    const service = new AppSettingsService(settingsPath);
    await expect(service.get()).resolves.toEqual({ generationStorageMode: 'managed', theme: 'system', cacheMaxBytes: 5 * 1024 ** 3 });
    expect((await readdir(directory)).some((name) => name.startsWith('app.json.corrupt-'))).toBe(true);
  });

  it('adds new defaults when loading a valid legacy settings file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-settings-legacy-'));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'app.json');
    await writeFile(settingsPath, JSON.stringify({ generationStorageMode: 'portable' }));
    await expect(new AppSettingsService(settingsPath).get()).resolves.toEqual({
      generationStorageMode: 'portable', theme: 'system', cacheMaxBytes: 5 * 1024 ** 3
    });
  });
});
