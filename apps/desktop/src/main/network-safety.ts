import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export type BoundedFetchResult = {
  ok: boolean;
  status: number;
  headers: Headers;
  bytes: Buffer;
};

type RequestLimits = {
  maxBytes: number;
  timeoutMs: number;
  retryCount?: number;
  retryBaseDelayMs?: number;
  signal?: AbortSignal | undefined;
};

type Address = { address: string; family: 4 | 6 };
type AddressResolver = (hostname: string) => Promise<Address[]>;

export async function fetchBounded(
  input: string | URL,
  init: RequestInit,
  limits: RequestLimits
): Promise<BoundedFetchResult> {
  const retryCount = Math.max(0, Math.min(5, limits.retryCount ?? 0));
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    limits.signal?.throwIfAborted();
    const request = timedSignal(limits.signal, limits.timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: request.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (attempt < retryCount && isRetryableStatus(response.status)) {
          await waitForRetry(retryDelayMs(response.headers, attempt, limits.retryBaseDelayMs ?? 1_000), limits.signal);
          continue;
        }
        return { ok: false, status: response.status, headers: response.headers, bytes: Buffer.alloc(0) };
      }
      return {
        ok: true,
        status: response.status,
        headers: response.headers,
        bytes: await readBoundedBody(response, limits.maxBytes)
      };
    } finally {
      request.dispose();
    }
  }
  throw new Error('PROVIDER_RETRY_EXHAUSTED');
}

const RETRYABLE_PROVIDER_STATUSES = new Set([408, 429, 502, 503, 504]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_PROVIDER_STATUSES.has(status);
}

function retryDelayMs(headers: Headers, attempt: number, baseDelayMs: number): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return Math.min(30_000, Math.max(0, baseDelayMs) * (2 ** attempt));
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason ?? new Error('ABORT_ERR'));
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function downloadPinned(
  url: URL,
  limits: RequestLimits,
  isForbiddenAddress: (address: string) => boolean,
  resolveAddresses: AddressResolver = async (hostname) => await lookup(hostname, { all: true }) as Address[]
): Promise<{ status: number; bytes: Buffer }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());
  let address: Address | undefined;
  if (!local) {
    const addresses = await resolveWithLimits(resolveAddresses(hostname), limits);
    if (addresses.length === 0 || addresses.some((candidate) => isForbiddenAddress(candidate.address))) {
      throw new Error('GENERATED_IMAGE_URL_PRIVATE');
    }
    address = addresses[0] as Address;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    const chunks: Buffer[] = [];
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      signal: limits.signal,
      ...(address ? {
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        }
      } : {})
    }, (response) => {
      const status = response.statusCode ?? 0;
      const declaredLength = Number(response.headers['content-length'] ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxBytes) {
        response.destroy();
        finish(new Error('GENERATED_IMAGE_TOO_LARGE'));
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        finish(new Error(`GENERATED_IMAGE_HTTP_${status}`));
        return;
      }
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.byteLength;
        if (received > limits.maxBytes) {
          response.destroy();
          finish(new Error('GENERATED_IMAGE_TOO_LARGE'));
          return;
        }
        chunks.push(bytes);
      });
      response.once('end', () => finish(undefined, { status, bytes: Buffer.concat(chunks, received) }));
      response.once('error', finish);
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error('GENERATED_IMAGE_DOWNLOAD_TIMEOUT'));
    }, limits.timeoutMs);
    request.once('error', finish);

    function finish(error?: Error, result?: { status: number; bytes: Buffer }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (result) resolve(result);
    }
  });
}

async function resolveWithLimits(resolution: Promise<Address[]>, limits: RequestLimits): Promise<Address[]> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, addresses?: Address[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      limits.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(addresses ?? []);
    };
    const abort = () => finish(limits.signal?.reason ?? new Error('ABORT_ERR'));
    const timeout = setTimeout(() => finish(new Error('GENERATED_IMAGE_DOWNLOAD_TIMEOUT')), limits.timeoutMs);
    if (limits.signal?.aborted) abort();
    else limits.signal?.addEventListener('abort', abort, { once: true });
    resolution.then((addresses) => finish(undefined, addresses), finish);
  });
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks, received);
  } finally {
    reader.releaseLock();
  }
}

function timedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('PROVIDER_REQUEST_TIMEOUT')), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    }
  };
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 6) {
    if (normalized.startsWith('::ffff:')) return isPrivateNetworkAddress(normalized.slice('::ffff:'.length));
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff');
  }
  if (isIP(normalized) !== 4) return false;
  const parts = normalized.split('.').map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 0 && parts[2] === 0) || (first === 192 && second === 168) || (first === 198 && (second === 18 || second === 19)) || first >= 224;
}
