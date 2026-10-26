import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  it('tests ACE Data Nano Banana through its model-list endpoint without starting generation', async () => {
    let requestUrl = '';
    let requestAuthorization = '';
    const server = createServer((request, response) => {
      requestUrl = request.url ?? '';
      requestAuthorization = request.headers.authorization ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'nano-banana-pro' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const providers = await service();

    const result = await providers.test({
      name: 'ACE Nano Banana', kind: 'acedata-nano-banana', purpose: 'generation',
      baseUrl: `http://127.0.0.1:${address.port}`, modelId: 'nano-banana-pro', apiKey: 'ace-token', enabled: true
    });

    expect(result.ok).toBe(true);
    expect(requestUrl).toBe('/openai/models');
    expect(requestAuthorization).toBe('Bearer ace-token');
  });

  it('selects one enabled default per purpose and persists explicit replacements', async () => {
    const { providers, settingsPath } = await serviceWithPath();
    const base = { kind: 'openai-compatible' as const, purpose: 'vision' as const, baseUrl: 'https://example.com/v1', modelId: 'model', apiKey: 'test-key', enabled: true };
    const first = await providers.save({ ...base, name: 'First' });
    const second = await providers.save({ ...base, name: 'Second' });
    const generation = await providers.save({ ...base, purpose: 'generation', name: 'Generation' });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(generation.isDefault).toBe(true);
    await providers.save({ ...base, id: second.id, name: 'Second', isDefault: true });
    const reloaded = new ProviderService(settingsPath, cipher);
    let profiles = await reloaded.list();
    expect(profiles.find((profile) => profile.purpose === 'vision')?.id).toBe(second.id);
    expect(profiles.filter((profile) => profile.purpose === 'vision' && profile.isDefault)).toHaveLength(1);
    expect(profiles.find((profile) => profile.id === generation.id)?.isDefault).toBe(true);
    await reloaded.save({ ...base, id: second.id, name: 'Second', enabled: false });
    profiles = await reloaded.list();
    expect(profiles.find((profile) => profile.id === first.id)?.isDefault).toBe(true);
    expect(profiles.find((profile) => profile.id === second.id)?.isDefault).toBe(false);
    await reloaded.delete(first.id);
    expect((await reloaded.list()).filter((profile) => profile.purpose === 'vision' && profile.isDefault)).toHaveLength(0);
  });

  it('migrates legacy configurations to an enabled default without losing credentials', async () => {
    const { providers, settingsPath } = await serviceWithPath();
    const saved = await providers.save({ name: 'Legacy', kind: 'openai-compatible', purpose: 'vision', baseUrl: 'https://example.com/v1', modelId: 'model', enabled: true, apiKey: 'test-key' });
    const stored = JSON.parse(await readFile(settingsPath, 'utf8'));
    delete stored[0].isDefault;
    await writeFile(settingsPath, JSON.stringify(stored));
    expect((await providers.list())[0]?.isDefault).toBe(true);
    expect((await providers.resolve(saved.id)).apiKey).toBe('test-key');
  });

  it.each([
    ['<!doctype html><html>Website</html>', '网页'],
    ['not-json', '不是有效 JSON'],
    ['{"error":"wrong endpoint"}', '模型列表']
  ])('does not report a successful connection for HTTP 200 with an invalid API body (%s)', async (body, message) => {
    const server = createServer((_request, response) => response.end(body));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const providers = await service();
    const result = await providers.test({
      name: 'Local', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: `http://127.0.0.1:${address.port}`, modelId: 'model', apiKey: 'test-key', enabled: true
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(message);
  });

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

  it('loads legacy profiles with bounded request defaults', async () => {
    const { providers, settingsPath } = await serviceWithPath();
    await writeFile(settingsPath, JSON.stringify([{
      id: '7b70df33-5011-4e1c-a4b4-6f73b9d8820e', name: 'Legacy',
      kind: 'openai-compatible', purpose: 'vision', baseUrl: 'https://example.com/v1',
      modelId: 'vision-model', enabled: true, updatedAt: 1
    }]));

    await expect(providers.list()).resolves.toEqual([
      expect.objectContaining({ requestTimeoutMs: 300_000, retryCount: 2, customHeaders: {} })
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
    let receivedOrganization = '';
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization ?? '';
      receivedOrganization = String(request.headers['openai-organization'] ?? '');
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
      baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'model', apiKey: 'test-key',
      customHeaders: { 'OpenAI-Organization': 'org-local' }, enabled: true
    });
    expect(result.ok).toBe(true);
    expect(receivedAuthorization).toBe('Bearer test-key');
    expect(receivedOrganization).toBe('org-local');
  });

  it('rejects security-sensitive and malformed custom headers', async () => {
    const providers = await service();
    const base = {
      name: 'Headers', kind: 'openai-compatible' as const, purpose: 'vision' as const,
      baseUrl: 'https://example.com/v1', modelId: 'model', apiKey: 'key', enabled: true
    };

    await expect(providers.save({ ...base, customHeaders: { Authorization: 'other-secret' } })).rejects.toThrow();
    await expect(providers.save({ ...base, customHeaders: { 'Proxy-Authorization': 'secret' } })).rejects.toThrow();
    await expect(providers.save({ ...base, customHeaders: { 'X-Route': 'ok\r\nX-Injected: true' } })).rejects.toThrow();
    await expect(providers.save({ ...base, customHeaders: { 'Bad Header': 'value' } })).rejects.toThrow();
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

  it('quarantines the complete provider file when any profile is invalid', async () => {
    const { providers, settingsPath, directory } = await serviceWithPath();
    await writeFile(settingsPath, JSON.stringify([
      {
        id: '7b70df33-5011-4e1c-a4b4-6f73b9d8820e', name: 'Valid',
        kind: 'openai-compatible', purpose: 'vision', baseUrl: 'https://example.com/v1',
        modelId: 'vision-model', enabled: true, updatedAt: 1
      },
      { name: 'Invalid and previously discarded silently' }
    ]));

    await expect(providers.list()).resolves.toEqual([]);
    const entries = await readdir(directory);
    expect(entries).toEqual([expect.stringMatching(/^providers\.json\.corrupt-/)]);
    expect(JSON.parse(await readFile(path.join(directory, entries[0]!), 'utf8'))).toHaveLength(2);
  });

  it('does not move directories or symbolic links when provider settings cannot be parsed', async () => {
    const { providers, settingsPath, directory } = await serviceWithPath();
    await mkdir(settingsPath);
    await expect(providers.list()).rejects.toThrow();
    expect(await readdir(directory)).toContain('providers.json');

    await rm(settingsPath, { recursive: true });
    const outside = path.join(directory, 'outside.json');
    await writeFile(outside, '{not-json');
    await symlink(outside, settingsPath);
    await expect(providers.list()).rejects.toThrow('QUARANTINE_SOURCE_NOT_REGULAR_FILE');
    expect(await readFile(outside, 'utf8')).toBe('{not-json');
    expect(await readdir(directory)).toContain('providers.json');
  });
});
