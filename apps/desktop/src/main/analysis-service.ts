import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import {
  analysisResultSchema,
  analysisRevisionSchema,
  type AnalysisResult,
  type AnalysisRevision
} from '@photoallisai/contracts';

import type { ImageCacheService } from './image-cache-service';
import type { ProviderService } from './provider-service';

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

export class AnalysisService {
  readonly #database: DatabaseSync;
  readonly #providers: ProviderResolver;
  readonly #images: AnalysisImageSource;

  constructor(
    databasePath: string,
    providers: ProviderResolver,
    images: AnalysisImageSource
  ) {
    this.#providers = providers;
    this.#images = images;
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

  async analyze(assetId: string, providerProfileId: string, signal?: AbortSignal): Promise<AnalysisRevision> {
    const provider = await this.#providers.resolve(providerProfileId);
    if (provider.profile.purpose !== 'vision' || provider.profile.kind !== 'openai-compatible') {
      throw new Error('PROVIDER_DOES_NOT_SUPPORT_VISION');
    }

    const previewPath = await this.#images.getOrCreate(assetId, 'preview');
    if (!previewPath) throw new Error('ASSET_PREVIEW_NOT_FOUND');
    const image = await readFile(previewPath);
    if (image.byteLength > 15 * 1024 * 1024) throw new Error('ANALYSIS_IMAGE_TOO_LARGE');

    const response = await fetch(`${provider.profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      redirect: 'error',
      signal: signal ?? null,
      body: JSON.stringify({
        model: provider.profile.modelId,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Perform a complete editing and catalog analysis of this image.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } }
            ]
          }
        ]
      })
    });
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    const text = await response.text();
    if (text.length > 5_000_000) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
    const envelope: unknown = JSON.parse(text);
    const content = extractContent(envelope);
    const result = analysisResultSchema.parse(JSON.parse(stripCodeFence(content)) as unknown);
    signal?.throwIfAborted();
    return this.#save(assetId, providerProfileId, result);
  }

  #save(assetId: string, providerProfileId: string, result: AnalysisResult): AnalysisRevision {
    const revision: AnalysisRevision = {
      id: randomUUID(), assetId, providerProfileId, result, createdAt: Date.now()
    };
    this.#database.prepare(`
      INSERT INTO analysis_revisions (
        id, asset_id, provider_profile_id, schema_version, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      revision.id, assetId, providerProfileId, result.schemaVersion,
      JSON.stringify(result), revision.createdAt
    );
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
