import { describe, expect, it } from 'vitest';

import { selectAll, updateSelection, type SelectionState } from './index';

const ids = ['a', 'b', 'c', 'd', 'e'];
const initial: SelectionState = {
  selectedIds: new Set(['b']),
  anchorId: 'b',
  focusId: 'b'
};

describe('catalog selection', () => {
  it('replaces selection and moves anchor and focus', () => {
    const next = updateSelection(initial, ids, 'd', 'replace');
    expect([...next.selectedIds]).toEqual(['d']);
    expect(next.anchorId).toBe('d');
    expect(next.focusId).toBe('d');
  });

  it('toggles one item without discarding the rest', () => {
    const added = updateSelection(initial, ids, 'd', 'toggle');
    expect([...added.selectedIds]).toEqual(['b', 'd']);
    const removed = updateSelection(added, ids, 'b', 'toggle');
    expect([...removed.selectedIds]).toEqual(['d']);
    expect(removed.focusId).toBe('b');
  });

  it('selects an inclusive range in either direction', () => {
    expect([...updateSelection(initial, ids, 'e', 'range').selectedIds]).toEqual(['b', 'c', 'd', 'e']);
    const reverse = updateSelection({ ...initial, anchorId: 'd' }, ids, 'a', 'range');
    expect([...reverse.selectedIds]).toEqual(['a', 'b', 'c', 'd']);
  });

  it('selects all visible ordered items', () => {
    const state = selectAll(ids);
    expect([...state.selectedIds]).toEqual(ids);
  });

  it('ignores a target outside the current result set', () => {
    expect(updateSelection(initial, ids, 'missing', 'replace')).toBe(initial);
  });
});

