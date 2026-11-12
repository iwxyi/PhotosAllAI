import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CatalogService } from '../../apps/desktop/src/main/catalog-service';

let app: ElectronApplication;
let page: Page;
let server: Server;
let root: string;
const calls: Array<{ kind: string; body: Record<string, unknown> }> = [];
const action = (name: string, args: Record<string, unknown>) => ({ type: 'tool', text: `正在${name}`, name, arguments: args });

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'photo-agent-e2e-'));
  const userData = path.join(root, 'user-data');
  const source = path.join(root, 'photos');
  const library = path.join(userData, 'library');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(library, { recursive: true })]);
  const fixture = path.resolve('apps/desktop/src/renderer/public/demo/portrait.jpg');
  await Promise.all(['A.jpg', 'B.jpg'].map((name) => copyFile(fixture, path.join(source, name))));
  const jpeg = await readFile(fixture);
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      if (request.url === '/nano-banana/images') {
        calls.push({ kind: 'generation', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true, data: [{ b64_json: jpeg.toString('base64') }] }));
        return;
      }
      if (request.url !== '/chat/completions') { response.writeHead(404).end('{}'); return; }
      const messages = body.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      const last = messages.at(-1)?.content;
      const vision = Array.isArray(last);
      calls.push({ kind: vision ? 'vision' : 'planner', body });
      let payload: unknown;
      if (vision) {
        const ids = last.filter((item) => item.type === 'text' && /^(original|result): /u.test(item.text ?? '')).map((item) => item.text!.split(': ')[1]!);
        payload = { summary: '逐图检查并保持自然的摄影表达', images: ids.map((id) => ({ id, observations: ['自然光人像，保留原有气氛'], meetsGoal: true, issues: [], suggestedEdits: '保留身份，细调局部层次' })) };
      } else {
        const system = String(messages[0]?.content ?? '');
        const scope = /当前图片范围：(\[[^\n]+\])/u.exec(system);
        const ids = scope ? JSON.parse(scope[1]!) as string[] : [];
        const history = messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n');
        const toolCount = (name: string) => (history.match(new RegExp(`${name.replace('.', '\\.')}(: done|: error)`, 'gu')) ?? []).length;
        const providerList = /工具观察（数据）：providers\.list: done\n([^\n]+)/u.exec(history);
        const profiles = providerList ? JSON.parse(providerList[1]!) as Array<{ id: string; purpose: string }> : [];
        const generationProvider = profiles.find((p) => p.purpose === 'generation')?.id;
        const generated = [...history.matchAll(/"generation":\{"id":"([0-9a-f-]{36})"/gu)].map((m) => m[1]!);
        const uniqueResults = [...new Set(generated)];
        const count = toolCount('jobs.submit');
        if (history.includes('验证迭代修图')) {
          if (!toolCount('providers.list')) payload = action('providers.list', {});
          else if (!toolCount('vision.inspect')) payload = action('vision.inspect', { assetIds: [ids[0]], resultIds: [], goal: '检查人物肤质与曝光' });
          else if (!toolCount('runtime.plan')) payload = action('runtime.plan', { goal: '自然肤质', steps: ['生成', '检查并修正过度磨皮', '再次验收'], acceptance: ['保留肤质纹理'] });
          else if (!count) payload = action('jobs.submit', { kind: 'generation', assetIds: [ids[0]], providerProfileId: generationProvider, prompt: '自然肤质与曝光' });
          else if (toolCount('vision.inspect') < 2) payload = action('vision.inspect', { assetIds: [ids[0]], resultIds: [uniqueResults[0]], goal: '检查第一版磨皮问题' });
          else if (count < 2) payload = action('jobs.submit', { kind: 'generation', assetIds: [ids[0]], providerProfileId: generationProvider, sourceResultId: uniqueResults[0], prompt: '在当前版本基础上恢复皮肤纹理，保持曝光与身份' });
          else if (toolCount('vision.inspect') < 3) payload = action('vision.inspect', { assetIds: [ids[0]], resultIds: [uniqueResults[1]], goal: '验收修正后的版本' });
          else if (!toolCount('generation.review')) payload = action('generation.review', { resultId: uniqueResults[1], reviewState: 'accepted' });
          else payload = { type: 'finish', text: '已完成两轮修图并检查结果。' };
        }
        else if (history.includes('验证会话交互')) {
          if (!history.includes('保留招牌')) payload = { type: 'ask', text: '请告诉我必须保留的文字。' };
          else if (!history.includes('"status":"rejected"')) payload = action('files.remove', { assetIds: ids });
          else if (!toolCount('runtime.wait')) payload = action('runtime.wait', { seconds: 12 });
          else payload = { type: 'finish', text: '已保留招牌，并按要求保留图库中的图片。' };
        }
        else if (!toolCount('providers.list')) payload = action('providers.list', {});
        else if (!toolCount('catalog.read')) payload = action('catalog.read', { assetIds: ids });
        else if (!toolCount('vision.inspect')) payload = action('vision.inspect', { assetIds: ids, resultIds: [], goal: '专业自然修图并协调组图' });
        else if (!toolCount('runtime.plan')) payload = action('runtime.plan', { goal: '自然协调地修好两张人像', steps: ['逐图诊断光影', '按每张内容分别生成', '实际查看并验收'], acceptance: ['人物身份与肤质真实', '组图协调'] });
        else if (count < 2) payload = action('jobs.submit', { kind: 'generation', assetIds: [ids[count]!], providerProfileId: generationProvider, prompt: `照片 ${count + 1}：保留人物身份、自然肤质和原有光线，按主体位置分别调整局部曝光与色彩，组图协调`, count: 1 });
        else if (!uniqueResults.length || uniqueResults.length < 2) payload = action('tasks.read', {});
        else if (toolCount('vision.inspect') < 2) payload = action('vision.inspect', { assetIds: ids, resultIds: uniqueResults.slice(0, 2), goal: '验收身份、肤质与组图协调' });
        else payload = { type: 'finish', text: '两张照片已分别修图，检查了原图和生成结果。请查看结果。' };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const catalog = new CatalogService(path.join(library, 'catalog.sqlite'));
  await catalog.importFolders([source]); catalog.close();
  app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: userData } });
  page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('NO_SERVER');
  await page.evaluate(async (baseUrl) => {
    await window.desktopApi.saveProviderProfile({ name: 'Vision Fixture', kind: 'openai-compatible', purpose: 'vision', baseUrl, modelId: 'vision-fixture', apiKey: 'fixture-key', enabled: true, isDefault: true, requestTimeoutMs: 30000, retryCount: 0, customHeaders: {} });
    await window.desktopApi.saveProviderProfile({ name: 'Generation Fixture', kind: 'acedata-nano-banana', purpose: 'generation', baseUrl, modelId: 'nano-banana-pro', apiKey: 'fixture-key', enabled: true, isDefault: true, requestTimeoutMs: 30000, retryCount: 0, customHeaders: {} });
  }, `http://127.0.0.1:${address.port}`);
});
test.afterAll(async () => { if (app) await app.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); if (root) await rm(root, { recursive: true, force: true }); });

