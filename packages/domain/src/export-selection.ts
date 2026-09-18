import type { GenerationResult } from '@photoallisai/contracts';

export function pickExportResult(results: readonly GenerationResult[]): GenerationResult | null {
  return results.find((result) => result.reviewState === 'preferred') ?? results[0] ?? null;
}
