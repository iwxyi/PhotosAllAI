import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  connectionTestSchema,
  providerProfileSchema,
  saveProviderProfileInputSchema,
  type ConnectionTest,
  type ProviderProfile,
  type SaveProviderProfileInput
} from '@photoallisai/contracts';

import { quarantineInvalidRegularFile, replaceRegularFileSafely } from './safe-file-write';

type StoredProviderProfile = Omit<ProviderProfile, 'hasCredential'> & {
  encryptedCredential?: string;
};

export interface CredentialCipher {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export type ResolvedProvider = {
  profile: ProviderProfile;
  apiKey: string;
};

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.username || url.password) throw new Error('PROVIDER_URL_CREDENTIALS_FORBIDDEN');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('PROVIDER_URL_REQUIRES_HTTPS');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export class ProviderService {
  readonly #settingsPath: string;
  readonly #cipher: CredentialCipher;

  constructor(settingsPath: string, cipher: CredentialCipher) {
    this.#settingsPath = settingsPath;
    this.#cipher = cipher;
  }

  async list(): Promise<ProviderProfile[]> {
    return (await this.#read()).map(({ encryptedCredential, ...profile }) =>
      providerProfileSchema.parse({ ...profile, hasCredential: Boolean(encryptedCredential) })
    );
  }

  async resolve(profileId: string): Promise<ResolvedProvider> {
    const stored = (await this.#read()).find((profile) => profile.id === profileId);
    if (!stored) throw new Error('PROVIDER_NOT_FOUND');
    if (!stored.enabled) throw new Error('PROVIDER_DISABLED');
    if (!stored.encryptedCredential) throw new Error('PROVIDER_CREDENTIAL_MISSING');
    const { encryptedCredential, ...profile } = stored;
    return {
      profile: providerProfileSchema.parse({ ...profile, hasCredential: true }),
      apiKey: this.#cipher.decrypt(encryptedCredential)
    };
  }

  async save(rawInput: SaveProviderProfileInput): Promise<ProviderProfile> {
    const input = saveProviderProfileInputSchema.parse(rawInput);
    const profiles = await this.#read();
    const existing = input.id ? profiles.find((profile) => profile.id === input.id) : undefined;
    const id = input.id ?? randomUUID();
    const credential = input.apiKey?.trim();

    if (credential && !this.#cipher.available()) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
    const encryptedCredential = credential
      ? this.#cipher.encrypt(credential)
      : existing?.encryptedCredential;

    const next: StoredProviderProfile = {
      id,
      name: input.name.trim(),
      kind: input.kind,
      purpose: input.purpose,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      modelId: input.modelId.trim(),
      enabled: input.enabled,
      updatedAt: Date.now(),
      ...(encryptedCredential ? { encryptedCredential } : {})
    };

    const updated = existing
      ? profiles.map((profile) => profile.id === id ? next : profile)
      : [...profiles, next];
    await this.#write(updated);
    const { encryptedCredential: storedCredential, ...profile } = next;
    return providerProfileSchema.parse({ ...profile, hasCredential: Boolean(storedCredential) });
  }

  async delete(profileId: string): Promise<void> {
    const id = providerProfileSchema.shape.id.parse(profileId);
    const profiles = await this.#read();
    if (!profiles.some((profile) => profile.id === id)) throw new Error('PROVIDER_NOT_FOUND');
    await this.#write(profiles.filter((profile) => profile.id !== id));
  }

  async test(rawInput: SaveProviderProfileInput): Promise<ConnectionTest> {
    const input = saveProviderProfileInputSchema.parse(rawInput);
    const profiles = await this.#read();
    const existing = input.id ? profiles.find((profile) => profile.id === input.id) : undefined;
    const credential = input.apiKey?.trim() ?? (
      existing?.encryptedCredential ? this.#cipher.decrypt(existing.encryptedCredential) : ''
    );
    if (!credential) return connectionTestSchema.parse({ ok: false, message: '请先填写 API Key', latencyMs: 0 });

    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const endpoint = input.kind === 'openai-compatible' ? `${baseUrl}/models` : `${baseUrl}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const startedAt = performance.now();

    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      if (!response.ok) {
        return connectionTestSchema.parse({
          ok: false,
          message: `连接失败：HTTP ${response.status}`,
          latencyMs
        });
      }
      return connectionTestSchema.parse({ ok: true, message: '连接成功', latencyMs });
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? '连接超时'
        : '无法连接到模型服务';
      return connectionTestSchema.parse({
        ok: false,
        message,
        latencyMs: Math.round(performance.now() - startedAt)
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #read(): Promise<StoredProviderProfile[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#settingsPath, 'utf8'));
      if (!Array.isArray(value)) {
        await quarantineInvalidRegularFile(this.#settingsPath);
        return [];
      }
      const profiles: StoredProviderProfile[] = [];
      for (const item of value) {
        const parsed = providerProfileSchema.omit({ hasCredential: true }).safeParse(item);
        if (!parsed.success || typeof item !== 'object' || item === null) {
          await quarantineInvalidRegularFile(this.#settingsPath);
          return [];
        }
        const encryptedCredential = 'encryptedCredential' in item && typeof item.encryptedCredential === 'string'
          ? item.encryptedCredential
          : undefined;
        if ('encryptedCredential' in item && item.encryptedCredential !== undefined && !encryptedCredential) {
          await quarantineInvalidRegularFile(this.#settingsPath);
          return [];
        }
        profiles.push({ ...parsed.data, ...(encryptedCredential ? { encryptedCredential } : {}) });
      }
      return profiles;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) {
        await quarantineInvalidRegularFile(this.#settingsPath);
        return [];
      }
      throw error;
    }
  }

  async #write(profiles: readonly StoredProviderProfile[]): Promise<void> {
    await mkdir(path.dirname(this.#settingsPath), { recursive: true });
    await replaceRegularFileSafely(this.#settingsPath, Buffer.from(JSON.stringify(profiles, null, 2)));
  }
}
