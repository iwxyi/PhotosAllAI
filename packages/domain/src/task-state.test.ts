import { describe, expect, it } from 'vitest';

import { assertTaskTransition, canTransitionTask } from './index';

describe('generation task state', () => {
  it('allows the normal generation path', () => {
    expect(canTransitionTask('queued', 'preparing')).toBe(true);
    expect(canTransitionTask('processing', 'downloading')).toBe(true);
    expect(canTransitionTask('saving', 'completed')).toBe(true);
  });

  it('rejects mutation after completion', () => {
    expect(canTransitionTask('completed', 'queued')).toBe(false);
    expect(() => assertTaskTransition('completed', 'processing')).toThrow(
      'Invalid task transition'
    );
  });

  it('allows retrying failed and canceled tasks', () => {
    expect(canTransitionTask('failed', 'queued')).toBe(true);
    expect(canTransitionTask('canceled', 'queued')).toBe(true);
  });
});

