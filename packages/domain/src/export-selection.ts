import type { GenerationResult } from '@photoallisai/contracts';

export type ExportSelectionMode = 'preferred-or-latest' | 'accepted' | 'all';

export function pickExportResult(results: readonly GenerationResult[]): GenerationResult | null {
  return results.find((result) => result.reviewState === 'preferred') ?? results[0] ?? null;
}

export function pickExportResults(
  results: readonly GenerationResult[],
  mode: ExportSelectionMode
): GenerationResult[] {
  if (mode === 'all') return [...results];
  if (mode === 'accepted') {
    return results.filter((result) => result.reviewState === 'accepted' || result.reviewState === 'preferred');
  }
  const result = pickExportResult(results);
  return result ? [result] : [];
}