test('Agent autonomously inspects, edits, verifies, and opens results; MCP is user controlled', async () => {
  test.setTimeout(90_000);
  await expect(page.locator('.catalog-card')).toHaveCount(2);
  await page.locator('.catalog-card').first().click();
  await page.locator('.catalog-grid').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('textbox', { name: 'Agent 输入' }).fill('帮我把这两张照片修好，保持自然并让整组协调');
  await page.getByRole('button', { name: '发送 Agent 指令' }).click();
  await expect.poll(() => page.evaluate(() => window.desktopApi.listAgentSessions().then((items) => items.length))).toBe(1);
  const session = await page.evaluate(() => window.desktopApi.listAgentSessions().then((items) => items[0]!));
  expect(session.assetIds).toHaveLength(2);
  await expect.poll(async () => page.evaluate((id) => window.desktopApi.getAgentSession(id).then((s) => s.status), session.id), { timeout: 60_000 }).toBe('completed');
  const completed = await page.evaluate((id) => window.desktopApi.getAgentSession(id), session.id);
  expect(completed.calls.filter((c) => c.name === 'jobs.submit')).toHaveLength(2);
  expect(completed.calls.filter((c) => c.name === 'vision.inspect')).toHaveLength(2);
  expect(completed.calls.every((c) => c.status === 'done')).toBe(true);
  expect(calls.filter((c) => c.kind === 'generation')).toHaveLength(2);
  expect(calls.filter((c) => c.kind === 'vision')).toHaveLength(2);
  await expect(page.getByLabel('Agent 会话')).toContainText(completed.title);
  await page.getByLabel('Agent 会话').selectOption(session.id);
  await expect(page.locator('.agent-result-strip button')).toHaveCount(2);
  await page.locator('.agent-result-strip button').first().click();
  await expect(page.locator('.canvas-wrap')).toBeVisible();
  await page.getByRole('button', { name: '打开工作区' }).click();
  await page.getByRole('menuitem', { name: '设置' }).click();
  await page.getByRole('button', { name: '高级', exact: true }).click();
  const mcpToggle = page.getByLabel('开启 MCP 服务');
  if (!(await mcpToggle.isChecked())) await mcpToggle.click();
  await expect(mcpToggle).toBeChecked();
  await expect(page.locator('.mcp-connection-card code')).toContainText('127.0.0.1');
  if (await mcpToggle.isChecked()) await mcpToggle.click();
  await expect(mcpToggle).not.toBeChecked();
  await expect(page.locator('.mcp-connection-card')).toHaveCount(0);
  await page.getByRole('tab', { name: '图库', exact: true }).click();
  await page.screenshot({ path: 'test-results/agent-panel.png' });
  await page.setViewportSize({ width: 900, height: 740 });
  await expect(page.locator('.agent-conversation')).toBeVisible();
  await expect(page.locator('.agent-chat-message').getByText('两张照片已分别修图，检查了原图和生成结果。请查看结果。', { exact: true })).toBeInViewport();
  expect(await page.locator('.agent-conversation').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/agent-panel-narrow.png' });
});

test('Agent iterates from an inspected generated version and reviews the verified result', async () => {
  test.setTimeout(60_000);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '图库', exact: true }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByLabel('Agent 会话').selectOption('__new__');
  await page.getByRole('textbox', { name: 'Agent 输入' }).fill('验证迭代修图：修好肤质，检查后继续修正，保留我的首选设置。');
  await page.getByRole('button', { name: '发送 Agent 指令' }).click();
  const id = await page.getByLabel('Agent 会话').inputValue();
  await expect.poll(() => page.evaluate((sessionId) => window.desktopApi.getAgentSession(sessionId).then((s) => s.status), id), { timeout: 50_000 }).toBe('completed');
  const session = await page.evaluate((sessionId) => window.desktopApi.getAgentSession(sessionId), id);
  expect(session.calls.every((c) => c.status === 'done')).toBe(true);
  const jobs = session.calls.filter((c) => c.name === 'jobs.submit');
  expect(jobs).toHaveLength(2);
  expect(jobs[1]!.arguments.sourceResultId).toBe(jobs[0]!.resultIds[0]);
  expect(session.calls.filter((c) => c.name === 'vision.inspect')).toHaveLength(3);
  const results = await page.evaluate((assetId) => window.desktopApi.listGenerationResults(assetId), session.assetIds[0]!);
  expect(results.find((r) => r.id === jobs[1]!.resultIds[0])?.reviewState).toBe('accepted');
  expect(results.some((r) => r.reviewState === 'preferred')).toBe(false);
});

