import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { appSettingsSchema, type AppSettings } from '@photoallisai/contracts';

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
      await this.#quarantineCorruptFile();
      return appSettingsSchema.parse({});
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return appSettingsSchema.parse({});
      if (error instanceof SyntaxError) {
        await this.#quarantineCorruptFile();
        return appSettingsSchema.parse({});
      }
      throw error;
    }
  }

  async save(input: AppSettings): Promise<AppSettings> {
    const settings = appSettingsSchema.parse(input);
    await mkdir(path.dirname(this.#settingsPath), { recursive: true });
    const temporaryPath = `${this.#settingsPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rename(temporaryPath, this.#settingsPath);
    return settings;
  }

  async #quarantineCorruptFile(): Promise<void> {
    const quarantinePath = `${this.#settingsPath}.corrupt-${Date.now()}`;
    await rename(this.#settingsPath, quarantinePath).catch(() => undefined);
  }
}
