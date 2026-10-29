import { describe, expect, it } from 'vitest';
import { parseAgentAction } from './agent-model';

describe('parseAgentAction', () => {
  it('normalizes common gateway tool envelopes and omitted descriptive text', () => {
    expect(parseAgentAction('{"type":"tool","name":"analysis.read","args":{"assetIds":["a"]}}')).toEqual({
      type: 'tool', name: 'analysis.read', arguments: { assetIds: ['a'] }, text: '执行 analysis.read'
    });
    expect(parseAgentAction('{"action":"tool","tool":"catalog.read","input":{"assetIds":["a"]}}')).toEqual({
      type: 'tool', name: 'catalog.read', arguments: { assetIds: ['a'] }, text: '执行 catalog.read'
    });
  });

  it('keeps strict validation for unknown or incomplete actions', () => {
    expect(() => parseAgentAction('{"type":"tool","name":"analysis.read","arguments":[]}')).toThrow();
    expect(() => parseAgentAction('{"type":"something","text":"x"}')).toThrow();
  });
});
