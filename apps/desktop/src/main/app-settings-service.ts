import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { appSettingsSchema, type AppSettings } from '@photoallisai/contracts';

import { quarantineInvalidRegularFile, replaceRegularFileSafely } from './safe-file-write';

export class AppSettingsService {
  readonly #settingsPath: string;

  constructor(settingsPath: string) {
    this.#settingsPath = settingsPath;
  }

  async get(): Promise<AppSettings> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#settingsPath, 'utf8'));
      const result = appSettingsSchema.safeParse(parsed);
      if (result.success) return result.data;
      await quarantineInvalidRegularFile(this.#settingsPath);
      return appSettingsSchema.parse({});
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return appSettingsSchema.parse({});
      if (error instanceof SyntaxError) {
        await quarantineInvalidRegularFile(this.#settingsPath);
        return appSettingsSchema.parse({});
      }
      throw error;
    }
  }

  async save(input: AppSettings): Promise<AppSettings> {
    const settings = appSettingsSchema.parse(input);
    await mkdir(path.dirname(this.#settingsPath), { recursive: true });
    await replaceRegularFileSafely(this.#settingsPath, Buffer.from(JSON.stringify(settings, null, 2)));
    return settings;
  }

}
