import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderProfile } from '@photoallisai/contracts';

import { GenerationService, isPrivateAddress } from './generation-service';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const providerId = 'aa2888b2-4f07-4598-a876-710d702d14da';
const batchId = '4fdbbb8a-8c33-484a-9719-2d36d61c4f66';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(
  responseBody: (origin: string) => unknown,
  imageDownload?: Buffer
): Promise<{ service: GenerationService; directory: string; sourcePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-generation-'));
  temporaryDirectories.push(directory);
  const previewPath = path.join(directory, 'preview.jpg');
  const sourcePath = path.join(directory, 'IMG_1024.CR3');
  await writeFile(previewPath, 'bounded-preview');
  await writeFile(sourcePath, 'untouched-original');

  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    if (request.url === '/result.png' && imageDownload) {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': imageDownload.byteLength });
      response.end(imageDownload);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody(origin)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');

  const profile: ProviderProfile = {
    id: providerId,
    name: 'Generator',
    kind: 'nanobanana-compatible',
    purpose: 'generation',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId: 'image-model',
    hasCredential: true,
    enabled: true,
    updatedAt: Date.now()
  };
  const service = new GenerationService(
    path.join(directory, 'catalog.sqlite'),
    path.join(directory, 'managed', 'generated'),
    { resolve: async () => ({ profile, apiKey: 'secret' }) },
    { getOrCreate: async () => previewPath },
    { resolveAssetFile: () => ({ path: sourcePath, fileName: 'IMG_1024.CR3', modifiedAt: 1 }) }
  );
  return { service, directory, sourcePath };
}

function payload(resultIndex = 1) {
  return { providerProfileId: providerId, batchId, prompt: 'Remove background pedestrians', resultIndex };
}

describe('managed generation results', () => {
  it('persists base64 output with a versioned filename and manifest', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));

    const first = await service.generate('asset-1', payload());
    const second = await service.generate('asset-1', payload(2));

    expect(first.fileName).toMatch(/^IMG_1024__ai__v0001__[A-F0-9]{8}\.png$/);
    expect(second.version).toBe(2);
    expect(service.list('asset-1').map((item) => item.version)).toEqual([2, 1]);
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    const batchDirectory = path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId);
    const manifest = JSON.parse(await readFile(path.join(batchDirectory, 'manifest.json'), 'utf8')) as { source: { fileName: string; modifiedAt: number }; results: Array<{ byteSize: number; sha256: string; format: string }> };
    expect(manifest.source.fileName).toBe('IMG_1024.CR3');
    expect(manifest.results).toHaveLength(2);
    expect(manifest.results[0]).toMatchObject({ byteSize: png.byteLength, format: 'png', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await readdir(batchDirectory)).filter((name) => name.endsWith('.png'))).toHaveLength(2);
    service.close();
  });

  it('downloads a localhost URL result', async () => {
    const { service } = await fixture((origin) => ({ images: [{ url: `${origin}/result.png` }] }), png);
    await expect(service.generate('asset-1', payload())).resolves.toMatchObject({ version: 1 });
    service.close();
  });

  it('writes portable results beside the original and records the strategy', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const original = await readFile(sourcePath);
    const result = await service.generate('asset-1', { ...payload(), storageMode: 'portable' });
    const portableDirectory = path.join(directory, '_PhotoAllIsAI', 'IMG_1024__ASSET1', batchId);
    expect(result.storageMode).toBe('portable');
    expect(service.list('asset-1')[0]?.storageMode).toBe('portable');
    expect(await readFile(sourcePath)).toEqual(original);
    expect(await readdir(portableDirectory)).toEqual(expect.arrayContaining(['manifest.json', result.fileName]));
    expect(await readdir(directory)).not.toContain('managed');
    service.close();
  });

  it('relocates portable results when the original moves or is renamed', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', { ...payload(), storageMode: 'portable' });
    const nextDirectory = path.join(directory, 'moved');
    const nextSourcePath = path.join(nextDirectory, 'RENAMED.CR3');
    await mkdir(nextDirectory, { recursive: true });
    await rename(sourcePath, nextSourcePath);
    await service.relocatePortableResults('asset-1', sourcePath, nextSourcePath, 'IMG_1024.CR3', 'RENAMED.CR3');
    const relocated = service.resolveResultFile(result.id);
    expect(relocated).toContain(path.join('moved', '_PhotoAllIsAI', 'RENAMED__ASSET1'));
    expect(relocated).toBeTruthy();
    expect(await readFile(relocated!)).toEqual(png);
    service.close();
  });

  it('persists review state and keeps a single preferred result per asset', async () => {
    const { service } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const first = await service.generate('asset-1', payload());
    const second = await service.generate('asset-1', payload(2));
    expect(service.updateReview({ resultId: first.id, reviewState: 'preferred' }).reviewState).toBe('preferred');
    expect(service.updateReview({ resultId: second.id, reviewState: 'preferred' }).reviewState).toBe('preferred');
    expect(service.list('asset-1').find((result) => result.id === first.id)?.reviewState).toBe('accepted');
    expect(service.updateReview({ resultId: second.id, reviewState: 'rejected' }).reviewState).toBe('rejected');
    service.close();
  });

  it('rejects unsafe result URLs', async () => {
    const { service } = await fixture(() => ({ data: [{ url: 'http://example.com/result.png' }] }));
    await expect(service.generate('asset-1', payload())).rejects.toThrow('GENERATED_IMAGE_URL_UNSAFE');
    service.close();
  });

  it('rejects HTTPS result URLs resolving to private networks', async () => {
    const { service } = await fixture(() => ({ data: [{ url: 'https://192.168.1.10/result.png' }] }));
    await expect(service.generate('asset-1', payload())).rejects.toThrow('GENERATED_IMAGE_URL_PRIVATE');
    service.close();
  });

  it('rejects content without a supported image signature', async () => {
    const { service } = await fixture(() => ({ data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] }));
    await expect(service.generate('asset-1', payload())).rejects.toThrow('GENERATED_IMAGE_FORMAT_UNSUPPORTED');
    expect(service.list('asset-1')).toEqual([]);
    service.close();
  });
});

describe('generated image URL network policy', () => {
  it('rejects private, mapped, shared, and reserved address ranges', () => {
    for (const address of ['10.0.0.2', '100.64.0.1', '192.168.1.2', '198.18.0.1', '224.0.0.1', '::1', 'fe80::1', 'fd12::1', '::ffff:192.168.1.2']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });
});
