import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
  analysisResultSchema,
  analysisRevisionSchema,
  collectionAnalysisReportSchema,
  type AnalysisResult,
  type AnalysisRevision,
  type CollectionAnalysisReport
} from '@photoallisai/contracts';

import type { ImageCacheService } from './image-cache-service';
import { fetchBounded } from './network-safety';
import type { ProviderService } from './provider-service';
import { createProviderRequestHeaders } from './provider-request-headers';
import { normalizeSearchText, tokenizeSearchText } from './search-index';

type ProviderResolver = Pick<ProviderService, 'resolve'>;
type AnalysisImageSource = Pick<ImageCacheService, 'getOrCreate'>;

type RevisionRow = {
  id: string;
  asset_id: string;
  provider_profile_id: string;
  result_json: string;
  created_at: number;
};

const SYSTEM_PROMPT = `You are a professional photography analysis engine. Return only JSON matching schema version 1.0. Analyze image content, technical quality, deterministic adjustment suggestions, generative editing actions, and searchable catalog metadata. Never guess a person's identity or an exact location. Coordinates use normalized_box with x, y, width, height in 0..1. All confidence and severity values use 0..1.`;
const COLLECTION_SYSTEM_PROMPT = `You are a professional photo editor reviewing a collection. Return only JSON with: summary, groups[{title,assetIds,reason}], keepAssetIds, reviewAssetIds, recommendations. Compare similarity, technical quality, storytelling value, and redundancy. Use only the supplied assetIds. Do not identify people or infer exact locations.`;
const MAX_ANALYSIS_RESPONSE_BYTES = 5_000_000;
const ANALYSIS_TIMEOUT_MS = 2 * 60 * 1_000;
const ANALYSIS_RESPONSE_SCHEMA = JSON.stringify(z.toJSONSchema(analysisResultSchema));

export class AnalysisService {
  readonly #database: DatabaseSync;
  readonly #providers: ProviderResolver;
  readonly #images: AnalysisImageSource;
  readonly #locale: () => Promise<'zh-CN' | 'en-US'>;

