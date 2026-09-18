import { describe, expect, it } from 'vitest';

import { pickExportResult } from './export-selection';

const result = (id: string, reviewState: 'undecided' | 'accepted' | 'rejected' | 'preferred', version: number) => ({
  id,
  assetId: 'asset-1',
  batchId: 'batch-1',
  version,
  fileName: `${id}.jpg`,
  resultUrl: `photoresult://result/${id}`,
  prompt: 'prompt',
  providerProfileId: 'provider-1',
  templateId: null,
  templateVersion: null,
  storageMode: 'managed' as const,
  reviewState,
  createdAt: version
});

describe('export result selection', () => {
  it('prefers the explicitly preferred version', () => {
    const preferred = result('preferred', 'preferred', 1);
    expect(pickExportResult([result('latest', 'undecided', 2), preferred])?.id).toBe('preferred');
  });

  it('falls back to the latest result and handles empty input', () => {
    const latest = result('latest', 'accepted', 2);
    expect(pickExportResult([latest])?.id).toBe('latest');
    expect(pickExportResult([])).toBeNull();
  });
});
