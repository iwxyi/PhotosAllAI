import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgentSession, McpStatus } from '@photoallisai/contracts';
import type { AgentRuntime } from './agent-runtime';

const openSchema = z.object({ assetIds: z.array(z.string().min(1)).max(500), goal: z.string().trim().min(1).max(20000) }).strict();
const getSchema = z.object({ sessionId: z.string().uuid() }).strict();
const controlSchema = getSchema.extend({ action: z.enum(['pause', 'resume', 'cancel']) }).strict();
const invokeSchema = getSchema.extend({ requestId: z.string().uuid(), input: z.record(z.string(), z.unknown()) }).strict();

/** Each enabled connection owns its sessions; approval is available only through desktop IPC. */
export class AgentMcpServer {
  private http: HttpServer | null = null;
  private token: string | null = null;
  private owner = '';
  private url: string | null = null;
  private readonly connections = new Set<Server>();
  private lifecycle: Promise<unknown> = Promise.resolve();
  constructor(private readonly runtime: AgentRuntime,
    private readonly preview?: (session: AgentSession, kind: 'original' | 'result', id: string) => Promise<string>) {}
  status(): McpStatus { return { enabled: !!this.http, url: this.url, token: this.token, tools: this.runtime.toolDefinitions().length }; }
  setEnabled(enabled: boolean): Promise<McpStatus> {
    const operation = this.lifecycle.then(async () => {
      if (enabled) await this.start(); else await this.stop();
      return this.status();
    });
    this.lifecycle = operation.catch(() => undefined); return operation;
  }
  private async start(): Promise<void> {
    if (this.http) return;
    this.token = randomBytes(32).toString('hex'); this.owner = randomUUID();
    const http = createServer((request, response) => {
      const reject = (status: number) => { response.writeHead(status).end(); };
      if (request.url !== '/mcp') { reject(404); return; }
      if (request.headers.origin || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '')) { reject(403); return; }
      const supplied = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (!this.token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reject(401); return; }
      if (request.method !== 'POST') { reject(405); return; }
      const owner = this.owner;
      let bytes = 0;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { reject(413); request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (response.writableEnded) return;
        if (!this.token || owner !== this.owner) { reject(401); return; }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(400); return; }
        const server = this.createProtocol(owner);
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        this.connections.add(server);
        response.once('close', () => { this.connections.delete(server); void server.close(); });
        void server.connect(transport).then(() => transport.handleRequest(request, response, body)).catch(() => { if (!response.headersSent) reject(500); });
      });
    });
    http.requestTimeout = 15000; http.headersTimeout = 10000;
    try {
      await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); }); });
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('MCP_LISTEN_FAILED');
      this.http = http; this.url = `http://127.0.0.1:${address.port}/mcp`;
    } catch (error) { http.close(); this.token = null; throw error; }
  }
  private createProtocol(owner: string): Server {
    const server = new Server({ name: 'PhotoAllIsAI', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} }, instructions: '先 sessions.open 声明目标和图片范围。业务工具携带 sessionId、唯一 requestId 和 input，轮询 sessions.get 读取执行回执。重要变更必须在桌面程序确认。不要将排队或等待描述为成功。通过图片资源模板读取真实图像。' });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: this.preview ? [
      { name: 'original-preview', uriTemplate: 'photoallisai://sessions/{sessionId}/original/{id}', mimeType: 'image/jpeg', description: '会话范围内原图的 1600px 预览' },
      { name: 'result-preview', uriTemplate: 'photoallisai://sessions/{sessionId}/result/{id}', mimeType: 'image/jpeg', description: '会话范围内 AI 结果的 1600px 预览' }
    ] : [] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const match = /^photoallisai:\/\/sessions\/([0-9a-f-]{36})\/(original|result)\/([0-9a-f-]{20,40})$/iu.exec(request.params.uri);
      if (!match || !this.preview) throw new Error('RESOURCE_NOT_FOUND');
      const session = this.runtime.external(match[1]!, owner);
      const data = await this.preview(session, match[2] as 'original' | 'result', match[3]!);
      return { contents: [{ uri: request.params.uri, mimeType: 'image/jpeg', blob: data }] };
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: 'sessions.open', description: '创建外部 Agent 会话，冻结图片范围。不会启动内置规划模型。', inputSchema: z.toJSONSchema(openSchema) },
      { name: 'sessions.get', description: '读取本连接会话、真实回执及异步作业状态。', inputSchema: z.toJSONSchema(getSchema) },
      { name: 'sessions.control', description: '暂停、恢复或取消本连接会话。不能批准重要操作。', inputSchema: z.toJSONSchema(controlSchema) },
      ...this.runtime.toolDefinitions().map((t) => ({ name: t.name, description: `${t.description}${t.approval ? ' 桌面程序确认后执行。' : ''}`, inputSchema: {
        type: 'object' as const, properties: { sessionId: { type: 'string', format: 'uuid' }, requestId: { type: 'string', format: 'uuid' }, input: t.parameters }, required: ['sessionId', 'requestId', 'input'], additionalProperties: false
      } }))
    ] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const name = request.params.name;
        let result: unknown;
        if (name === 'sessions.open') { const a = openSchema.parse(request.params.arguments); result = this.runtime.createExternal(a.assetIds, a.goal, owner); }
        else if (name === 'sessions.get') { const a = getSchema.parse(request.params.arguments); result = this.runtime.external(a.sessionId, owner); }
        else if (name === 'sessions.control') {
          const a = controlSchema.parse(request.params.arguments); this.runtime.external(a.sessionId, owner);
          result = await this.runtime.control(a.sessionId, a.action);
        } else {
          const a = invokeSchema.parse(request.params.arguments);
          result = this.runtime.invokeExternal(a.sessionId, owner, a.requestId, name, a.input);
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'MCP_CALL_FAILED' }] }; }
    });
    return server;
  }
  async stop(): Promise<void> {
    const http = this.http; this.http = null; this.token = null; this.url = null;
    await Promise.allSettled([...this.connections].map((s) => s.close())); this.connections.clear();
    if (http) { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); }
  }
}
