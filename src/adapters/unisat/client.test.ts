import { describe, it, expect, beforeEach } from 'vitest';
import {
  UnisatClient,
  UnisatHttpError,
  UnisatValidationError,
  UnisatNetworkError,
  UnisatClientError,
} from './client';
import {
  TokenBucketLimiter,
  RateLimitExceededError,
} from '../../core/rate-limiter';

/**
 * Mock fetch helper. Returns a fetch-shaped function that records calls and
 * returns whatever the next queued response is.
 */
function makeMockFetch(
  responses: Array<
    | { status: number; body: unknown; bodyText?: string }
    | { throws: unknown }
  >,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;

  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const next = responses[i++];
    if (next === undefined) throw new Error(`mock fetch: out of responses (call ${i})`);
    if ('throws' in next) throw next.throws;
    const text =
      next.bodyText !== undefined
        ? next.bodyText
        : next.body === null
          ? ''
          : JSON.stringify(next.body);
    return new Response(text, {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  // Type assertion: our mock signature is fetch-compatible for the subset we use.
  return Object.assign(fn as typeof fetch, { calls });
}

function makeLimiter(): TokenBucketLimiter {
  // Generous limits so the limiter never bites in HTTP-focused tests.
  return new TokenBucketLimiter({
    requests_per_second: 100,
    requests_per_day: 10_000,
  });
}

describe('UnisatClient — construction', () => {
  it('rejects empty api_key', () => {
    expect(
      () => new UnisatClient({ api_key: '', limiter: makeLimiter() }),
    ).toThrow();
  });

  it('strips trailing slash from base_url override', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: { ok: true } }]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      base_url: 'https://example.com/',
      fetch_impl: fetch_mock,
    });
    await client.request('/foo');
    expect(fetch_mock.calls[0]?.url).toBe('https://example.com/foo');
  });
});

describe('UnisatClient — request shaping', () => {
  it('sends bearer auth, browser headers, and JSON body for POST', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: { ok: true } }]);
    const client = new UnisatClient({
      api_key: 'sekret',
      limiter: makeLimiter(),
      base_url: 'https://api.test',
      fetch_impl: fetch_mock,
    });
    await client.request('/v3/market/collection/auction/list', {
      method: 'POST',
      body: { filter: { nftType: 'collection' }, limit: 10 },
    });
    const call = fetch_mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toBe('https://api.test/v3/market/collection/auction/list');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sekret');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['Origin']).toBe('https://unisat.io');
    expect(headers['Referer']).toBe('https://unisat.io/');
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
    expect(call?.init.body).toBe(
      JSON.stringify({ filter: { nftType: 'collection' }, limit: 10 }),
    );
  });

  it('omits Content-Type and body for GET', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: { ok: true } }]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      base_url: 'https://api.test',
      fetch_impl: fetch_mock,
    });
    await client.request('/health', { method: 'GET' });
    const call = fetch_mock.calls[0];
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(call?.init.body).toBeUndefined();
  });

  it('rejects endpoints that do not start with /', async () => {
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: makeMockFetch([]),
    });
    await expect(client.request('foo')).rejects.toThrow(/must start with/);
  });

  it('passes a custom user_agent through', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: {} }]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      user_agent: 'Floorboard/0.0.0 (+https://floorboard.xyz)',
      fetch_impl: fetch_mock,
    });
    await client.request('/x');
    const headers = fetch_mock.calls[0]?.init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('Floorboard/0.0.0 (+https://floorboard.xyz)');
  });
});

describe('UnisatClient — rate limiting', () => {
  it('calls limiter.acquire before fetch', async () => {
    let acquired = 0;
    const limiter = new TokenBucketLimiter({ requests_per_second: 100 });
    const original_acquire = limiter.acquire.bind(limiter);
    limiter.acquire = async () => {
      acquired += 1;
      return original_acquire();
    };
    const fetch_mock = makeMockFetch([{ status: 200, body: { ok: true } }]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter,
      fetch_impl: fetch_mock,
    });
    await client.request('/x');
    expect(acquired).toBe(1);
    expect(fetch_mock.calls.length).toBe(1);
  });

  it('propagates RateLimitExceededError from limiter without calling fetch', async () => {
    const limiter = new TokenBucketLimiter({
      requests_per_second: 100,
      requests_per_day: 1,
    });
    await limiter.acquire(); // exhaust the day cap

    const fetch_mock = makeMockFetch([]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter,
      fetch_impl: fetch_mock,
    });
    await expect(client.request('/x')).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    expect(fetch_mock.calls.length).toBe(0);
  });
});