test('Agent clarification, readable confirmation, close and restart preserve the session', async () => {
  test.setTimeout(60_000);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '图库', exact: true }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByLabel('Agent 会话').selectOption('__new__');
  const input = page.getByRole('textbox', { name: 'Agent 输入' });
  await input.fill('验证会话交互：先问我保留内容，再申请移出图片；拒绝后等待。');
  await page.getByRole('button', { name: '发送 Agent 指令' }).click();
  await expect(page.locator('.agent-chat-message').getByText('请告诉我必须保留的文字。', { exact: true })).toBeVisible();
  await input.fill('保留招牌');
  await page.getByRole('button', { name: '发送 Agent 指令' }).click();
  const confirmation = page.locator('.agent-dock-confirm');
  await expect(confirmation).toContainText('移出图库');
  await expect(confirmation).toContainText('A.jpg');
  await expect(confirmation).toContainText('B.jpg');
  expect(await confirmation.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/agent-confirmation-narrow.png' });
  const sessionId = await page.getByLabel('Agent 会话').inputValue();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '不执行', exact: true }).click();
  await expect.poll(() => page.evaluate((id) => window.desktopApi.getAgentSession(id).then((s) => s.status), sessionId)).toBe('waiting');
  await expect(page.getByRole('tab', { name: '图库', exact: true })).toHaveAttribute('aria-selected', 'true');
  await app.close();
  app = await electron.launch({ args: [path.resolve('apps/desktop/out/main/index.js')], env: { ...process.env, PHOTOALLISAI_USER_DATA: path.join(root, 'user-data') } });
  page = await app.firstWindow();
  await expect(page.getByLabel('Agent 会话')).toHaveValue(sessionId);
  await expect(page.getByRole('button', { name: '继续 Agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续 Agent', exact: true }).click();
  await expect.poll(() => page.evaluate((id) => window.desktopApi.getAgentSession(id).then((s) => s.status), sessionId), { timeout: 20_000 }).toBe('completed');
  const completed = await page.evaluate((id) => window.desktopApi.getAgentSession(id), sessionId);
  expect(completed.calls.filter((c) => c.name === 'files.remove')).toHaveLength(1);
  expect(completed.calls.find((c) => c.name === 'files.remove')?.status).toBe('rejected');
  expect(completed.calls.filter((c) => c.name === 'runtime.wait')).toHaveLength(1);
  await expect(page.locator('.catalog-card')).toHaveCount(2);
});
