import { describe, expect, it } from 'vitest';

import { normalizeSearchText, tokenizeSearchText } from './search-index';

describe('portable catalog search index', () => {
  it('normalizes latin text and creates Chinese n-grams', () => {
    expect(normalizeSearchText('  Natural   LIGHT  ')).toBe('natural light');
    const tokens = tokenizeSearchText('自然光 portrait');
    expect(tokens).toEqual(expect.arrayContaining(['自', '自然', '自然光', '然光', 'portrait']));
  });
});
