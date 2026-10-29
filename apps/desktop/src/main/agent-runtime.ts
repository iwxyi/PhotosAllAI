import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { agentActionSchema, type AgentSession, type AgentCall, type AgentAskInteraction } from '@photoallisai/contracts';
import type { AgentStore } from './agent-store';
import type { AgentModel } from './agent-model';
import type { AgentTool } from './agent-tools';

const activeStatuses = ['running', 'waiting'];
const unfinished = (c: AgentCall) => ['approval', 'executing', 'waiting', 'uncertain'].includes(c.status);
export const agentTurnLimit = (s: AgentSession) => Math.min(1000, 64 + s.assetIds.length * 8);
const renderResult = (value: unknown) => {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > 40000 ? JSON.stringify({ truncated: true, preview: text.slice(0, 39000), note: '结果已截断，请使用读取工具查询具体对象。' }) : text;
};

export class AgentRuntime {
  private readonly tools: Map<string, AgentTool>;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void>; session: AgentSession }>();
  private stopped = false;
  constructor(private readonly store: AgentStore, private readonly model: AgentModel, tools: AgentTool[],
    private readonly cancelTask: (id: string) => void = () => undefined) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    for (const session of store.recoverable()) {
      if (activeStatuses.includes(session.status)) {
        session.status = 'paused';
        for (const c of session.calls.filter((c) => c.status === 'executing')) {
          if (!this.tools.get(c.name)?.replayable) c.status = 'uncertain';
        }
        store.save(session);
      }
    }
  }
  list(): AgentSession[] { return this.store.list(); }
  get(id: string): AgentSession { return this.store.get(id); }
  delete(id: string): void {
    if (this.active.has(id)) throw new Error('AGENT_BUSY');
    const session = this.store.get(id);
    if (session.calls.some(unfinished)) throw new Error('AGENT_UNFINISHED');
    this.store.delete(session.id);
  }
  toolDefinitions(): { name: string; description: string; approval: boolean; parameters: Record<string, unknown> }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, approval: t.approval, parameters: z.toJSONSchema(t.schema) }));
  }
  createExternal(assetIds: string[], goal: string, owner: string): AgentSession {
    const session = this.create(assetIds);
    session.source = 'external'; session.externalOwner = owner; session.title = goal.slice(0, 32);
    this.message(session, 'user', goal); this.store.save(session); return session;
  }
  external(id: string, owner: string): AgentSession {
    const session = this.get(id);
    if (session.source !== 'external' || session.externalOwner !== owner) throw new Error('MCP_SESSION_NOT_FOUND');
    return session;
  }
  invokeExternal(id: string, owner: string, requestId: string, name: string, args: unknown): AgentSession {
    const session = this.external(id, owner);
    const tool = this.tools.get(name);
    if (!tool) throw new Error('TOOL_NOT_FOUND');
    const parsed = tool.schema.parse(args) as Record<string, unknown>;
    const prior = session.calls.find((c) => c.requestId === requestId);
    if (prior) {
      if (prior.name !== name || !isDeepStrictEqual(prior.arguments, parsed)) throw new Error('REQUEST_ID_CONFLICT');
      return session;
    }
    if (this.stopped || this.active.has(id) || session.calls.some(unfinished) || ['paused', 'failed', 'canceled'].includes(session.status)) throw new Error('MCP_SESSION_BUSY');
    session.calls.push({ id: randomUUID(), requestId, name, arguments: parsed, status: tool.approval ? 'approval' : 'executing', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: null });
    session.status = 'running'; session.error = null;
    this.store.save(session); this.launch(session); return this.get(id);
  }
  create(assetIds: string[]): AgentSession {
    const now = Date.now();
    const session: AgentSession = { id: randomUUID(), title: '新对话', assetIds: [...new Set(assetIds)], status: 'idle',
      messages: [], calls: [], turns: 0, outputs: 0, createdAt: now, updatedAt: now, error: null };
    this.store.save(session); return session;
  }
  send(id: string, text: string, assetIds?: string[]): AgentSession {
    const session = this.store.get(id);
    if (session.source === 'external') throw new Error('外部会话请由原客户端继续，或新建内置 Agent 对话。');
    if (this.active.has(id) || activeStatuses.includes(session.status)) throw new Error('Agent 正在执行，请先暂停。');
    if (session.status === 'canceled') throw new Error('请开启新会话。');
    if (session.calls.some((c) => c.status === 'uncertain')) throw new Error('请先核对中断的文件操作。');
    for (const c of session.calls.filter(unfinished)) {
      if (c.taskIds.length) throw new Error('请先继续或取消未完成的作业。');
      c.status = 'rejected'; c.result = '用户补充了新的要求，旧行动失效。';
      this.message(session, 'tool', c.result, undefined, c.id);
    }
    session.title = session.messages.length ? session.title : text.slice(0, 32);
    // Answers to a clarification continue the same objective and budgets.
    if (session.status !== 'awaiting_input') {
      session.requestCallStart = session.calls.length;
      session.requestMessageStart = session.messages.length;
      session.turns = 0; session.outputs = 0;
    }
    session.error = null;
    this.message(session, 'user', text, undefined, undefined, assetIds ? [...new Set(assetIds)] : undefined); session.status = 'running';
    this.store.save(session); this.launch(session); return this.get(id);
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel' | 'approve' | 'reject', callId?: string): Promise<AgentSession> {
    const running = this.active.get(id);
    if (action === 'pause' || action === 'cancel') {
      if (running) { running.controller.abort(); await running.promise; }
      const session = this.store.get(id);
      if (action === 'cancel') {
        for (const c of session.calls.filter(unfinished)) {
          for (const taskId of c.taskIds) this.cancelTask(taskId);
          c.status = 'rejected'; c.result = '用户取消，已完成的结果保留。';
        }
        session.status = 'canceled';
      } else if (!['completed', 'canceled'].includes(session.status)) session.status = 'paused';
      this.store.save(session); return session;
    }
    if (running || this.stopped) throw new Error('AGENT_BUSY');
    const session = this.store.get(id);
    const call = session.calls.find(unfinished);
    if (action === 'approve' || action === 'reject') {
      if (!call || call.id !== callId || !['approval', 'uncertain'].includes(call.status)) throw new Error('确认已失效，请重新检查当前操作。');
      if (call.status === 'uncertain') {
        call.status = 'error'; call.result = '用户已核对中断操作。结果不确定，不得宣称成功，也不得自动重复文件操作。';
        this.message(session, 'tool', call.name, call.result, call.id);
      } else if (action === 'reject') {
        call.status = 'rejected'; call.result = '用户拒绝此操作，请调整方案，不得原样重提。';
        this.message(session, 'tool', call.name, call.result, call.id);
      } else { call.approved = true; call.status = 'executing'; }
    } else if (session.status !== 'paused' && session.status !== 'failed') throw new Error('当前会话无需恢复。');
    if (call?.status === 'approval') { session.status = 'awaiting_approval'; this.store.save(session); return session; }
    if (call?.status === 'uncertain') { session.status = 'awaiting_approval'; this.store.save(session); return session; }
    if (session.turns >= agentTurnLimit(session)) { session.turns = 0; session.outputs = 0; }
    session.status = 'running'; session.error = null; this.store.save(session); this.launch(session); return this.get(id);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const pending = [...this.active.values()];
    for (const a of pending) a.controller.abort();
    await Promise.allSettled(pending.map((a) => a.promise));
  }
  close(): void { this.store.close(); }
  private message(s: AgentSession, role: 'user' | 'assistant' | 'tool', text: string, detail?: string, callId?: string, assetIds?: string[], interaction?: AgentAskInteraction): void {
    s.messages.push({ id: randomUUID(), role, text, createdAt: Date.now(), ...(detail === undefined ? {} : { detail }), ...(callId ? { callId } : {}), ...(assetIds?.length ? { assetIds } : {}), ...(interaction ? { interaction } : {}) });
  }
  private launch(session: AgentSession): void {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.run(session, controller.signal)).finally(() => this.active.delete(session.id));
    this.active.set(session.id, { controller, promise, session });
  }
  private async run(s: AgentSession, signal: AbortSignal): Promise<void> {
    let invalidResponses = 0;
    try {
      while (!signal.aborted) {
        const call = s.calls.find(unfinished);
        if (call) {
          if (call.status === 'approval' || call.status === 'uncertain') { s.status = 'awaiting_approval'; this.store.save(s); return; }
          const tool = this.tools.get(call.name);
          try {
            if (!tool) throw new Error('工具不可用');
            if (tool.approval && !call.approved) throw new Error('此操作需要确认');
            if (call.status !== 'waiting') { call.status = 'executing'; this.store.save(s); }
            const outcome = await tool.execute(call.arguments, { session: s, call, signal, save: () => this.store.save(s) });
            // Persist a completed write even if pause arrived while that write was running.
            if (outcome.waiting) {
              if (call.status !== 'waiting' || s.status !== 'waiting') {
                call.status = 'waiting'; s.status = 'waiting'; this.store.save(s);
              }
              await delay(Math.max(1, (call.wakeAt ?? Date.now() + 500) - Date.now()), signal);
              continue;
            }
            call.status = 'done'; call.result = renderResult(outcome.result);
          } catch (error) {
            if (signal.aborted) {
              if (tool && !tool.replayable) {
                call.status = 'uncertain'; call.result = '操作在中断时未返回回执，请核对实际状态，不能自动重试。';
                this.store.save(s);
              }
              throw error;
            }
            call.status = 'error'; call.result = error instanceof Error ? error.message : '工具执行失败';
          }
          this.message(s, 'tool', `${call.name}: ${call.status}`, call.result ?? undefined, call.id);
          s.status = 'running'; this.store.save(s);
          signal.throwIfAborted();
          continue;
        }
        if (s.turns >= agentTurnLimit(s)) { s.status = 'paused'; s.error = `已达到本轮 ${agentTurnLimit(s)} 步预算，检查进展后可继续。`; this.store.save(s); return; }
        if (s.source === 'external') { s.status = 'idle'; this.store.save(s); return; }
        s.turns++; s.status = 'running'; this.store.save(s);
        let action;
        try {
          action = agentActionSchema.parse(await this.model.next(structuredClone(s), this.toolDefinitions(), signal));
          invalidResponses = 0;
        } catch (error) {
          if (!signal.aborted && (error instanceof SyntaxError || error instanceof z.ZodError) && ++invalidResponses < 3) {
            const detail = error instanceof Error ? error.message : String(error);
            this.message(s, 'tool', '行动格式无效', `${detail}\n请依据上述具体错误修正下一次行动，并严格返回一个 tool、ask 或 finish 对象。`);
            this.store.save(s); continue;
          }
          throw error;
        }
        signal.throwIfAborted();
        if (action.type === 'finish') {
          const currentCalls = s.calls.slice(s.requestCallStart ?? 0);
          const uninspected = currentCalls.flatMap((c) => c.resultIds).filter((id) => !currentCalls.some((c) => c.name === 'vision.inspect' && c.status === 'done' && (c.arguments.resultIds as string[] | undefined)?.includes(id)));
          if (uninspected.length) {
            this.message(s, 'tool', '交付检查未完成', `必须先使用 vision.inspect 检查生成结果，再如实交付：${JSON.stringify(uninspected)}`);
            this.store.save(s); continue;
          }
        }
        this.message(s, 'assistant', action.text, undefined, undefined, undefined, action.type === 'ask' ? action.interaction : undefined);
        if (action.type === 'ask' || action.type === 'finish') {
          s.status = action.type === 'ask' ? 'awaiting_input' : 'completed'; this.store.save(s); return;
        }
        const tool = this.tools.get(action.name);
        const parsed = tool?.schema.safeParse(action.arguments);
        if (!tool || !parsed?.success) {
          this.message(s, 'tool', action.name, !tool ? '未注册的工具，请使用可用能力或说明限制。' : `参数错误：${parsed?.error?.message}`);
          this.store.save(s); continue;
        }
        s.calls.push({ id: randomUUID(), name: tool.name, arguments: parsed.data as Record<string, unknown>,
          status: tool.approval ? 'approval' : 'executing', approved: false, taskIds: [], resultIds: [], wakeAt: null, result: null });
        this.store.save(s);
      }
      s.status = 'paused'; this.store.save(s);
    } catch (error) {
      s.status = signal.aborted ? 'paused' : 'failed';
      s.error = signal.aborted ? null : error instanceof Error ? error.message : 'Agent 执行失败';
      this.store.save(s);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('ABORTED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
