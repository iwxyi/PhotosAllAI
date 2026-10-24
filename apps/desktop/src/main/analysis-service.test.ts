import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisResult, ProviderProfile } from '@photoallisai/contracts';

import { AnalysisService, analysisHttpErrorCode, analysisLanguageInstruction } from './analysis-service';

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
  it('localizes prose without translating schema identifiers or OCR text', () => {
    expect(analysisLanguageInstruction('zh-CN')).toContain('Simplified Chinese');
    expect(analysisLanguageInstruction('en-US')).toContain('English');
    expect(analysisLanguageInstruction('zh-CN')).toContain('Preserve OCR text');
  });
  it.each([
    [400, { error: { code: 'model_not_found', message: 'private data' } }, 'PROVIDER_MODEL_UNAVAILABLE'],
    [404, { error: { message: 'The model does not exist' } }, 'PROVIDER_MODEL_UNAVAILABLE'],
    [400, { error: { message: 'response_format is not supported' } }, 'PROVIDER_JSON_MODE_UNSUPPORTED'],
    [400, { error: { message: 'Image input is not supported' } }, 'PROVIDER_IMAGE_INPUT_UNSUPPORTED'],
    [400, { error: { message: 'private prompt with response_format and image_url' } }, 'PROVIDER_HTTP_400'],
    [401, { error: { code: 'invalid_model' } }, 'PROVIDER_HTTP_401']
  ])('classifies HTTP %s without exposing raw service errors', (status, body, expected) => {
    expect(analysisHttpErrorCode(status, JSON.stringify(body))).toBe(expected);
    expect(analysisHttpErrorCode(status, '<html>private data</html>')).toBe(`PROVIDER_HTTP_${status}`);
  });

  it.each([
    ['\uFEFF{"choices":[{"message":{"content":"{}"}}]}', 'ANALYSIS_RESPONSE_SCHEMA_INVALID'],
    ['data: {"choices":[{"message":{"content":"{}"}}]}\n\ndata: [DONE]\n', 'ANALYSIS_RESPONSE_SCHEMA_INVALID'],
    ['data: {"choices":[{"index":0,"delta":{"content":"{"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"}"}}]}\n\ndata: [DONE]\n', 'ANALYSIS_RESPONSE_SCHEMA_INVALID'],
    ['```json\n{"choices":[{"message":{"content":"{}"}}]}\n```', 'ANALYSIS_RESPONSE_SCHEMA_INVALID'],
    ['provider prefix {"choices":[{"message":{"content":"{}"}}]} trailing text', 'ANALYSIS_RESPONSE_SCHEMA_INVALID']
  ])('accepts compatible response envelope %s', async (body, code) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-analysis-envelope-'));
    temporaryDirectories.push(directory);
    const previewPath = path.join(directory, 'preview.jpg');
    await writeFile(previewPath, 'image-fixture');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const profile: ProviderProfile = {
      id: 'aa2888b2-4f07-4598-a876-710d702d14da', name: 'Vision', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'vision-model', requestTimeoutMs: 1_000,
      retryCount: 0, customHeaders: {}, hasCredential: true, enabled: true, updatedAt: Date.now()
    };
    const analysis = new AnalysisService(path.join(directory, 'catalog.sqlite'),
      { resolve: async () => ({ profile, apiKey: 'test-key' }) }, { getOrCreate: async () => previewPath });
    try {
      await expect(analysis.analyze('asset-1', profile.id)).rejects.toThrow(code);
    } finally {
      analysis.close();
    }
  });

  it.each([
    ['not-json', 'PROVIDER_RESPONSE_NOT_JSON'],
    ['<!doctype html><html><body>Website</body></html>', 'PROVIDER_RESPONSE_HTML'],
    ['', 'PROVIDER_RESPONSE_EMPTY'],
    [JSON.stringify({ choices: [{ message: { content: 'invalid analysis JSON' } }] }), 'ANALYSIS_CONTENT_NOT_JSON'],
    [JSON.stringify({ choices: [{ message: { content: '{}' } }] }), 'ANALYSIS_RESPONSE_SCHEMA_INVALID'],
    [JSON.stringify({ choices: [] }), 'PROVIDER_RESPONSE_INVALID'],
    [JSON.stringify({ error: { message: 'response_format is not supported' } }), 'PROVIDER_JSON_MODE_UNSUPPORTED', 400]
  ] as const)('classifies invalid analysis responses (%s)', async (body, code, status: number = 200) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-analysis-error-'));
    temporaryDirectories.push(directory);
    const previewPath = path.join(directory, 'preview.jpg');
    await writeFile(previewPath, 'image-fixture');
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const profile: ProviderProfile = {
      id: 'aa2888b2-4f07-4598-a876-710d702d14da', name: 'Vision', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'vision-model', requestTimeoutMs: 1_000,
      retryCount: 0, customHeaders: {}, hasCredential: true, enabled: true, updatedAt: Date.now()
    };
    const analysis = new AnalysisService(path.join(directory, 'catalog.sqlite'),
      { resolve: async () => ({ profile, apiKey: 'test-key' }) }, { getOrCreate: async () => previewPath });
    try {
      await expect(analysis.analyze('asset-1', profile.id)).rejects.toThrow(code);
      expect(analysis.list('asset-1')).toEqual([]);
    } finally {
      analysis.close();
    }
  });

  it.each(['zh-CN', 'en-US'] as const)('validates and persists a structured model response in %s', async (locale) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-analysis-'));
    temporaryDirectories.push(directory);
    const previewPath = path.join(directory, 'preview.jpg');
    await writeFile(previewPath, 'bounded-image-fixture');

    let requestBody = '';
    const server = createServer(async (request, response) => {
      for await (const chunk of request) requestBody += String(chunk);
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
      modelId: 'vision-model', requestTimeoutMs: 300_000, retryCount: 2, customHeaders: {},
      hasCredential: true, enabled: true, updatedAt: Date.now()
    };
    const analysis = new AnalysisService(
      path.join(directory, 'catalog.sqlite'),
      { resolve: async () => ({ profile, apiKey: 'test-key' }) },
      { getOrCreate: async () => previewPath },
      async () => locale
    );

    const revision = await analysis.analyze('asset-1', profile.id);
    expect(requestBody).toContain('overallScore');
    expect(requestBody).toContain('generationRecommendation');
    expect(JSON.parse(requestBody).messages[0].content).toContain(locale === 'zh-CN' ? 'Simplified Chinese' : 'English');
    expect(JSON.parse(requestBody).stream).toBe(false);
    // Some compatible gateways validate only user text when JSON mode is enabled.
    expect(JSON.parse(requestBody).messages[1].content[0].text).toContain('JSON');
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
      modelId: 'image-model', requestTimeoutMs: 300_000, retryCount: 2, customHeaders: {},
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

  it('uses existing per-photo analyses for provider-backed collection review and rejects unknown ids', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'photoallisai-collection-analysis-'));
    temporaryDirectories.push(directory);
    const previewPath = path.join(directory, 'preview.jpg');
    await writeFile(previewPath, 'bounded-image-fixture');
    const collectionResult = {
      summary: '两张夜景人像高度相似。',
      groups: [{ title: '重复构图', assetIds: ['asset-1', 'asset-2', 'invented-id'], reason: '主体和机位相同' }],
      keepAssetIds: ['asset-1', 'invented-id'],
      reviewAssetIds: ['asset-2'],
      recommendations: ['保留质量分更高的版本']
    };
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const content = body.includes('photo collection') ? collectionResult : result;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const profile: ProviderProfile = {
      id: 'aa2888b2-4f07-4598-a876-710d702d14da', name: 'Vision', kind: 'openai-compatible', purpose: 'vision',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'vision-model', requestTimeoutMs: 300_000,
      retryCount: 0, customHeaders: {}, hasCredential: true, enabled: true, updatedAt: Date.now()
    };
    const analysis = new AnalysisService(path.join(directory, 'catalog.sqlite'), { resolve: async () => ({ profile, apiKey: 'test-key' }) }, { getOrCreate: async () => previewPath });
    await analysis.analyze('asset-1', profile.id);
    await analysis.analyze('asset-2', profile.id);

    await expect(analysis.analyzeCollection(['asset-1', 'asset-2'], profile.id)).resolves.toEqual({
      summary: collectionResult.summary,
      groups: [{ ...collectionResult.groups[0], assetIds: ['asset-1', 'asset-2'] }],
      keepAssetIds: ['asset-1'],
      reviewAssetIds: ['asset-2'],
      recommendations: collectionResult.recommendations
    });
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
      modelId: 'vision-model', requestTimeoutMs: 10_000, retryCount: 1, customHeaders: {},
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
