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
