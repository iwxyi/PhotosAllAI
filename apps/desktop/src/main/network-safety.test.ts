import { createServer, type RequestListener, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadPinned, fetchBounded } from './network-safety';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

async function serve(handler: RequestListener): Promise<{ origin: string; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

describe('bounded provider responses', () => {
  it('classifies connection failures without exposing raw network details', async () => {
    const { origin } = await serve((request) => request.socket.destroy());
    await expect(fetchBounded(origin, {}, { maxBytes: 100, timeoutMs: 1_000 }))
      .rejects.toThrow('PROVIDER_CONNECTION_FAILED');
  });

  it('stops a chunked response as soon as it exceeds the byte limit', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('123456');
      response.end('789012');
    });

    await expect(fetchBounded(origin, {}, { maxBytes: 10, timeoutMs: 1_000 }))
      .rejects.toThrow('PROVIDER_RESPONSE_TOO_LARGE');
  });

  it('aborts a provider request after its independent timeout', async () => {
    const { origin } = await serve(() => undefined);

    await expect(fetchBounded(origin, {}, { maxBytes: 10, timeoutMs: 20 }))
      .rejects.toThrow('PROVIDER_REQUEST_TIMEOUT');
  });

  it('retries transient provider responses and respects Retry-After', async () => {
    let requests = 0;
    const { origin } = await serve((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(429, { 'retry-after': '0' });
        response.end();
        return;
      }
      response.end('recovered');
    });

    const result = await fetchBounded(origin, {}, {
      maxBytes: 100,
      timeoutMs: 1_000,
      retryCount: 2,
      retryBaseDelayMs: 1
    });

    expect(result.bytes.toString('utf8')).toBe('recovered');
    expect(requests).toBe(2);
  });

  it('does not retry permanent provider errors', async () => {
    let requests = 0;
    const { origin } = await serve((_request, response) => {
      requests += 1;
      response.writeHead(400);
      response.end('{"error":{"code":"model_not_found"}}');
    });

    const result = await fetchBounded(origin, {}, {
      maxBytes: 100,
      timeoutMs: 1_000,
      retryCount: 5,
      retryBaseDelayMs: 1
    });

    expect(result.status).toBe(400);
    expect(result.bytes.toString()).toBe('{"error":{"code":"model_not_found"}}');
    expect(requests).toBe(1);
  });

  it('retains the last gateway error after retries are exhausted', async () => {
    let requests = 0;
    const { origin } = await serve((_request, response) => {
      requests += 1;
      response.writeHead(504);
      response.end(`gateway attempt ${requests}`);
    });
    const result = await fetchBounded(origin, {}, {
      maxBytes: 100, timeoutMs: 1_000, retryCount: 1, retryBaseDelayMs: 1
    });
    expect(result.status).toBe(504);
    expect(result.bytes.toString()).toBe('gateway attempt 2');
    expect(requests).toBe(2);
  });

  it.each([true, false])('preserves HTTP status for oversized error bodies (declared: %s)', async (declared) => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(502, declared ? { 'content-length': '70000' } : {});
      response.write('x'.repeat(70000));
      response.end();
    });
    const result = await fetchBounded(origin, {}, { maxBytes: 100_000, timeoutMs: 1_000 });
    expect(result.status).toBe(502);
    expect(result.bytes.length).toBe(0);
  });

  it('cancels immediately while waiting to retry', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const controller = new AbortController();
    const pending = fetchBounded(origin, {}, {
      maxBytes: 100,
      timeoutMs: 1_000,
      retryCount: 2,
      retryBaseDelayMs: 10_000,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error('USER_CANCELED')), 20);

    await expect(pending).rejects.toThrow('USER_CANCELED');
  });
});

describe('pinned generated image downloads', () => {
  it('connects to the single validated DNS result without resolving again', async () => {
    const { port } = await serve((_request, response) => response.end('image-bytes'));
    const resolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);

    const result = await downloadPinned(
      new URL(`http://result.example.test:${port}/image.png`),
      { maxBytes: 1024, timeoutMs: 1_000 },
      () => false,
      resolver
    );

    expect(result.bytes.toString('utf8')).toBe('image-bytes');
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('rejects a forbidden DNS result before opening a connection', async () => {
    const resolver = vi.fn(async () => [{ address: '192.168.1.5', family: 4 as const }]);

    await expect(downloadPinned(
      new URL('https://result.example.test/image.png'),
      { maxBytes: 1024, timeoutMs: 1_000 },
      (address) => address.startsWith('192.168.'),
      resolver
    )).rejects.toThrow('GENERATED_IMAGE_URL_PRIVATE');
  });

  it('bounds DNS resolution with the same download timeout', async () => {
    const resolver = vi.fn(async () => await new Promise<never>(() => undefined));

    await expect(downloadPinned(
      new URL('https://result.example.test/image.png'),
      { maxBytes: 1024, timeoutMs: 20 },
      () => false,
      resolver
    )).rejects.toThrow('GENERATED_IMAGE_DOWNLOAD_TIMEOUT');
  });
});
