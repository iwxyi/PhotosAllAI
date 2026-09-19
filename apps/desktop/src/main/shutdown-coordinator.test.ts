import { describe, expect, it } from 'vitest';

import { settleBeforeShutdown } from './shutdown-coordinator';

describe('shutdown coordinator', () => {
  it('waits for all background operations to settle', async () => {
    const result = await settleBeforeShutdown([
      Promise.resolve(),
      Promise.reject(new Error('background cleanup failed'))
    ], 100);

    expect(result).toBe('settled');
  });

  it('returns after the shutdown deadline when an operation does not settle', async () => {
    const result = await settleBeforeShutdown([new Promise(() => undefined)], 5);

    expect(result).toBe('timed-out');
  });
});
