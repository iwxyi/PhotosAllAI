import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisResult, ProviderProfile } from '@photoallisai/contracts';

import { AnalysisService } from './analysis-service';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

const result: AnalysisResult = {
  schemaVersion: '1.0', summary: '夜景人像', report: '主体清晰，背景有路人。',
  quality: { overallScore: 82, issues: [{ type: 'background_distraction', severity: 0.7, confidence: 0.9, description: '背景路人干扰主体' }] },
  adjustments: { global: [{ parameter: 'exposure', value: 0.2, unit: 'EV', confidence: 0.8, reason: '面部略暗' }], local: [] },
  generativeActions: [{ id: 'remove-1', type: 'remove_object', target: '背景路人', region: null, instruction: '移除背景路人', preserve: ['主体身份'], risk: 'medium', confidence: 0.9, enabled: true }],
  catalog: { shortDescription: '城市夜景人像', longDescription: '人物位于城市街道。', scenes: ['城市夜景'], subjects: ['单人'], objects: ['人物', '路人'], mood: ['都市'], colors: ['蓝色'], keywords: ['夜景人像'], ocrText: '' },
  generationRecommendation: { recommended: true, templateId: null, reason: '需要清除路人' }
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('OpenAI-compatible visual analysis', () => {
  it('validates and persists a structured model response', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-analysis-'));
    temporaryDirectories.push(directory);
    const previewPath = path.join(directory, 'preview.jpg');
    await writeFile(previewPath, 'bounded-image-fixture');

    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');

    const profile: ProviderProfile = {
      id: 'aa2888b2-4f07-4598-a876-710d702d14da', name: 'Vision',
      kind: 'openai-compatible', purpose: 'vision', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'vision-model', requestTimeoutMs: 300_000, retryCount: 2,
      hasCredential: true, enabled: true, updatedAt: Date.now()
    };
    const analysis = new AnalysisService(
      path.join(directory, 'catalog.sqlite'),
      { resolve: async () => ({ profile, apiKey: 'test-key' }) },
      { getOrCreate: async () => previewPath }
    );

    const revision = await analysis.analyze('asset-1', profile.id);
    expect(revision.result.summary).toBe('夜景人像');
    expect(analysis.list('asset-1')).toEqual([revision]);
    analysis.close();
  });

  it('rejects a provider assigned to generation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-analysis-'));
    temporaryDirectories.push(directory);
    const profile: ProviderProfile = {
      id: 'aa2888b2-4f07-4598-a876-710d702d14da', name: 'Generator',
      kind: 'nanobanana-compatible', purpose: 'generation', baseUrl: 'https://example.com/v1',
      modelId: 'image-model', requestTimeoutMs: 300_000, retryCount: 2,
      hasCredential: true, enabled: true, updatedAt: Date.now()
    };
    const analysis = new AnalysisService(
      path.join(directory, 'catalog.sqlite'),
      { resolve: async () => ({ profile, apiKey: 'test-key' }) },
      { getOrCreate: async () => null }
    );
    await expect(analysis.analyze('asset-1', profile.id)).rejects.toThrow('PROVIDER_DOES_NOT_SUPPORT_VISION');
    analysis.close();
  });

  it('uses the provider retry policy for transient analysis failures', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-analysis-retry-'));
    temporaryDirectories.push(directory);
    const previewPath = path.join(directory, 'preview.jpg');
    await writeFile(previewPath, 'bounded-image-fixture');
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(429, { 'retry-after': '0' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');

    const profile: ProviderProfile = {
      id: 'e0668a39-803b-483e-91c4-8a36f95fbf44', name: 'Retry Vision',
      kind: 'openai-compatible', purpose: 'vision', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'vision-model', requestTimeoutMs: 10_000, retryCount: 1,
      hasCredential: true, enabled: true, updatedAt: Date.now()
    };
    const analysis = new AnalysisService(
      path.join(directory, 'catalog.sqlite'),
      { resolve: async () => ({ profile, apiKey: 'test-key' }) },
      { getOrCreate: async () => previewPath }
    );

    await expect(analysis.analyze('asset-retry', profile.id)).resolves.toMatchObject({ assetId: 'asset-retry' });
    expect(attempts).toBe(2);
    analysis.close();
  });
});