describe('UnisatClient — error mapping', () => {
  it('returns parsed JSON body on 200', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: { code: 0, data: { items: [1, 2, 3] } } },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    const result = await client.request<{ code: number; data: unknown }>('/x');
    expect(result.code).toBe(0);
  });

  it('maps 4xx (non-validation) to UnisatHttpError', async () => {
    const fetch_mock = makeMockFetch([
      { status: 401, body: { error: 'Unauthorized' } },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatHttpError);
      const e = err as UnisatHttpError;
      expect(e.status).toBe(401);
      expect(e.endpoint).toBe('/x');
      expect(e.body).toEqual({ error: 'Unauthorized' });
    }
  });

  it('maps Fastify validation errors to UnisatValidationError with field_path', async () => {
    const fetch_mock = makeMockFetch([
      {
        status: 400,
        body: {
          statusCode: 400,
          code: 'FST_ERR_VALIDATION',
          error: 'Bad Request',
          message: 'body/filter/nftType must be string',
        },
      },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/v3/market/collection/auction/list', {
        body: { filter: { nftType: 999 } },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatValidationError);
      const e = err as UnisatValidationError;
      expect(e.field_path).toBe('body/filter/nftType');
      expect(e.endpoint).toBe('/v3/market/collection/auction/list');
    }
  });

  it('UnisatValidationError still extends UnisatClientError for blanket catches', async () => {
    const fetch_mock = makeMockFetch([
      {
        status: 400,
        body: {
          code: 'FST_ERR_VALIDATION',
          message: 'body/x must be string',
        },
      },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    await expect(client.request('/x')).rejects.toBeInstanceOf(UnisatClientError);
  });

  it('handles validation error with no parseable field path (field_path = null)', async () => {
    const fetch_mock = makeMockFetch([
      {
        status: 400,
        body: { code: 'FST_ERR_VALIDATION' }, // no message field
      },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatValidationError);
      expect((err as UnisatValidationError).field_path).toBeNull();
    }
  });

  it('non-FST_ERR_VALIDATION 400s map to UnisatHttpError, not UnisatValidationError', async () => {
    const fetch_mock = makeMockFetch([
      { status: 400, body: { error: 'whatever' } },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatHttpError);
      expect(err).not.toBeInstanceOf(UnisatValidationError);
    }
  });

  it('handles non-JSON error bodies gracefully (preserves text)', async () => {
    const fetch_mock = makeMockFetch([
      { status: 502, body: null, bodyText: '<html>Bad Gateway</html>' },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatHttpError);
      const e = err as UnisatHttpError;
      expect(e.status).toBe(502);
      expect(e.body).toBe('<html>Bad Gateway</html>');
    }
  });

  it('handles empty error bodies (body = null)', async () => {
    const fetch_mock = makeMockFetch([
      { status: 503, body: null, bodyText: '' },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatHttpError);
      expect((err as UnisatHttpError).body).toBeNull();
    }
  });

  it('maps fetch throw (network error) to UnisatNetworkError', async () => {
    const fetch_mock = makeMockFetch([
      { throws: new TypeError('fetch failed') },
    ]);
    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatNetworkError);
      const e = err as UnisatNetworkError;
      expect(e.endpoint).toBe('/x');
      expect(e.cause_name).toBe('TypeError');
    }
  });
});

describe('UnisatClient — timeout and abort', () => {
  it('aborts the request after default_timeout_ms', async () => {
    let abort_observed = false;
    const fetch_mock = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      // Hang until the signal aborts.
      return await new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            abort_observed = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
      });
    }) as typeof fetch;

    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      default_timeout_ms: 30,
      fetch_impl: fetch_mock,
    });
    try {
      await client.request('/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatNetworkError);
      expect(abort_observed).toBe(true);
    }
  });

  it('honors external AbortSignal', async () => {
    const ctrl = new AbortController();
    const fetch_mock = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;

    const client = new UnisatClient({
      api_key: 'k',
      limiter: makeLimiter(),
      default_timeout_ms: 60_000,
      fetch_impl: fetch_mock,
    });
    const pending = client.request('/x', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(UnisatNetworkError);
  });
});
