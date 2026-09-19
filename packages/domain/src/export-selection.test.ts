import { describe, expect, it } from 'vitest';

import { pickExportResult, pickExportResults } from './export-selection';

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

  it('selects accepted and preferred versions without undecided or rejected results', () => {
    const accepted = result('accepted', 'accepted', 4);
    const preferred = result('preferred', 'preferred', 3);
    expect(pickExportResults([
      result('undecided', 'undecided', 5), accepted, preferred, result('rejected', 'rejected', 2)
    ], 'accepted').map((item) => item.id)).toEqual(['accepted', 'preferred']);
  });

  it('selects every version when explicitly requested', () => {
    const results = [result('latest', 'undecided', 2), result('rejected', 'rejected', 1)];
    expect(pickExportResults(results, 'all')).toEqual(results);
    expect(pickExportResults([], 'all')).toEqual([]);
  });
});
