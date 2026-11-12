import { createServer, type Server } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderProfile } from '@photoallisai/contracts';

import { GenerationService, isPrivateAddress, validateGeneratedImageUrl } from './generation-service';
import { CatalogService } from './catalog-service';
import { publishTemporaryFileSafely } from './safe-file-write';
import { TaskService } from './task-service';

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
  imageDownload?: Buffer,
  publishTemporaryFile?: ConstructorParameters<typeof GenerationService>[5],
  moveFile?: ConstructorParameters<typeof GenerationService>[6],
  providerKind: ProviderProfile['kind'] = 'nanobanana-compatible',
  onRequest?: (url: string | undefined, body: string) => void,
  responseStatus = 200,
  textToImageFolder = false
): Promise<{ service: GenerationService; directory: string; sourcePath: string; setSourcePath: (value: string) => void; outputFolderId: string | null; closeCatalog: () => void; resolveIndexedAsset: (id: string) => ReturnType<CatalogService['resolveAssetFile']> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-generation-'));
  temporaryDirectories.push(directory);
  const previewPath = path.join(directory, 'preview.jpg');
  const sourcePath = path.join(directory, 'IMG_1024.CR3');
  let currentSourcePath = sourcePath;
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
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      onRequest?.(request.url, Buffer.concat(chunks).toString('utf8'));
      response.writeHead(responseStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseBody(origin)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');

  const profile: ProviderProfile = {
    id: providerId,
    name: 'Generator',
    kind: providerKind,
    purpose: 'generation',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId: 'image-model',
    requestTimeoutMs: 300_000,
    retryCount: 2,
    customHeaders: {},
    hasCredential: true,
    enabled: true,
    updatedAt: Date.now()
  };
  const databasePath = path.join(directory, 'catalog.sqlite');
  const outputPath = path.join(directory, 'photos');
  let catalog: CatalogService | null = null;
  let outputFolderId: string | null = null;
  if (textToImageFolder) {
    await mkdir(outputPath, { recursive: true });
    catalog = new CatalogService(databasePath);
    await catalog.importFolders([outputPath]);
    outputFolderId = catalog.listFolders()[0]?.id ?? null;
  }
  const service = new GenerationService(
    databasePath,
    path.join(directory, 'managed', 'generated'),
    { resolve: async () => ({ profile, apiKey: 'secret' }) },
    { getOrCreate: async () => previewPath },
    catalog ?? { resolveAssetFile: () => ({
      path: currentSourcePath,
      fileName: path.basename(currentSourcePath),
      modifiedAt: 1,
      sizeBytes: 18
    }) },
    publishTemporaryFile,
    moveFile
  );
  return { service, directory, sourcePath, setSourcePath: (value) => { currentSourcePath = value; }, outputFolderId, closeCatalog: () => catalog?.close(), resolveIndexedAsset: (id) => catalog?.resolveAssetFile(id) ?? null };
}

function payload(resultIndex = 1) {
  return { providerProfileId: providerId, batchId, prompt: 'Remove background pedestrians', resultIndex };
}

describe('managed generation results', () => {
  it('creates text-to-image results directly in the selected catalog folder without image inputs', async () => {
    let requestPath = '';
    let requestBody = '';
    const { service, directory, outputFolderId, closeCatalog, resolveIndexedAsset } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined, undefined, undefined, 'nanobanana-compatible',
      (url, body) => { requestPath = url ?? ''; requestBody = body; }, 200, true
    );
    try {
      const result = await service.generate(null, {
        ...payload(), outputFolderId, textItemId: '8af36a1e-48d5-4c21-b99e-9aa4efcd8b13', inputSources: []
      }, undefined, 'bce8c75f-d7d0-4ca5-ae95-53147bcf0298');
      expect(requestPath).toBe('/v1/images/generations');
      expect(JSON.parse(requestBody)).toEqual({ model: 'image-model', prompt: payload().prompt, n: 1 });
      expect(result).toMatchObject({ outputFolderId, inputSources: [], version: 1 });
      expect(await readFile(path.join(directory, 'photos', result.fileName))).toEqual(png);
      expect(await realpath(resolveIndexedAsset(result.assetId)!.path)).toBe(await realpath(path.join(directory, 'photos', result.fileName)));
      expect(service.list(result.assetId)).toMatchObject([result]);
    } finally { service.close(); closeCatalog(); }
  });

  it('uses ordered reference images for a folder generation task', async () => {
    let requestPath = '';
    let requestBody = '';
    const { service, outputFolderId, directory, closeCatalog } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined, undefined, undefined, 'nanobanana-compatible',
      (url, body) => { requestPath = url ?? ''; requestBody = body; }, 200, true
    );
    try {
      const firstPath = path.join(directory, 'photos', 'first.png');
      const secondPath = path.join(directory, 'photos', 'second.png');
      await writeFile(firstPath, png);
      await writeFile(secondPath, png);
      const catalog = new CatalogService(path.join(directory, 'catalog.sqlite'));
      await catalog.synchronizeFolder(outputFolderId!);
      const ids = catalog.listAssets().filter((asset) => asset.fileName === 'first.png' || asset.fileName === 'second.png').sort((a, b) => b.fileName.localeCompare(a.fileName)).map((asset) => asset.id);
      catalog.close();
      const inputSources = ids.map((assetId) => ({ kind: 'asset' as const, assetId }));
      const result = await service.generate(null, {
        ...payload(), outputFolderId, textItemId: '8af36a1e-48d5-4c21-b99e-9aa4efcd8b13', inputSources
      });
      expect(requestPath).toBe('/v1/images/edits');
      expect(JSON.parse(requestBody).image).toEqual(Array(2).fill({ mime_type: 'image/jpeg', data: Buffer.from('bounded-preview').toString('base64') }));
      expect(result.inputSources).toEqual(inputSources);
      expect(service.list(result.assetId)[0]?.inputSources).toEqual(inputSources);
    } finally { service.close(); closeCatalog(); }
  });

  it('does not replay a paid generation POST after a gateway error', async () => {
    let requests = 0;
    const { service } = await fixture(
      () => ({ error: { message: 'gateway unavailable' } }),
      undefined, undefined, undefined, 'nanobanana-compatible',
      () => { requests += 1; }, 503
    );
    await expect(service.generate('asset-1', payload(), undefined, 'f88f9e7c-e90f-457e-9a8d-18f6d7f6ef2b'))
      .rejects.toThrow('PROVIDER_HTTP_503');
    expect(requests).toBe(1);
  });

  it('marks a successful provider response without an image as uncertain', async () => {
    const { service } = await fixture(() => ({ data: [] }));
    await expect(service.generate('asset-1', payload())).rejects.toMatchObject({ generationOutcomeUncertain: true });
    service.close();
  });

  it('marks an invalid image returned after a successful generation as uncertain', async () => {
    const { service } = await fixture(() => ({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }));
    await expect(service.generate('asset-1', payload())).rejects.toMatchObject({ generationOutcomeUncertain: true });
    service.close();
  });

  it('preserves the provider reason when generation is rejected with HTTP 403', async () => {
    const { service } = await fixture(
      () => ({ error: { message: 'model access denied for this account' } }),
      undefined,
      undefined,
      undefined,
      'nanobanana-compatible',
      undefined,
      403
    );

    await expect(service.generate('asset-1', payload()))
      .rejects.toThrow('PROVIDER_HTTP_403: model access denied for this account');
    service.close();
  });

  it('calls ACE Data Nano Banana edit API with the source image and downloads image_url output', async () => {
    let requestPath: string | undefined;
    let requestBody = '';
    const { service, directory } = await fixture(
      (origin) => ({ success: true, data: [{ image_url: `${origin}/result.png` }] }),
      png,
      undefined,
      undefined,
      'acedata-nano-banana',
      (url, body) => { requestPath = url; requestBody = body; }
    );

    const result = await service.generate('asset-1', payload());

    expect(requestPath).toBe('/v1/nano-banana/images');
    expect(JSON.parse(requestBody)).toMatchObject({
      action: 'edit', model: 'image-model', prompt: 'Remove background pedestrians', count: 1,
      image_urls: [`data:image/jpeg;base64,${Buffer.from('bounded-preview').toString('base64')}`]
    });
    expect(await readFile(path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId, result.fileName))).toEqual(png);
    service.close();
  });

  it('iterates from a same-photo AI result with its real MIME type and rejects other-photo sources', async () => {
    const requests: string[] = [];
    const { service } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }), undefined, undefined, undefined, 'nanobanana-compatible', (_url, body) => requests.push(body));
    try {
      const first = await service.generate('asset-1', payload());
      const second = await service.generate('asset-1', { ...payload(), sourceResultId: first.id });
      expect(JSON.parse(requests[1]!).image).toEqual({ mime_type: 'image/png', data: png.toString('base64') });
      expect(second.inputSources).toEqual([{ kind: 'result', resultId: first.id }]);
      expect(service.list('asset-1').find((item) => item.id === second.id)?.inputSources).toEqual(second.inputSources);
      await expect(service.generate('asset-other', { ...payload(), sourceResultId: first.id })).rejects.toThrow('GENERATION_SOURCE_RESULT_INVALID');
      expect(requests).toHaveLength(2);
    } finally { service.close(); }
  });

  it('sends ordered originals and generated results as distinct composition inputs', async () => {
    const requests: string[] = [];
    const { service } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }), undefined, undefined, undefined, 'nanobanana-compatible', (_url, body) => requests.push(body));
    try {
      const first = await service.generate('asset-1', payload());
      const inputs = [{ kind: 'result' as const, resultId: first.id }, { kind: 'asset' as const, assetId: 'asset-other' }];
      const composed = await service.generate('asset-1', { ...payload(), inputSources: inputs });
      expect(JSON.parse(requests[1]!).image).toEqual([
        { mime_type: 'image/png', data: png.toString('base64') },
        { mime_type: 'image/jpeg', data: Buffer.from('bounded-preview').toString('base64') }
      ]);
      expect(composed.inputSources).toEqual(inputs);
      expect(service.list('asset-1').find((item) => item.id === composed.id)?.inputSources).toEqual(inputs);
    } finally { service.close(); }
  });

  it('sends multiple ordered inputs to the ACE edit endpoint', async () => {
    const requests: string[] = [];
    const { service } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }), undefined, undefined, undefined, 'acedata-nano-banana', (_url, body) => requests.push(body));
    try {
      await service.generate('asset-1', { ...payload(), inputSources: [{ kind: 'asset', assetId: 'asset-1' }, { kind: 'asset', assetId: 'asset-other' }] });
      expect(JSON.parse(requests[0]!).image_urls).toEqual(Array(2).fill(`data:image/jpeg;base64,${Buffer.from('bounded-preview').toString('base64')}`));
    } finally { service.close(); }
  });

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

  it('preserves the previous manifest and removes staging files when an update fails', async () => {
    let publishCalls = 0;
    const publisher: ConstructorParameters<typeof GenerationService>[5] = async (destination, temporary) => {
      publishCalls += 1;
      if (publishCalls > 2) throw new Error('simulated manifest publish failure');
      await publishTemporaryFileSafely(destination, temporary);
    };
    const { service, directory } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined,
      publisher
    );
    await service.generate('asset-1', payload());
    const batchDirectory = path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId);
    const manifestPath = path.join(batchDirectory, 'manifest.json');
    const previousManifest = await readFile(manifestPath, 'utf8');

    await expect(service.generate('asset-1', payload(2))).rejects.toMatchObject({
      message: 'simulated manifest publish failure', generationOutcomeUncertain: true
    });

    expect(service.list('asset-1')).toHaveLength(1);
    expect(await readFile(manifestPath, 'utf8')).toBe(previousManifest);
    expect((await readdir(batchDirectory)).filter((name) => name.endsWith('.tmp') || name.includes('.previous'))).toEqual([]);
    service.close();
  });

  it('does not remove a competing destination when result publication fails', async () => {
    let destination = '';
    const publisher: ConstructorParameters<typeof GenerationService>[5] = async (target) => {
      destination = target;
      await writeFile(target, 'competing-result');
      throw new Error('simulated result publish failure');
    };
    const { service } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined,
      publisher
    );

    await expect(service.generate('asset-1', payload())).rejects.toThrow('simulated result publish failure');
    expect(await readFile(destination, 'utf8')).toBe('competing-result');
    service.close();
  });

  it('does not remove a result replaced by a competing file during later persistence', async () => {
    let resultDestination = '';
    let publishCalls = 0;
    const publisher: ConstructorParameters<typeof GenerationService>[5] = async (target, temporary) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        resultDestination = target;
        await publishTemporaryFileSafely(target, temporary);
        return;
      }
      await writeFile(resultDestination, 'competing-after-publish');
      throw new Error('simulated persistence failure');
    };
    const { service } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined,
      publisher
    );

    await expect(service.generate('asset-1', payload())).rejects.toThrow('simulated persistence failure');
    expect(await readFile(resultDestination, 'utf8')).toBe('competing-after-publish');
    service.close();
  });

  it('rejects a symbolic-link result destination without touching its target', async () => {
    let destination = '';
    const publisher: ConstructorParameters<typeof GenerationService>[5] = async (target, temporary) => {
      destination = target;
      const external = `${target}.external`;
      await writeFile(external, 'external-result');
      await symlink(external, target);
      await publishTemporaryFileSafely(target, temporary);
    };
    const { service } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined,
      publisher
    );

    await expect(service.generate('asset-1', payload())).rejects.toThrow('DESTINATION_NOT_REGULAR_FILE');
    expect(await readFile(`${destination}.external`, 'utf8')).toBe('external-result');
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    service.close();
  });

  it('surfaces a trash rollback failure instead of hiding the file/database mismatch', async () => {
    let publishCalls = 0;
    const publisher: ConstructorParameters<typeof GenerationService>[5] = async (destination, temporary) => {
      publishCalls += 1;
      if (publishCalls > 2) throw new Error('simulated trash manifest failure');
      await publishTemporaryFileSafely(destination, temporary);
    };
    let moveCalls = 0;
    const mover: ConstructorParameters<typeof GenerationService>[6] = async (source, destination) => {
      moveCalls += 1;
      if (moveCalls === 2) throw new Error('simulated trash rollback failure');
      await rename(source, destination);
    };
    const { service, directory } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined,
      publisher,
      mover
    );
    const result = await service.generate('asset-1', payload());

    await expect(service.trash(result.id)).rejects.toMatchObject({
      message: 'GENERATION_TRASH_ROLLBACK_FAILED',
      errors: [expect.objectContaining({ message: 'simulated trash manifest failure' }), expect.objectContaining({ message: 'simulated trash rollback failure' })]
    });
    expect(service.list('asset-1')).toHaveLength(1);
    expect(await stat(path.join(directory, 'managed', 'trash', 'generation', result.id, result.fileName))).toBeTruthy();
    service.close();
  });

  it('surfaces a restore rollback failure instead of hiding the file/database mismatch', async () => {
    let failRestoreManifest = false;
    const publisher: ConstructorParameters<typeof GenerationService>[5] = async (destination, temporary) => {
      if (failRestoreManifest) throw new Error('simulated restore manifest failure');
      await publishTemporaryFileSafely(destination, temporary);
    };
    let moveCalls = 0;
    const mover: ConstructorParameters<typeof GenerationService>[6] = async (source, destination) => {
      moveCalls += 1;
      if (moveCalls === 3) throw new Error('simulated restore rollback failure');
      await rename(source, destination);
    };
    const { service, directory } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined,
      publisher,
      mover
    );
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    failRestoreManifest = true;

    await expect(service.restore(result.id)).rejects.toMatchObject({
      message: 'GENERATION_RESTORE_ROLLBACK_FAILED',
      errors: [expect.objectContaining({ message: 'simulated restore manifest failure' }), expect.objectContaining({ message: 'simulated restore rollback failure' })]
    });
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    expect(await stat(path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId, result.fileName))).toBeTruthy();
    service.close();
  });

  it('downloads a localhost URL result', async () => {
    const { service } = await fixture((origin) => ({ images: [{ url: `${origin}/result.png` }] }), png);
    await expect(service.generate('asset-1', payload())).resolves.toMatchObject({ version: 1 });
    service.close();
  });

  it('keeps manifests isolated per asset when a batch spans multiple photos', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const first = await service.generate('asset-1', payload());
    const second = await service.generate('asset-2', payload());
    const firstManifest = JSON.parse(await readFile(path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId, 'manifest.json'), 'utf8')) as { assetId: string; results: Array<{ id: string }> };
    const secondManifest = JSON.parse(await readFile(path.join(directory, 'managed', 'generated', 'as', 'asset-2', batchId, 'manifest.json'), 'utf8')) as { assetId: string; results: Array<{ id: string }> };

    expect(firstManifest).toMatchObject({ assetId: 'asset-1', results: [{ id: first.id }] });
    expect(secondManifest).toMatchObject({ assetId: 'asset-2', results: [{ id: second.id }] });
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

  it('keeps a portable result linked after a catalog folder rename', async () => {
    const { service, directory, sourcePath, setSourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const oldDirectory = path.join(directory, 'old');
    await mkdir(oldDirectory);
    const oldSourcePath = path.join(oldDirectory, path.basename(sourcePath));
    await rename(sourcePath, oldSourcePath);
    setSourcePath(oldSourcePath);
    const catalog = new CatalogService(path.join(directory, 'catalog.sqlite'));
    try {
      await catalog.importFolders([oldDirectory]);
      const asset = catalog.listAssets()[0]!;
      const result = await service.generate(asset.id, { ...payload(), storageMode: 'portable' });
      const report = await catalog.renameFolder({ folderId: asset.folderId, name: 'new' });
      for (const item of report.relocations) await service.relocatePortableResults(
        item.assetId, item.previousPath, item.nextPath, item.previousFileName, item.nextFileName
      );
      const relocatedFile = service.resolveResultFile(result.id);
      expect(relocatedFile).toContain(path.join('new', '_PhotoAllIsAI'));
      expect(await readFile(relocatedFile!)).toEqual(png);
      expect(catalog.listAssets()[0]?.id).toBe(asset.id);
      expect(catalog.resolveAssetFile(asset.id)?.path).toBe(path.join(await realpath(path.join(directory, 'new')), path.basename(sourcePath)));
    } finally { catalog.close(); service.close(); }
  });

  it('keeps a portable result linked after an externally renamed child is scanned', async () => {
    const { service, directory, sourcePath, setSourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const photos = path.join(directory, 'photos');
    const oldDirectory = path.join(photos, 'old');
    await mkdir(oldDirectory, { recursive: true });
    const oldSourcePath = path.join(oldDirectory, path.basename(sourcePath));
    await rename(sourcePath, oldSourcePath);
    setSourcePath(oldSourcePath);
    const catalog = new CatalogService(path.join(directory, 'catalog.sqlite'));
    try {
      await catalog.importFolders([photos]);
      const asset = catalog.listAssets()[0]!;
      const result = await service.generate(asset.id, { ...payload(), storageMode: 'portable' });
      await rename(oldDirectory, path.join(photos, 'new'));
      expect(await catalog.synchronizeFolder(asset.folderId)).toEqual({ discovered: 0, offline: 0 });
      const relocations = catalog.takeExternalRelocations();
      expect(relocations).toHaveLength(1);
      for (const item of relocations) await service.relocatePortableResults(
        item.assetId, item.previousPath, item.nextPath, item.previousFileName, item.nextFileName
      );
      const relocatedFile = service.resolveResultFile(result.id);
      expect(relocatedFile).toContain(path.join('new', '_PhotoAllIsAI'));
      expect(await readFile(relocatedFile!)).toEqual(png);
      expect(catalog.listAssets()[0]?.id).toBe(asset.id);
    } finally { catalog.close(); service.close(); }
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

  it('moves a generated version into the managed trash and restores it without reusing its version', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const first = await service.generate('asset-1', payload());
    const originalPath = service.resolveResultFile(first.id)!;

    const trashed = await service.trash(first.id);

    expect(trashed).toMatchObject({ id: first.id, version: 1, trashedAt: expect.any(Number) });
    expect(service.list('asset-1')).toEqual([]);
    expect(service.resolveResultFile(first.id)).toBeNull();
    expect(service.listTrashed('asset-1')).toEqual([expect.objectContaining({ id: first.id })]);
    expect(() => service.updateReview({ resultId: first.id, reviewState: 'accepted' })).toThrow('GENERATION_RESULT_NOT_FOUND');
    await expect(stat(originalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const manifestPath = path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId, 'manifest.json');
    expect((JSON.parse(await readFile(manifestPath, 'utf8')) as { results: unknown[] }).results).toEqual([]);
    const second = await service.generate('asset-1', payload(2));
    expect(second.version).toBe(2);

    const restored = await service.restore(first.id);

    expect(restored).toMatchObject({ id: first.id, version: 1 });
    expect(await readFile(originalPath)).toEqual(png);
    expect(service.list('asset-1').map((result) => result.version)).toEqual([2, 1]);
    expect(service.listTrashed('asset-1')).toEqual([]);
    expect((JSON.parse(await readFile(manifestPath, 'utf8')) as { results: Array<{ version: number }> }).results.map((item) => item.version)).toEqual([1, 2]);
    service.close();
  });

  it('refuses to restore over an unexpected file and leaves the trashed version recoverable', async () => {
    const { service } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    const originalPath = service.resolveResultFile(result.id)!;
    await service.trash(result.id);
    await writeFile(originalPath, 'conflicting-file');

    await expect(service.restore(result.id)).rejects.toThrow('GENERATION_RESULT_RESTORE_CONFLICT');
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    expect(await readFile(originalPath, 'utf8')).toBe('conflicting-file');
    service.close();
  });

  it('summarizes and permanently clears only recycled generation files', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);

    await expect(service.getTrashSummary()).resolves.toEqual({
      resultCount: 1,
      totalBytes: png.byteLength,
      missingFiles: 0,
      unsafePaths: 0
    });
    await expect(service.emptyTrash()).resolves.toEqual({
      total: 1,
      purged: 1,
      missingFiles: 0,
      failed: 0,
      freedBytes: png.byteLength
    });
    expect(service.listTrashed('asset-1')).toEqual([]);
    const trashPath = path.join(directory, 'managed', 'trash', 'generation', result.id, result.fileName);
    await expect(stat(trashPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    service.close();
  });

  it('cleans missing recycle records but refuses paths outside the managed trash', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const missing = await service.generate('asset-1', payload());
    await service.trash(missing.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const missingPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(missing.id) as { trash_path: string }).trash_path;
    await rm(missingPath);

    await expect(service.emptyTrash()).resolves.toMatchObject({ total: 1, purged: 1, missingFiles: 1, failed: 0 });

    const unsafe = await service.generate('asset-1', { ...payload(), batchId: '74660466-cbed-4ad2-b21c-1abc569934f8' });
    await service.trash(unsafe.id);
    database.prepare('UPDATE generation_results SET trash_path = ? WHERE id = ?').run(sourcePath, unsafe.id);
    await expect(service.getTrashSummary()).resolves.toMatchObject({ resultCount: 1, unsafePaths: 1 });
    await expect(service.emptyTrash()).resolves.toMatchObject({ total: 1, purged: 0, failed: 1, freedBytes: 0 });
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    database.close();
    service.close();
  });

  it('recovers an interrupted legacy purge and is idempotent', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const trashPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(result.id) as { trash_path: string }).trash_path;
    const stagedPath = path.join(path.dirname(trashPath), `.${result.fileName}.234c97f1-19b8-4e24-aeda-2e6afebbf681.purge`);
    await rename(trashPath, stagedPath);

    await expect(service.recoverInterruptedTrashPurges()).resolves.toEqual({ total: 1, recovered: 1, conflicts: 0, failed: 0 });
    await expect(service.recoverInterruptedTrashPurges()).resolves.toEqual({ total: 0, recovered: 0, conflicts: 0, failed: 0 });
    expect(service.listTrashed('asset-1')).toEqual([]);
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    database.close();
    service.close();
  });

  it('finishes a persisted purge after its staged file was already deleted', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const trashPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(result.id) as { trash_path: string }).trash_path;
    const stagedPath = path.join(path.dirname(trashPath), `.${result.fileName}.${result.id}.purge`);
    database.prepare('UPDATE generation_results SET purge_path = ? WHERE id = ?').run(stagedPath, result.id);
    await rename(trashPath, stagedPath);
    await rm(stagedPath);

    await expect(service.emptyTrash()).resolves.toMatchObject({ total: 1, purged: 1, failed: 0 });
    expect(service.listTrashed('asset-1')).toEqual([]);
    database.close();
    service.close();
  });

  it('preserves both files when an interrupted purge has a conflict', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const trashPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(result.id) as { trash_path: string }).trash_path;
    const stagedPath = path.join(path.dirname(trashPath), `.${result.fileName}.${result.id}.purge`);
    await writeFile(stagedPath, 'unexpected-conflict');
    database.prepare('UPDATE generation_results SET purge_path = ? WHERE id = ?').run(stagedPath, result.id);

    await expect(service.recoverInterruptedTrashPurges()).resolves.toEqual({ total: 1, recovered: 0, conflicts: 1, failed: 0 });
    await expect(service.emptyTrash()).resolves.toMatchObject({ total: 1, purged: 0, failed: 1 });
    expect(await readFile(trashPath)).toEqual(png);
    expect(await readFile(stagedPath, 'utf8')).toBe('unexpected-conflict');
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    database.close();
    service.close();
  });

  it('does not follow a recycled result directory replaced by a symbolic link', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const trashPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(result.id) as { trash_path: string }).trash_path;
    const resultDirectory = path.dirname(trashPath);
    await rm(resultDirectory, { recursive: true });
    await symlink(path.dirname(sourcePath), resultDirectory);
    const outsidePath = path.join(path.dirname(sourcePath), result.fileName);
    await writeFile(outsidePath, 'outside-managed-trash');

    await expect(service.emptyTrash()).resolves.toMatchObject({ total: 1, purged: 0, failed: 1 });
    await expect(service.restore(result.id)).rejects.toThrow('GENERATION_RESULT_TRASH_PATH_UNSAFE');
    expect(await readFile(outsidePath, 'utf8')).toBe('outside-managed-trash');
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    database.close();
    service.close();
  });

  it('ignores unknown and symbolic-link files during purge recovery', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const trashPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(result.id) as { trash_path: string }).trash_path;
    await rm(trashPath);
    const unknownPath = path.join(path.dirname(trashPath), '.unrelated.purge');
    const linkedPath = path.join(path.dirname(trashPath), `.${result.fileName}.b61d6955-dd2d-4437-8e71-260759e645b1.purge`);
    await writeFile(unknownPath, 'keep-me');
    await symlink(sourcePath, linkedPath);

    await expect(service.recoverInterruptedTrashPurges()).resolves.toEqual({ total: 1, recovered: 0, conflicts: 0, failed: 1 });
    expect(await readFile(unknownPath, 'utf8')).toBe('keep-me');
    expect(await readFile(linkedPath, 'utf8')).toBe('untouched-original');
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    database.close();
    service.close();
  });

  it('reports multiple legacy purge candidates as a conflict and preserves them', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const trashPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(result.id) as { trash_path: string }).trash_path;
    await rm(trashPath);
    const first = path.join(path.dirname(trashPath), `.${result.fileName}.a41a88f1-6a54-4d63-b37f-82e9a19c065e.purge`);
    const second = path.join(path.dirname(trashPath), `.${result.fileName}.8c688e90-d24b-4721-a6f3-1cbbe8b5a4c3.purge`);
    await writeFile(first, 'first');
    await writeFile(second, 'second');

    await expect(service.recoverInterruptedTrashPurges()).resolves.toEqual({ total: 1, recovered: 0, conflicts: 1, failed: 0 });
    expect(await readFile(first, 'utf8')).toBe('first');
    expect(await readFile(second, 'utf8')).toBe('second');
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    database.close();
    service.close();
  });

  it('leaves missing records and unsafe purge paths untouched during startup recovery', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    await service.trash(result.id);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    const trashPath = (database.prepare('SELECT trash_path FROM generation_results WHERE id = ?').get(result.id) as { trash_path: string }).trash_path;
    await rm(trashPath);

    await expect(service.recoverInterruptedTrashPurges()).resolves.toEqual({ total: 0, recovered: 0, conflicts: 0, failed: 0 });
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    database.prepare('UPDATE generation_results SET purge_path = ? WHERE id = ?').run(sourcePath, result.id);
    await expect(service.recoverInterruptedTrashPurges()).resolves.toEqual({ total: 1, recovered: 0, conflicts: 0, failed: 1 });
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    expect(service.listTrashed('asset-1')).toHaveLength(1);
    database.close();
    service.close();
  });

  it('preserves a published image without a result row for reconciliation', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    const filePath = service.resolveResultFile(result.id)!;
    const temporaryPath = `${filePath}.4321.60cae5ec-b718-41a2-8389-b87c4db28edf.tmp`;
    await writeFile(temporaryPath, 'interrupted-temporary-payload');
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare('DELETE FROM generation_results WHERE id = ?').run(result.id);
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run(result.id, 'asset-1', batchId, result.fileName, filePath, temporaryPath, Date.now());

    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 0, failed: 1 });
    expect(await readFile(filePath)).toEqual(png);
    expect(await readFile(temporaryPath, 'utf8')).toBe('interrupted-temporary-payload');
    const manifest = JSON.parse(await readFile(path.join(path.dirname(filePath), 'manifest.json'), 'utf8')) as { results: unknown[] };
    expect(manifest.results).toHaveLength(1);
    expect((database.prepare('SELECT COUNT(*) AS value FROM generation_write_intents').get() as { value: number }).value).toBe(1);
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    database.close();
    service.close();
  });

  it('cleans an interrupted write before its result file was published', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const filePath = path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId, 'pending.png');
    const temporaryPath = `${filePath}.4321.60cae5ec-b718-41a2-8389-b87c4db28edf.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(temporaryPath, 'incomplete-temporary-payload');
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run('pending-unpublished', 'asset-1', batchId, 'pending.png', filePath, temporaryPath, Date.now());

    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 1, failed: 0 });
    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((database.prepare('SELECT COUNT(*) AS value FROM generation_write_intents').get() as { value: number }).value).toBe(0);
    database.close();
    service.close();
  });

  it('keeps a committed generated result when startup finds its stale write intent', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    const filePath = service.resolveResultFile(result.id)!;
    const temporaryPath = `${filePath}.4321.60cae5ec-b718-41a2-8389-b87c4db28edf.tmp`;
    await writeFile(temporaryPath, 'stale-temporary-payload');
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run(result.id, 'asset-1', batchId, result.fileName, filePath, temporaryPath, Date.now());
    await writeFile(path.join(path.dirname(filePath), 'manifest.json'), '{"results":[]}');

    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 1, failed: 0 });
    expect(service.list('asset-1').map((item) => item.id)).toContain(result.id);
    expect(await readFile(filePath)).toEqual(png);
    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(path.join(path.dirname(filePath), 'manifest.json'), 'utf8')) as { results: Array<{ id: string }> };
    expect(manifest.results.map((item) => item.id)).toContain(result.id);
    expect((database.prepare('SELECT COUNT(*) AS value FROM generation_write_intents').get() as { value: number }).value).toBe(0);
    database.close();
    service.close();
  });

  it('finds a committed generation by its stable task ID only while its file exists', async () => {
    const { service } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const taskId = 'd012fd4c-8cf6-4663-ab1b-4db814a718e1';
    const result = await service.generate('asset-1', payload(), undefined, taskId);
    expect((await service.findCommittedTaskResult(taskId))?.id).toBe(result.id);
    await rm(service.resolveResultFile(result.id)!);
    expect(await service.findCommittedTaskResult(taskId)).toBeNull();
    service.close();
  });

  it('does not reconcile a committed task to an empty or wrong-format image', async () => {
    const { service } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const taskId = '56143662-63d9-4f15-8936-29b8e1150c93';
    const result = await service.generate('asset-1', payload(), undefined, taskId);
    const filePath = service.resolveResultFile(result.id)!;
    await writeFile(filePath, Buffer.alloc(0));
    expect(await service.findCommittedTaskResult(taskId)).toBeNull();
    await writeFile(filePath, Buffer.from('not-a-png-image'));
    expect(await service.findCommittedTaskResult(taskId)).toBeNull();
    await expect(service.generate('asset-1', payload(), undefined, taskId)).rejects.toThrow('GENERATION_RESULT_UNCERTAIN');
    service.close();
  });

  it('returns a committed task result without sending another paid generation request', async () => {
    let requests = 0;
    const { service } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined, undefined, undefined, 'nanobanana-compatible', () => { requests += 1; }
    );
    const taskId = 'a889fa84-a960-4fa8-bbd7-c05b2730cc4f';
    const first = await service.generate('asset-1', payload(), undefined, taskId);
    const second = await service.generate('asset-1', payload(), undefined, taskId);
    expect(second.id).toBe(first.id);
    await expect(service.generate('asset-1', {
      ...payload(), inputSources: [{ kind: 'asset', assetId: 'asset-1' }, { kind: 'asset', assetId: 'other-asset' }]
    }, undefined, taskId)).rejects.toThrow('GENERATION_TASK_RESULT_CONFLICT');
    await expect(service.generate('asset-1', {
      ...payload(), templateId: '66a30ee9-bdca-44df-acd4-af42379c68a9', templateVersion: 1
    }, undefined, taskId)).rejects.toThrow('GENERATION_TASK_RESULT_CONFLICT');
    expect(requests).toBe(1);
    expect(service.list('asset-1')).toHaveLength(1);
    service.close();
  });

  it('does not resend a paid request while the same task has an unresolved write intent', async () => {
    let requests = 0;
    const { service, directory } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined, undefined, undefined, 'nanobanana-compatible', () => { requests += 1; }
    );
    const taskId = 'b31e18bf-31e3-4322-8ae7-6ad880665361';
    const filePath = path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId, 'pending.png');
    const temporaryPath = `${filePath}.4321.60cae5ec-b718-41a2-8389-b87c4db28edf.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, png);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, task_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run('pending-result', taskId, 'asset-1', batchId, 'pending.png', filePath, temporaryPath, Date.now());

    await expect(service.generate('asset-1', payload(), undefined, taskId)).rejects.toThrow('GENERATION_RESULT_UNCERTAIN');
    expect(requests).toBe(0);
    expect(await readFile(filePath)).toEqual(png);
    database.close();
    service.close();
  });

  it('keeps a task-linked temporary write on restart and blocks a later paid retry', async () => {
    let requests = 0;
    const { service, directory } = await fixture(
      () => ({ data: [{ b64_json: png.toString('base64') }] }),
      undefined, undefined, undefined, 'nanobanana-compatible', () => { requests += 1; }
    );
    const taskId = '7bc454d9-a78b-4d60-8aee-26727d8d5211';
    const filePath = path.join(directory, 'managed', 'generated', 'as', 'asset-1', batchId, 'pending.png');
    const temporaryPath = `${filePath}.4321.60cae5ec-b718-41a2-8389-b87c4db28edf.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(temporaryPath, png);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, task_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run('pending-task-result', taskId, 'asset-1', batchId, 'pending.png', filePath, temporaryPath, Date.now());

    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 0, failed: 1 });
    expect(await readFile(temporaryPath)).toEqual(png);
    expect((database.prepare('SELECT task_id FROM generation_write_intents WHERE result_id = ?').get('pending-task-result') as { task_id: string }).task_id).toBe(taskId);
    await expect(service.generate('asset-1', payload(), undefined, taskId)).rejects.toThrow('GENERATION_RESULT_UNCERTAIN');
    expect(requests).toBe(0);
    database.close();
    service.close();
  });

  it('reconciles a persisted generation task after a crash between result commit and task completion', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const databaseFile = path.join(directory, 'catalog.sqlite');
    let tasks = new TaskService(databaseFile);
    const task = tasks.enqueue({ kind: 'generation', assetId: 'asset-1', payload: payload() });
    tasks.claimNext(['generation']);
    tasks.advance(task.id, 'processing', 0.5);
    const result = await service.generate('asset-1', payload(), undefined, task.id);
    tasks.close();
    tasks = new TaskService(databaseFile);
    expect(tasks.find(task.id)).toMatchObject({ status: 'failed', errorCode: 'GENERATION_RESULT_UNCERTAIN' });
    await service.recoverInterruptedWrites();
    for (const taskId of tasks.uncertainGenerationTaskIds()) {
      const committed = await service.findCommittedTaskResult(taskId);
      if (committed) tasks.recoverCommittedGeneration(taskId, committed);
    }
    expect(tasks.find(task.id)).toMatchObject({ status: 'completed', result: { generation: { id: result.id } } });
    tasks.close();
    service.close();
  });

  it('leaves a committed result for review when its file is missing during recovery', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    const filePath = service.resolveResultFile(result.id)!;
    const temporaryPath = `${filePath}.4321.60cae5ec-b718-41a2-8389-b87c4db28edf.tmp`;
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run(result.id, 'asset-1', batchId, result.fileName, filePath, temporaryPath, Date.now());
    await rm(filePath);

    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 0, failed: 1 });
    expect(service.list('asset-1').map((item) => item.id)).toContain(result.id);
    expect((database.prepare('SELECT COUNT(*) AS value FROM generation_write_intents').get() as { value: number }).value).toBe(1);
    database.close();
    service.close();
  });

  it('preserves unsafe and symbolically redirected interrupted writes', async () => {
    const { service, directory, sourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', payload());
    const filePath = service.resolveResultFile(result.id)!;
    const batchDirectory = path.dirname(filePath);
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare('DELETE FROM generation_results WHERE id = ?').run(result.id);
    await rm(batchDirectory, { recursive: true });
    await symlink(path.dirname(sourcePath), batchDirectory);
    const redirectedFile = path.join(path.dirname(sourcePath), result.fileName);
    await writeFile(redirectedFile, 'outside-managed-generation');
    const temporaryPath = `${filePath}.4321.d2c46ddb-97a7-427c-9520-c6a137c8fadc.tmp`;
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run(result.id, 'asset-1', batchId, result.fileName, filePath, temporaryPath, Date.now());

    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 0, failed: 1 });
    expect(await readFile(redirectedFile, 'utf8')).toBe('outside-managed-generation');
    expect(await readFile(sourcePath, 'utf8')).toBe('untouched-original');
    expect((database.prepare('SELECT COUNT(*) AS value FROM generation_write_intents').get() as { value: number }).value).toBe(1);
    database.close();
    service.close();
  });

  it('preserves an interrupted write when an existing parent is a symbolic link', async () => {
    const { service, directory } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const generatedRoot = path.join(directory, 'managed', 'generated');
    const linkedPrefix = path.join(generatedRoot, 'as');
    const outside = path.join(directory, 'outside-generated');
    await mkdir(generatedRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, linkedPrefix, process.platform === 'win32' ? 'junction' : 'dir');
    const fileName = 'pending.png';
    const filePath = path.join(linkedPrefix, 'asset-1', batchId, fileName);
    const temporaryPath = `${filePath}.4321.a014e63f-9674-4d47-97d0-ccee7bbf5575.tmp`;
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'managed', ?)
    `).run('pending-parent-link', 'asset-1', batchId, fileName, filePath, temporaryPath, Date.now());

    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 0, failed: 1 });
    expect((database.prepare('SELECT COUNT(*) AS value FROM generation_write_intents').get() as { value: number }).value).toBe(1);
    database.close();
    service.close();
  });

  it('relocates an interrupted portable write with its original', async () => {
    const { service, directory, sourcePath, setSourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', { ...payload(), storageMode: 'portable' });
    const filePath = service.resolveResultFile(result.id)!;
    const temporaryPath = `${filePath}.4321.785c8b89-1d25-4d82-af73-37286ce03d10.tmp`;
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare('DELETE FROM generation_results WHERE id = ?').run(result.id);
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'portable', ?)
    `).run(result.id, 'asset-1', batchId, result.fileName, filePath, temporaryPath, Date.now());
    const movedDirectory = path.join(directory, 'moved');
    const nextSourcePath = path.join(movedDirectory, 'RENAMED.CR3');
    await mkdir(movedDirectory, { recursive: true });
    await rename(sourcePath, nextSourcePath);
    setSourcePath(nextSourcePath);

    await service.relocatePortableResults('asset-1', sourcePath, nextSourcePath, 'IMG_1024.CR3', 'RENAMED.CR3');
    const intent = database.prepare(`
      SELECT file_path, temporary_path FROM generation_write_intents WHERE result_id = ?
    `).get(result.id) as { file_path: string; temporary_path: string };
    expect(intent.file_path).toContain(path.join('moved', '_PhotoAllIsAI', 'RENAMED__ASSET1'));
    expect(intent.temporary_path).toBe(`${intent.file_path}.4321.785c8b89-1d25-4d82-af73-37286ce03d10.tmp`);
    await expect(service.recoverInterruptedWrites()).resolves.toEqual({ total: 1, recovered: 0, failed: 1 });
    expect(await readFile(intent.file_path)).toEqual(png);
    database.close();
    service.close();
  });

  it('does not redirect a portable write intent when relocation has a directory conflict', async () => {
    const { service, directory, sourcePath, setSourcePath } = await fixture(() => ({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await service.generate('asset-1', { ...payload(), storageMode: 'portable' });
    const filePath = service.resolveResultFile(result.id)!;
    const temporaryPath = `${filePath}.4321.29a81331-b5d0-46b1-846c-3137b4849096.tmp`;
    const database = new DatabaseSync(path.join(directory, 'catalog.sqlite'));
    database.prepare('DELETE FROM generation_results WHERE id = ?').run(result.id);
    database.prepare(`
      INSERT INTO generation_write_intents (
        result_id, asset_id, batch_id, file_name, file_path, temporary_path, storage_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'portable', ?)
    `).run(result.id, 'asset-1', batchId, result.fileName, filePath, temporaryPath, Date.now());
    const nextSourcePath = path.join(directory, 'moved', 'RENAMED.CR3');
    const conflictingDirectory = path.join(directory, 'moved', '_PhotoAllIsAI', 'RENAMED__ASSET1');
    await mkdir(conflictingDirectory, { recursive: true });
    await writeFile(nextSourcePath, 'moved-original');
    setSourcePath(nextSourcePath);

    await service.relocatePortableResults('asset-1', sourcePath, nextSourcePath, 'IMG_1024.CR3', 'RENAMED.CR3');
    const intent = database.prepare('SELECT file_path FROM generation_write_intents WHERE result_id = ?')
      .get(result.id) as { file_path: string };
    expect(intent.file_path).toBe(filePath);
    expect(await readFile(filePath)).toEqual(png);
    database.close();
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

  it('allows localhost results only for localhost providers', () => {
    expect(validateGeneratedImageUrl('http://127.0.0.1:8080/v1', 'http://localhost:9000/image.png').hostname)
      .toBe('localhost');
    expect(() => validateGeneratedImageUrl('https://api.example.com/v1', 'http://127.0.0.1:9000/image.png'))
      .toThrow('GENERATED_IMAGE_URL_PRIVATE');
  });

  it('rejects embedded credentials in generated image URLs', () => {
    expect(() => validateGeneratedImageUrl('https://api.example.com/v1', 'https://user:secret@cdn.example.com/image.png'))
      .toThrow('GENERATED_IMAGE_URL_UNSAFE');
  });
});
