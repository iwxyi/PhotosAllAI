import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentAction, AgentSession } from '@photoallisai/contracts';
import { AgentStore } from './agent-store';
import { AgentRuntime, agentTurnLimit } from './agent-runtime';
import { createAgentTools, type AgentTool } from './agent-tools';
import { TaskService } from './task-service';

const fixtures: { runtime: AgentRuntime; root: string; tasks?: TaskService }[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.runtime.stop(); f.runtime.close(); f.tasks?.close(); await rm(f.root, { recursive: true, force: true }); } });
const action = (name: string, args: Record<string, unknown>): AgentAction => ({ type: 'tool', name, arguments: args, text: `执行 ${name}` });
const finish: AgentAction = { type: 'finish', text: '已完成，以下是实际结果。' };

async function fixture(actions: AgentAction[], tools?: AgentTool[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-'));
  const db = path.join(root, 'catalog.sqlite');
  const updateMetadata = vi.fn((a: unknown) => a);
  const remove = vi.fn(async () => ({ removed: 1 }));
  const tasks = new TaskService(db);
  const defaults = createAgentTools({
    catalog: { listAssetPage: vi.fn((a: { assetIds: string[] }) => ({ items: a.assetIds.map((id) => ({ id })) })), updateMetadata, updateTags: vi.fn(), listFolders: vi.fn(() => []) } as never,
    providers: { list: async () => [{ id: providerId, purpose: 'generation', enabled: true }] } as never,
    analysis: { list: () => [] }, generation: { list: () => [] }, files: { removeFromCatalog: remove, move: vi.fn() } as never,
    tasks, wake: vi.fn(), changed: vi.fn(), inspect: vi.fn(async () => ({ summary: '真实检查', images: [] }))
  });
  const next = vi.fn(async () => actions.shift() ?? finish);
  const cancel = vi.fn((id: string) => tasks.cancel(id));
  const runtime = new AgentRuntime(new AgentStore(db), { next }, tools ?? defaults, cancel);
  const item = { root, runtime, tasks }; fixtures.push(item);
  const session = runtime.create(['a', 'b']);
  const wait = async (status: AgentSession['status']) => { await vi.waitFor(() => expect(runtime.get(session.id).status).toBe(status), { timeout: 5000, interval: 10 }); return runtime.get(session.id); };
  return { runtime, session, next, updateMetadata, remove, tasks, wait, db, cancel, item, defaults };
}
const providerId = '00000000-0000-4000-8000-000000000001';

describe('AgentRuntime', () => {
  it('does not reuse diagnosis and plans from a completed objective', async () => {
    const f = await fixture([action('vision.inspect', { assetIds: ['a'], goal: '明亮通透' }), action('runtime.plan', { goal: '明亮通透', steps: ['保留肤质'], acceptance: ['自然'] }), finish]);
    f.runtime.send(f.session.id, '明亮通透'); await f.wait('completed');
    f.next.mockImplementationOnce(async () => action('jobs.submit', { kind: 'generation', assetIds: ['a'], providerProfileId: providerId, prompt: '暗调电影感' }));
    f.runtime.send(f.session.id, '改成暗调电影感');
    const s = await f.wait('completed');
    expect(s.calls.at(-1)?.status).toBe('error');
    expect(s.calls.at(-1)?.result).toContain('当前要求');
    expect(f.tasks.list()).toHaveLength(0);
  });
  it('retains diagnosis and budgets when answering a clarification', async () => {
    const f = await fixture([action('runtime.plan', { goal: '修图', steps: ['保留文字'], acceptance: ['文字正确'] }), { type: 'ask', text: '哪一行文字需要保留？' }, finish]);
    f.runtime.send(f.session.id, '修图'); const before = await f.wait('awaiting_input');
    f.runtime.send(f.session.id, '保留店名'); const after = await f.wait('completed');
    expect(after.requestCallStart).toBe(before.requestCallStart);
    expect(after.turns).toBe(before.turns + 1);
  });
  it('sleeps durably without polling or repeatedly saving a timer', async () => {
    const execute = vi.fn(async (_args, ctx) => {
      ctx.call.wakeAt ??= Date.now() + 60000;
      return { waiting: true };
    });
    const f = await fixture([action('timer', {})], [{ name: 'timer', description: 'timer', schema: z.object({}), approval: false, replayable: true, execute }]);
    f.runtime.send(f.session.id, '等一会'); const s = await f.wait('waiting');
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.runtime.get(s.id).updatedAt).toBe(s.updatedAt);
    await f.runtime.control(s.id, 'pause');
    expect(f.runtime.get(s.id).status).toBe('paused');
  });
  it('does not replay an interrupted write during in-process resume', async () => {
    const execute = vi.fn(async (_args, ctx) => {
      await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }));
      return { result: 'unreachable' };
    });
    const f = await fixture([action('write', {}), finish], [{ name: 'write', description: 'write', schema: z.object({}), approval: false, replayable: false, execute }]);
    f.runtime.send(f.session.id, '操作'); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await f.runtime.control(f.session.id, 'pause'); await f.runtime.control(f.session.id, 'resume');
    const s = await f.wait('awaiting_approval');
    expect(s.calls[0]?.status).toBe('uncertain');
    await f.runtime.control(s.id, 'approve', s.calls[0]!.id); await f.wait('completed');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('uses observations and real parameters rather than keyword rules', async () => {
    const f = await fixture([action('metadata.update', { assetIds: ['a'], rating: 5 }), finish]);
    f.runtime.send(f.session.id, '五星');
    const s = await f.wait('completed');
    expect(f.updateMetadata).toHaveBeenCalledWith({ assetIds: ['a'], rating: 5 });
    expect(s.calls[0]?.status).toBe('done');
    expect(f.next.mock.calls).toHaveLength(2);
    expect(s.messages.some((m) => m.role === 'tool' && m.detail?.includes('5'))).toBe(true);
    expect(f.tasks.list()).toHaveLength(0);
  });
  it('retries malformed model actions within a bounded protocol budget', async () => {
    const f = await fixture([finish]);
    f.next.mockImplementationOnce(async () => { throw new SyntaxError('invalid JSON'); });
    f.runtime.send(f.session.id, '检查');
    const s = await f.wait('completed');
    expect(f.next).toHaveBeenCalledTimes(2);
    const invalid = s.messages.find((m) => m.text === '行动格式无效');
    expect(invalid?.detail).toContain('invalid JSON');
  });
  it('rejects out of scope writes, unknown tools and invalid parameters without side effects', async () => {
    const f = await fixture([action('metadata.update', { assetIds: ['other'], rating: 5 }), action('shell.run', {}), action('metadata.update', { assetIds: ['a'], rating: 99 }), finish]);
    f.runtime.send(f.session.id, '处理选中图片');
    const s = await f.wait('completed');
    expect(f.updateMetadata).not.toHaveBeenCalled();
    expect(s.calls[0]?.status).toBe('error');
    expect(s.messages.filter((m) => m.role === 'tool')).toHaveLength(3);
  });
  it('asks for missing information and preserves conversation across answers', async () => {
    const f = await fixture([{ type: 'ask', text: '请提供必须保留的文字。' }, action('metadata.update', { assetIds: ['a'], favorite: true }), finish]);
    f.runtime.send(f.session.id, '保留特定文字'); await f.wait('awaiting_input');
    f.runtime.send(f.session.id, '保留招牌');
    const s = await f.wait('completed');
    expect(s.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['保留特定文字', '保留招牌']);
  });
  it('persists structured choices and inputs on clarification messages', async () => {
    const f = await fixture([{ type: 'ask', text: '请选择处理范围。', interaction: {
      choices: [{ id: 'folder', label: '当前文件夹', description: '只处理当前目录' }, { id: 'all', label: '全部关联目录' }],
      inputs: [{ id: 'pattern', label: '文件规则', required: true }]
    } }, finish]);
    f.runtime.send(f.session.id, '批量处理文件');
    const s = await f.wait('awaiting_input');
    const message = s.messages.find((item) => item.role === 'assistant' && item.interaction);
    expect(message?.interaction?.choices.map((item) => item.id)).toEqual(['folder', 'all']);
    expect(message?.interaction?.inputs[0]?.label).toBe('文件规则');
  });
  it('binds approval to the exact saved call, rejects stale approval and invalidates it after a new instruction', async () => {
    const f = await fixture([action('files.remove', { assetIds: ['a'] }), finish]);
    f.runtime.send(f.session.id, '移出');
    const s = await f.wait('awaiting_approval');
    expect(f.remove).not.toHaveBeenCalled();
    await expect(f.runtime.control(s.id, 'approve', randomUUID())).rejects.toThrow('失效');
    f.runtime.send(s.id, '先不要移出');
    await f.wait('completed');
    await expect(f.runtime.control(s.id, 'approve', s.calls[0]!.id)).rejects.toThrow('失效');
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('executes approved file operations once and supports rejection', async () => {
    const f = await fixture([action('files.remove', { assetIds: ['a'] }), action('files.remove', { assetIds: ['b'] }), finish]);
    f.runtime.send(f.session.id, '移出');
    let s = await f.wait('awaiting_approval');
    await f.runtime.control(s.id, 'approve', s.calls[0]!.id);
    await vi.waitFor(() => expect(f.runtime.get(s.id).calls).toHaveLength(2));
    s = await f.wait('awaiting_approval');
    await f.runtime.control(s.id, 'reject', s.calls[1]!.id);
    await f.wait('completed');
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
  it('pauses an in-flight model request and resumes without accepting its stale response', async () => {
    const f = await fixture([finish]);
    let release!: () => void;
    f.next.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return action('metadata.update', { assetIds: ['a'], rating: 1 }); });
    f.runtime.send(f.session.id, '处理');
    await vi.waitFor(() => expect(f.next).toHaveBeenCalled());
    const pausing = f.runtime.control(f.session.id, 'pause');
    release(); await pausing;
    expect(f.updateMetadata).not.toHaveBeenCalled();
    await f.runtime.control(f.session.id, 'resume'); await f.wait('completed');
  });
  it('persists waits and resumes after reopening without repeating completed writes', async () => {
    const f = await fixture([action('metadata.update', { assetIds: ['a'], rating: 4 }), action('runtime.wait', { seconds: 1 }), finish]);
    f.runtime.send(f.session.id, '先评分，等一秒再结束'); await f.wait('waiting');
    await f.runtime.stop(); f.runtime.close();
    const second = new AgentRuntime(new AgentStore(f.db), { next: f.next }, f.defaults);
    f.item.runtime = second;
    expect(second.get(f.session.id).status).toBe('paused');
    await second.control(f.session.id, 'resume');
    await vi.waitFor(() => expect(second.get(f.session.id).status).toBe('completed'), { timeout: 4000 });
    expect(f.updateMetadata).toHaveBeenCalledTimes(1);
  });
  it('enforces generation diagnosis and plans, reserves task IDs and never resubmits on recovery', async () => {
    const f = await fixture([action('jobs.submit', { kind: 'generation', providerProfileId: providerId, assetIds: ['a'], prompt: '改善局部光影', count: 2 }), finish]);
    f.runtime.send(f.session.id, '修好');
    let s = await f.wait('completed');
    expect(s.calls[0]!.status).toBe('error'); expect(f.tasks.list()).toHaveLength(0);
    // Seed already persisted professional observations to isolate job recovery behavior.
    const store = new AgentStore(f.db);
    s.calls.push({ id: randomUUID(), name: 'vision.inspect', arguments: { assetIds: ['a'], resultIds: [] }, status: 'done', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: '{}' },
      { id: randomUUID(), name: 'runtime.plan', arguments: {}, status: 'done', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: '{}' });
    s.status = 'awaiting_input'; store.save(s); store.close();
    f.next.mockImplementationOnce(async () => action('jobs.submit', { kind: 'generation', providerProfileId: providerId, assetIds: ['a'], prompt: '改善局部光影', count: 2 }));
    f.runtime.send(s.id, '按方案继续'); s = await f.wait('waiting');
    expect(f.tasks.list()).toHaveLength(2);
    const ids = s.calls.at(-1)!.taskIds;
    await f.runtime.control(s.id, 'pause'); await f.runtime.control(s.id, 'resume'); await f.wait('waiting');
    expect(f.tasks.list().map((t) => t.id).sort()).toEqual([...ids].sort());
    await f.runtime.control(s.id, 'cancel');
    expect(ids.every((id) => f.tasks.find(id)?.status === 'canceled')).toBe(true);
  });
  it('does not deliver uninspected generation results', async () => {
    const f = await fixture([finish, action('vision.inspect', { assetIds: ['a'], resultIds: [], goal: '检查' }), finish]);
    const store = new AgentStore(f.db); const resultId = randomUUID();
    const s = f.runtime.get(f.session.id);
    s.calls.push({ id: randomUUID(), name: 'jobs.submit', arguments: {}, status: 'done', approved: false, taskIds: [], resultIds: [resultId], wakeAt: null, result: '{}' }); s.status = 'awaiting_input'; store.save(s); store.close();
    f.next.mockImplementation(async () => finish);
    f.runtime.send(s.id, '交付'); const done = await f.wait('paused');
    expect(done.turns).toBe(agentTurnLimit(done));
    expect(done.messages.some((m) => m.text === '交付检查未完成')).toBe(true);
  });
  it('requires manual verification after an interrupted non-replayable operation', async () => {
    const f = await fixture([finish]);
    const store = new AgentStore(f.db); const s = f.runtime.get(f.session.id);
    s.status = 'running'; s.calls.push({ id: randomUUID(), name: 'files.remove', arguments: { assetIds: ['a'] }, status: 'executing', approved: true, taskIds: [], resultIds: [], wakeAt: null, result: null });
    store.save(s); store.close(); await f.runtime.stop(); f.runtime.close();
    const second = new AgentRuntime(new AgentStore(f.db), { next: f.next }, f.defaults); f.item.runtime = second;
    await second.control(s.id, 'resume');
    expect(second.get(s.id).status).toBe('awaiting_approval');
    expect(second.get(s.id).calls[0]?.status).toBe('uncertain');
    await second.control(s.id, 'approve', s.calls[0]!.id);
    await vi.waitFor(() => expect(second.get(s.id).status).toBe('completed'));
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('supports generic tools and returns tool failure observations for replanning', async () => {
    const execute = vi.fn(async () => { throw new Error('数据不足'); });
    const f = await fixture([action('custom.tool', {}), { type: 'ask', text: '请补充必要数据。' }], [{ name: 'custom.tool', schema: z.object({}), description: '扩展工具', approval: false, replayable: true, execute }]);
    f.runtime.send(f.session.id, '特殊要求'); const s = await f.wait('awaiting_input');
    expect(s.calls[0]?.result).toBe('数据不足');
  });
  it('persists a planner network failure and resumes without replaying completed writes', async () => {
    const f = await fixture([action('metadata.update', { assetIds: ['a'], rating: 4 }), finish]);
    f.next.mockImplementationOnce(async () => action('metadata.update', { assetIds: ['a'], rating: 4 }))
      .mockImplementationOnce(async () => { throw new Error('Agent 模型请求失败（HTTP 503）'); })
      .mockImplementation(async () => finish);
    f.runtime.send(f.session.id, '评分');
    const failed = await f.wait('failed');
    expect(failed.error).toContain('503');
    expect(failed.calls[0]?.status).toBe('done');
    await f.runtime.control(f.session.id, 'resume');
    await f.wait('completed');
    expect(f.updateMetadata).toHaveBeenCalledTimes(1);
  });
  it('returns each successful and failed child job without repeating the batch', async () => {
    const f = await fixture([action('jobs.submit', { kind: 'analysis', providerProfileId: providerId, assetIds: ['a', 'b'] }), finish]);
    // The same configured fixture model now serves the vision purpose.
    const visionProvider = createAgentTools({
      catalog: { listAssetPage: ({ assetIds }: { assetIds: string[] }) => ({ items: assetIds.map((id) => ({ id })) }) } as never,
      providers: { list: async () => [{ id: providerId, enabled: true, purpose: 'vision' }] } as never,
      analysis: { list: () => [] }, generation: { list: () => [] }, files: {} as never,
      tasks: f.tasks, wake: vi.fn(), changed: vi.fn(), inspect: vi.fn()
    });
    await f.runtime.stop(); f.runtime.close();
    const runtime = new AgentRuntime(new AgentStore(f.db), { next: f.next }, visionProvider); f.item.runtime = runtime;
    runtime.send(f.session.id, '分析两张照片');
    await vi.waitFor(() => expect(runtime.get(f.session.id).status).toBe('waiting'));
    const ids = runtime.get(f.session.id).calls[0]!.taskIds;
    for (const [index, id] of ids.entries()) {
      for (const status of ['preparing', 'processing', 'downloading', 'saving'] as const) f.tasks.advance(id, status, 0);
      f.tasks.finish(id, index === 0 ? 'completed' : 'failed', index === 0 ? { summary: '实际分析结果' } : null, index === 0 ? null : 'PROVIDER_REQUEST_FAILED');
    }
    await vi.waitFor(() => expect(runtime.get(f.session.id).status).toBe('completed'));
    const result = JSON.parse(runtime.get(f.session.id).calls[0]!.result!);
    expect(result.map((item: { status: string }) => item.status)).toEqual(['completed', 'failed']);
    expect(result[1].error).toBe('PROVIDER_REQUEST_FAILED');
    expect(f.tasks.list()).toHaveLength(2);
  });
  it('enforces the cumulative generation budget before reserving or enqueueing another output', async () => {
    const f = await fixture([finish]);
    const s = f.runtime.get(f.session.id); s.outputs = 100;
    s.calls.push({ id: randomUUID(), name: 'runtime.plan', arguments: {}, status: 'done', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: '{}' },
      { id: randomUUID(), name: 'vision.inspect', arguments: { assetIds: ['a'] }, status: 'done', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: '{}' });
    const call = { id: randomUUID(), name: 'jobs.submit', arguments: {}, status: 'executing' as const, approved: false, taskIds: [], resultIds: [], wakeAt: null, result: null };
    const save = vi.fn();
    await expect(f.defaults.find((t) => t.name === 'jobs.submit')!.execute({ kind: 'generation', assetIds: ['a'], providerProfileId: providerId, prompt: '修图', count: 1 },
      { session: s, call, signal: new AbortController().signal, save })).rejects.toThrow('100');
    expect(f.tasks.list()).toHaveLength(0);
    expect(call.taskIds).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });
  it('requires inspection and scope for every composition input before enqueueing', async () => {
    const f = await fixture([finish]);
    const s = f.runtime.get(f.session.id);
    s.calls.push({ id: randomUUID(), name: 'runtime.plan', arguments: {}, status: 'done', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: '{}' },
      { id: randomUUID(), name: 'vision.inspect', arguments: { assetIds: ['a'] }, status: 'done', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: '{}' });
    const submit = f.defaults.find((tool) => tool.name === 'jobs.submit')!;
    const call = { id: randomUUID(), name: 'jobs.submit', arguments: {}, status: 'executing' as const, approved: false, taskIds: [], resultIds: [], wakeAt: null, result: null };
    const context = { session: s, call, signal: new AbortController().signal, save: vi.fn() };
    const input = { kind: 'generation', assetIds: ['a'], providerProfileId: providerId, prompt: '把第二张照片的天空合成到第一张', inputSources: [{ kind: 'asset', assetId: 'a' }, { kind: 'asset', assetId: 'b' }] };
    await expect(submit.execute(input, context)).rejects.toThrow('检查所有输入原图');
    expect(f.tasks.list()).toHaveLength(0);
    s.calls.push({ id: randomUUID(), name: 'vision.inspect', arguments: { assetIds: ['b'] }, status: 'done', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: '{}' });
    await submit.execute(input, context);
    expect(f.tasks.list()[0]?.payload.inputSources).toEqual(input.inputSources);
  });
});
