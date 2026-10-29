import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentSessionSchema } from '@photoallisai/contracts';
import { AgentMcpServer } from './agent-mcp';
import { AgentRuntime } from './agent-runtime';
import { AgentStore } from './agent-store';
import type { AgentTool } from './agent-tools';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'photo-mcp-'));
  const write = vi.fn(); const model = vi.fn();
  const tools: AgentTool[] = [
    { name: 'metadata.update', description: '修改评分', schema: z.object({ assetId: z.string(), rating: z.number().min(0).max(5) }).strict(), approval: false, replayable: true,
      execute: async (a, c) => { const input = a as { assetId: string }; if (!c.session.assetIds.includes(input.assetId)) throw new Error('OUT_OF_SCOPE'); write(a); return { result: a }; } },
    { name: 'files.move', description: '移动文件', schema: z.object({ assetId: z.string() }).strict(), approval: true, replayable: false,
      execute: async (a) => { write(a); return { result: { moved: true } }; } },
    { name: 'runtime.wait', description: '等待', schema: z.object({}).strict(), approval: false, replayable: true,
      execute: async (_a, c) => { if (!c.call.wakeAt) { c.call.wakeAt = Date.now() + 600; c.save(); } return c.call.wakeAt > Date.now() ? { waiting: true } : { result: { finished: true } }; } }
  ];
  const runtime = new AgentRuntime(new AgentStore(join(root, 'catalog.sqlite')), { next: model }, tools);
  const preview = vi.fn(async (session, _kind: string, id: string) => { if (!session.assetIds.includes(id)) throw new Error('OUT_OF_SCOPE'); return Buffer.from('test image').toString('base64'); });
  const server = new AgentMcpServer(runtime, preview);
  const status = await server.setEnabled(true);
  cleanup.push(async () => { await server.setEnabled(false); await runtime.stop(); runtime.close(); await rm(root, { recursive: true, force: true }); });
  const connect = async () => {
    const client = new Client({ name: 'test-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(status.url!), { requestInit: { headers: { Authorization: `Bearer ${status.token}` } } }));
    cleanup.push(() => client.close()); return client;
  };
  const client = await connect();
  const assetId = 'a'.repeat(32);
  const open = await client.callTool({ name: 'sessions.open', arguments: { assetIds: [assetId], goal: '整理照片' } });
  const session = parseSession(open);
  const get = async () => parseSession(await client.callTool({ name: 'sessions.get', arguments: { sessionId: session.id } }));
  return { server, runtime, client, status, connect, write, model, preview, assetId, session, get };
}
function parseSession(result: unknown) {
  const content = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(result).content;
  return agentSessionSchema.parse(JSON.parse(content[0]!.text));
}

describe('application MCP', () => {
  it('keeps a paused external session paused until explicitly resumed', async () => {
    const f = await fixture();
    await f.client.callTool({ name: 'sessions.control', arguments: { sessionId: f.session.id, action: 'pause' } });
    expect((await f.get()).status).toBe('paused');
    expect((await f.client.callTool({ name: 'metadata.update', arguments: { sessionId: f.session.id, requestId: randomUUID(), input: { assetId: f.assetId, rating: 5 } } })).isError).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
    await f.client.callTool({ name: 'sessions.control', arguments: { sessionId: f.session.id, action: 'resume' } });
    await vi.waitFor(async () => expect((await f.get()).status).toBe('idle'));
    await f.client.callTool({ name: 'metadata.update', arguments: { sessionId: f.session.id, requestId: randomUUID(), input: { assetId: f.assetId, rating: 5 } } });
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1));
  });
  it('initializes with an official client, discovers schemas and validates scope without invoking the planner', async () => {
    const f = await fixture();
    const listed = await f.client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain('metadata.update');
    expect(listed.tools.find((t) => t.name === 'metadata.update')!.inputSchema.properties).toHaveProperty('requestId');
    const call = (input: unknown) => f.client.callTool({ name: 'metadata.update', arguments: { sessionId: f.session.id, requestId: randomUUID(), input } });
    expect((await call({ assetId: f.assetId, rating: 8 })).isError).toBe(true);
    await call({ assetId: 'another', rating: 5 });
    await vi.waitFor(async () => expect((await f.get()).calls[0]!.status).toBe('error'));
    expect(f.write).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled();
    const internal = f.runtime.create([f.assetId]);
    expect((await f.client.callTool({ name: 'sessions.get', arguments: { sessionId: internal.id } })).isError).toBe(true);
  });
  it('deduplicates requests across reconnects, refuses changed arguments and preserves receipts', async () => {
    const f = await fixture();
    const args = { sessionId: f.session.id, requestId: randomUUID(), input: { assetId: f.assetId, rating: 5 } };
    await f.client.callTool({ name: 'metadata.update', arguments: args });
    await vi.waitFor(async () => expect((await f.get()).status).toBe('idle'));
    const client = await f.connect();
    await client.callTool({ name: 'metadata.update', arguments: args });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: 'metadata.update', arguments: { ...args, input: { assetId: f.assetId, rating: 4 } } })).isError).toBe(true);
    expect((await f.get()).calls).toHaveLength(1);
    expect((await f.get()).calls[0]!.result).toContain('5');
  });
  it('requires desktop approval and returns actual async status without blocking the MCP client', async () => {
    const f = await fixture();
    await f.client.callTool({ name: 'files.move', arguments: { sessionId: f.session.id, requestId: randomUUID(), input: { assetId: f.assetId } } });
    await vi.waitFor(async () => expect((await f.get()).status).toBe('awaiting_approval'));
    expect(f.write).not.toHaveBeenCalled();
    expect((await f.client.callTool({ name: 'sessions.control', arguments: { sessionId: f.session.id, action: 'approve' } })).isError).toBe(true);
    const call = (await f.get()).calls[0]!;
    await f.runtime.control(f.session.id, 'approve', call.id);
    await vi.waitFor(async () => expect((await f.get()).status).toBe('idle'));
    expect(f.write).toHaveBeenCalledTimes(1); expect(f.model).not.toHaveBeenCalled();
    await f.client.callTool({ name: 'runtime.wait', arguments: { sessionId: f.session.id, requestId: randomUUID(), input: {} } });
    await vi.waitFor(async () => expect((await f.get()).status).toBe('waiting'));
    await vi.waitFor(async () => expect((await f.get()).status).toBe('idle'), { timeout: 3000 });
    expect((await f.get()).calls[1]!.status).toBe('done');
  });
  it('checks authentication and origin, restricts image resources, rotates credentials and revokes old sessions', async () => {
    const f = await fixture();
    expect((await fetch(f.status.url!, { method: 'POST' })).status).toBe(401);
    expect((await fetch(f.status.url!, { method: 'POST', headers: { Authorization: `Bearer ${f.status.token}`, Origin: 'https://example.com' } })).status).toBe(403);
    expect((await f.client.listResourceTemplates()).resourceTemplates).toHaveLength(2);
    const uri = `photoallisai://sessions/${f.session.id}/original/${f.assetId}`;
    expect((await f.client.readResource({ uri })).contents[0]).toHaveProperty('mimeType', 'image/jpeg');
    await expect(f.client.readResource({ uri: `photoallisai://sessions/${f.session.id}/original/${'b'.repeat(32)}` })).rejects.toThrow();
    await f.server.setEnabled(false);
    expect(f.server.status().token).toBeNull();
    const next = await f.server.setEnabled(true);
    expect(next.token).not.toBe(f.status.token);
    expect((await fetch(next.url!, { method: 'POST', headers: { Authorization: `Bearer ${f.status.token}` } })).status).toBe(401);
    const client = new Client({ name: 'new-owner', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(next.url!), { requestInit: { headers: { Authorization: `Bearer ${next.token}` } } }));
    cleanup.push(() => client.close());
    expect((await client.callTool({ name: 'sessions.get', arguments: { sessionId: f.session.id } })).isError).toBe(true);
  });
});
