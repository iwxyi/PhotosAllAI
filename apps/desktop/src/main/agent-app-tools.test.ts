import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { agentSessionSchema } from '@photoallisai/contracts';
import { createAgentAppTools } from './agent-app-tools';
import type { AgentToolContext } from './agent-tools';

describe('Agent result review', () => {
  it('requires current-objective visual evidence and scope before changing review state', async () => {
    const resultId = randomUUID();
    const updateReview = vi.fn((args) => args);
    const changed = vi.fn();
    const tools = createAgentAppTools({ generation: { list: (id: string) => id === 'a' ? [{ id: resultId }] : [], updateReview }, changed } as unknown as Parameters<typeof createAgentAppTools>[0]);
    const review = tools.find((tool) => tool.name === 'generation.review')!;
    const session = agentSessionSchema.parse({ id: randomUUID(), title: '修图', assetIds: ['a'], status: 'running', messages: [], calls: [], turns: 0, outputs: 0, createdAt: 0, updatedAt: 0, error: null });
    const ctx = { session } as AgentToolContext;
    const args = { resultId, reviewState: 'accepted' };
    await expect(review.execute(args, ctx)).rejects.toThrow('先实际检查');
    expect(updateReview).not.toHaveBeenCalled();
    session.calls.push({ id: randomUUID(), name: 'vision.inspect', arguments: { assetIds: ['a'], resultIds: [resultId] }, status: 'done', taskIds: [], resultIds: [], approved: false, wakeAt: null, result: '{}' });
    await expect(review.execute(args, ctx)).resolves.toEqual({ result: args });
    expect(updateReview).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    session.requestCallStart = 1;
    await expect(review.execute(args, ctx)).rejects.toThrow('先实际检查');
    session.assetIds = ['b'];
    await expect(review.execute(args, ctx)).rejects.toThrow('授权范围');
    expect(updateReview).toHaveBeenCalledTimes(1);
  });
});