  constructor(
    databasePath: string,
    providers: ProviderResolver,
    images: AnalysisImageSource,
    locale: () => Promise<'zh-CN' | 'en-US'> = async () => 'zh-CN'
  ) {
    this.#providers = providers;
    this.#images = images;
    this.#locale = locale;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS analysis_revisions (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analysis_asset_idx
        ON analysis_revisions(asset_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS asset_search (
        asset_id TEXT PRIMARY KEY,
        normalized_content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS asset_search_tokens (
        asset_id TEXT NOT NULL,
        token TEXT NOT NULL,
        PRIMARY KEY (asset_id, token)
      );
      CREATE INDEX IF NOT EXISTS asset_search_token_idx ON asset_search_tokens(token, asset_id);
    `);
  }

  close(): void {
    this.#database.close();
  }

  list(assetId: string): AnalysisRevision[] {
    return (this.#database.prepare(`
      SELECT id, asset_id, provider_profile_id, result_json, created_at
      FROM analysis_revisions WHERE asset_id = ? ORDER BY created_at DESC
    `).all(assetId) as RevisionRow[]).map((row) => this.#toRevision(row));
  }

  async analyze(assetId: string, providerProfileId: string, signal?: AbortSignal, locale?: 'zh-CN' | 'en-US'): Promise<AnalysisRevision> {
    const language = analysisLanguageInstruction(locale ?? await this.#locale());
    const provider = await this.#providers.resolve(providerProfileId);
    if (provider.profile.purpose !== 'vision' || provider.profile.kind !== 'openai-compatible') {
      throw new Error('PROVIDER_DOES_NOT_SUPPORT_VISION');
    }

    const previewPath = await this.#images.getOrCreate(assetId, 'preview');
    if (!previewPath) throw new Error('ASSET_PREVIEW_NOT_FOUND');
    const image = await readFile(previewPath).catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error ? error.code : null;
      if (code === 'ENOENT') throw new Error('ASSET_PREVIEW_NOT_FOUND');
      if (code === 'EACCES' || code === 'EPERM') throw new Error('ANALYSIS_IMAGE_READ_DENIED');
      throw new Error('ANALYSIS_IMAGE_READ_FAILED');
    });
    if (image.byteLength > 15 * 1024 * 1024) throw new Error('ANALYSIS_IMAGE_TOO_LARGE');

    const response = await fetchBounded(`${provider.profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: createProviderRequestHeaders(provider.profile.customHeaders, provider.apiKey),
      redirect: 'error',
      body: JSON.stringify({
        model: provider.profile.modelId,
        stream: false,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}\n${language}\nThe complete required response JSON Schema is:\n${ANALYSIS_RESPONSE_SCHEMA}` },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Perform a complete editing and catalog analysis of this image. Return only a JSON object matching the required JSON Schema.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } }
            ]
          }
        ]
      })
    }, {
      maxBytes: MAX_ANALYSIS_RESPONSE_BYTES,
      timeoutMs: provider.profile.requestTimeoutMs ?? ANALYSIS_TIMEOUT_MS,
      retryCount: provider.profile.retryCount,
      signal
    });
    if (!response.ok) throw new Error(analysisHttpErrorCode(response.status, response.bytes.toString('utf8')));
    const text = response.bytes.toString('utf8');
    const envelope = parseProviderJson(text);
    const content = extractContent(envelope);
    const parsedResult = parseProviderJson(stripCodeFence(content), 'ANALYSIS_CONTENT_NOT_JSON');
    const result = analysisResultSchema.safeParse(parsedResult);
    if (!result.success) throw new Error('ANALYSIS_RESPONSE_SCHEMA_INVALID');
    signal?.throwIfAborted();
    try {
      return this.#save(assetId, providerProfileId, result.data);
    } catch {
      throw new Error('ANALYSIS_RESULT_SAVE_FAILED');
    }
  }

  async analyzeCollection(assetIds: string[], providerProfileId: string, signal?: AbortSignal, locale?: 'zh-CN' | 'en-US'): Promise<CollectionAnalysisReport> {
    const language = analysisLanguageInstruction(locale ?? await this.#locale());
    const provider = await this.#providers.resolve(providerProfileId);
    if (provider.profile.purpose !== 'vision' || provider.profile.kind !== 'openai-compatible') throw new Error('PROVIDER_DOES_NOT_SUPPORT_VISION');
    const uniqueIds = [...new Set(assetIds)].slice(0, 200);
    if (uniqueIds.length < 2) throw new Error('COLLECTION_ANALYSIS_REQUIRES_MULTIPLE_ASSETS');
    const inputs = uniqueIds.map((assetId) => {
      const revision = this.list(assetId)[0];
      if (!revision) return null;
      return {
        assetId,
        summary: revision.result.summary,
        description: revision.result.catalog.shortDescription,
        scenes: revision.result.catalog.scenes,
        subjects: revision.result.catalog.subjects,
        score: revision.result.quality.overallScore,
        issues: revision.result.quality.issues.map((issue) => issue.description)
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    if (inputs.length < 2) throw new Error('COLLECTION_ANALYSIS_REQUIRES_MULTIPLE_ANALYSES');
    const response = await fetchBounded(`${provider.profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: createProviderRequestHeaders(provider.profile.customHeaders, provider.apiKey),
      redirect: 'error',
      body: JSON.stringify({
        model: provider.profile.modelId,
        stream: false,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${COLLECTION_SYSTEM_PROMPT}\n${language}` },
          { role: 'user', content: `Review this photo collection from its existing visual analyses. Return only a JSON object with the required fields:\n${JSON.stringify(inputs)}` }
        ]
      })
    }, { maxBytes: MAX_ANALYSIS_RESPONSE_BYTES, timeoutMs: provider.profile.requestTimeoutMs ?? ANALYSIS_TIMEOUT_MS, retryCount: provider.profile.retryCount, signal });
    if (!response.ok) throw new Error(analysisHttpErrorCode(response.status, response.bytes.toString('utf8')));
    const content = extractContent(parseProviderJson(response.bytes.toString('utf8')));
    const result = collectionAnalysisReportSchema.safeParse(parseProviderJson(stripCodeFence(content), 'ANALYSIS_CONTENT_NOT_JSON'));
    if (!result.success) throw new Error('ANALYSIS_RESPONSE_SCHEMA_INVALID');
    const parsed = result.data;
    const allowed = new Set(inputs.map((item) => item.assetId));
    return collectionAnalysisReportSchema.parse({
      ...parsed,
      groups: parsed.groups.map((group) => ({ ...group, assetIds: [...new Set(group.assetIds.filter((id) => allowed.has(id)))] })).filter((group) => group.assetIds.length >= 2),
      keepAssetIds: [...new Set(parsed.keepAssetIds.filter((id) => allowed.has(id)))],
      reviewAssetIds: [...new Set(parsed.reviewAssetIds.filter((id) => allowed.has(id)))]
    });
  }

  #save(assetId: string, providerProfileId: string, result: AnalysisResult): AnalysisRevision {
    const revision: AnalysisRevision = {
      id: randomUUID(), assetId, providerProfileId, result, createdAt: Date.now()
    };
    const searchContent = [
      result.summary,
      result.catalog.shortDescription,
      result.catalog.longDescription,
      ...result.catalog.scenes,
      ...result.catalog.subjects,
      ...result.catalog.objects,
      ...result.catalog.mood,
      ...result.catalog.colors,
      ...result.catalog.keywords,
      result.catalog.ocrText
    ].filter(Boolean).join('\n');
    const normalizedContent = normalizeSearchText(searchContent);
    const searchTokens = tokenizeSearchText(searchContent);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT INTO analysis_revisions (
          id, asset_id, provider_profile_id, schema_version, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        revision.id, assetId, providerProfileId, result.schemaVersion,
        JSON.stringify(result), revision.createdAt
      );
      this.#database.prepare('DELETE FROM asset_search_tokens WHERE asset_id = ?').run(assetId);
      this.#database.prepare(`
        INSERT INTO asset_search (asset_id, normalized_content) VALUES (?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET normalized_content = excluded.normalized_content
      `).run(assetId, normalizedContent);
      const insertToken = this.#database.prepare('INSERT INTO asset_search_tokens (asset_id, token) VALUES (?, ?)');
      for (const token of searchTokens) insertToken.run(assetId, token);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return analysisRevisionSchema.parse(revision);
  }

  #toRevision(row: RevisionRow): AnalysisRevision {
    return analysisRevisionSchema.parse({
      id: row.id,
      assetId: row.asset_id,
      providerProfileId: row.provider_profile_id,
      result: JSON.parse(row.result_json) as unknown,
      createdAt: row.created_at
    });
  }
}

export function analysisLanguageInstruction(locale: 'zh-CN' | 'en-US'): string {
  return `Write all human-readable descriptions, summaries, reports, reasons, recommendations, editing instructions and catalog tags in ${locale === 'zh-CN' ? 'Simplified Chinese (简体中文)' : 'English'}. Keep JSON property names, schema enum values, parameter identifiers, IDs and units unchanged. Preserve OCR text in its original language.`;
}

export function analysisHttpErrorCode(status: number, body: string): string {
  // Classify explicit API errors without persisting echoed prompts, credentials or paths.
  if (status === 400 || status === 404 || status === 422) {
    try {
      const data = JSON.parse(body);
      const error = data?.error;
      const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
      const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
      const param = typeof error?.param === 'string' ? error.param.toLowerCase() : '';
      if (['model_not_found', 'invalid_model', 'unsupported_model', 'model_not_supported'].includes(code)
        || (/\bmodel\b/u.test(message) && /not found|does not exist|unsupported model|model is not supported|invalid model|unknown model/u.test(message))) {
        return 'PROVIDER_MODEL_UNAVAILABLE';
      }
      const unsupported = /not supported|unsupported|not allowed|unrecognized|unknown parameter/u.test(message);
      if (unsupported && (param === 'response_format' || /response_format|json_object/u.test(message))) return 'PROVIDER_JSON_MODE_UNSUPPORTED';
      if (unsupported && /image_url|image input|vision|images? (?:are |is )?not supported/u.test(message)) return 'PROVIDER_IMAGE_INPUT_UNSUPPORTED';
    } catch { /* Preserve the HTTP status when no structured cause is available. */ }
  }
  return `PROVIDER_HTTP_${status}`;
}

function extractContent(envelope: unknown): string {
  if (typeof envelope !== 'object' || envelope === null || !('choices' in envelope) || !Array.isArray(envelope.choices)) {
    throw new Error('PROVIDER_RESPONSE_INVALID');
  }
  const first: unknown = envelope.choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) throw new Error('PROVIDER_RESPONSE_INVALID');
  const message = first.message;
  if (typeof message !== 'object' || message === null || !('content' in message)) throw new Error('PROVIDER_RESPONSE_INVALID');
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: string; text: string } =>
        typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
      )
      .map((part) => part.text)
      .join('');
  }
  throw new Error('PROVIDER_RESPONSE_INVALID');
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseProviderJson(text: string, errorCode = 'PROVIDER_RESPONSE_NOT_JSON'): unknown {
  const normalized = text.replace(/^\uFEFF/u, '').trim();
  if (errorCode === 'PROVIDER_RESPONSE_NOT_JSON') {
    if (!normalized) throw new Error('PROVIDER_RESPONSE_EMPTY');
    if (/^(?:<!doctype\s+html|<html\b)/iu.test(normalized)) throw new Error('PROVIDER_RESPONSE_HTML');
  }
  const streamed = parseSseEnvelope(normalized);
  if (streamed) return streamed;
  const candidates = [normalized, stripCodeFence(normalized)];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as unknown; } catch { /* try the next compatible envelope */ }
  }
  const objectStart = normalized.indexOf('{');
  const objectEnd = normalized.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    try { return JSON.parse(normalized.slice(objectStart, objectEnd + 1)) as unknown; } catch { /* keep the stable error below */ }
  }
  throw new Error(errorCode);
}

function parseSseEnvelope(value: string): unknown {
  const lines = value.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  if (lines.length === 0) return null;
  let content = '';
  for (const line of lines) {
    let event: { choices?: { index?: number; delta?: { content?: unknown }; message?: { content?: unknown } }[] };
    try { event = JSON.parse(line); } catch { throw new Error('PROVIDER_RESPONSE_NOT_JSON'); }
    if (!event || !Array.isArray(event.choices)) throw new Error('PROVIDER_RESPONSE_INVALID');
    const choice = event.choices.find((item) => (item.index ?? 0) === 0);
    const text = choice?.delta?.content ?? choice?.message?.content;
    if (typeof text === 'string') content += text;
  }
  if (!content) throw new Error('PROVIDER_RESPONSE_INVALID');
  return { choices: [{ message: { content } }] };
}
