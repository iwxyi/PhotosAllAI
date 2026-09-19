import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProviderService, type CredentialCipher } from './provider-service';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const cipher: CredentialCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
};

async function service(): Promise<ProviderService> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-provider-'));
  temporaryDirectories.push(directory);
  return new ProviderService(path.join(directory, 'providers.json'), cipher);
}

async function serviceWithPath(): Promise<{ providers: ProviderService; settingsPath: string; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-provider-corrupt-'));
  temporaryDirectories.push(directory);
  const settingsPath = path.join(directory, 'providers.json');
  return { providers: new ProviderService(settingsPath, cipher), settingsPath, directory };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('provider service', () => {
  it('stores only an encrypted credential and returns masked metadata', async () => {
    const providers = await service();
    const saved = await providers.save({
      name: 'Vision', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'https://example.com/v1/', modelId: 'vision-model', apiKey: 'secret-key', enabled: true
    });
    expect(saved.baseUrl).toBe('https://example.com/v1');
    expect(saved.hasCredential).toBe(true);
    expect(JSON.stringify(await providers.list())).not.toContain('secret-key');
    await providers.delete(saved.id);
    await expect(providers.list()).resolves.toEqual([]);
    await expect(providers.resolve(saved.id)).rejects.toThrow('PROVIDER_NOT_FOUND');
  });

  it('replaces provider settings repeatedly without transaction artifacts', async () => {
    const { providers, directory } = await serviceWithPath();
    const saved = await providers.save({
      name: 'Vision', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'https://example.com/v1', modelId: 'vision-model', apiKey: 'secret-key', enabled: true
    });

    await providers.save({
      id: saved.id, name: 'Vision updated', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'https://example.com/v1', modelId: 'vision-model-2', enabled: true
    });

    expect(await readdir(directory)).toEqual(['providers.json']);
    await expect(providers.list()).resolves.toEqual([
      expect.objectContaining({ id: saved.id, name: 'Vision updated', modelId: 'vision-model-2' })
    ]);
  });

  it('rejects insecure remote URLs but permits localhost development', async () => {
    const providers = await service();
    await expect(providers.save({
      name: 'Unsafe', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'http://example.com/v1', modelId: 'model', apiKey: 'key', enabled: true
    })).rejects.toThrow('PROVIDER_URL_REQUIRES_HTTPS');
    await expect(providers.save({
      name: 'Local', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'http://127.0.0.1:9999/v1', modelId: 'model', apiKey: 'key', enabled: true
    })).resolves.toMatchObject({ name: 'Local' });
    await expect(providers.save({
      name: 'IPv6 Local', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'http://[::1]:9999/v1', modelId: 'model', apiKey: 'key', enabled: true
    })).resolves.toMatchObject({ name: 'IPv6 Local' });
    await expect(providers.save({
      name: 'Embedded Credentials', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'https://user:password@example.com/v1', modelId: 'model', apiKey: 'key', enabled: true
    })).rejects.toThrow('PROVIDER_URL_CREDENTIALS_FORBIDDEN');
  });

  it('tests a compatible endpoint without exposing the credential', async () => {
    let receivedAuthorization = '';
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');

    const providers = await service();
    const result = await providers.test({
      name: 'Local', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'model', apiKey: 'test-key', enabled: true
    });
    expect(result.ok).toBe(true);
    expect(receivedAuthorization).toBe('Bearer test-key');
  });

  it('quarantines malformed provider settings and keeps the app usable', async () => {
    const { providers, settingsPath, directory } = await serviceWithPath();
    await writeFile(settingsPath, '{not-json');
    await expect(providers.list()).resolves.toEqual([]);
    expect((await readdir(directory)).some((name) => name.startsWith('providers.json.corrupt-'))).toBe(true);
    await expect(providers.save({
      name: 'Recovered', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: 'https://example.com/v1', modelId: 'model', enabled: true
    })).resolves.toMatchObject({ name: 'Recovered' });
  });
});
