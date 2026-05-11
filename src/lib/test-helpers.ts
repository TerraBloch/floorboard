/**
 * Shared route-handler test helpers.
 *
 * Factored out of the per-route test files so we don't copy-paste the mock
 * fetch + adapter installation pattern six times. Production code never
 * imports this; it lives next to the lib it tests but is .ts not .test.ts
 * so it's not picked up as a test suite itself.
 *
 * Pattern: build a real UnisatAdapter pointed at a mock fetch, inject via
 * __setUnisatAdapterForTests, call route handlers' exported GET directly.
 * No HTTP server, no Next.js runtime — route handlers are plain functions
 * of (Request, { params }).
 */

import { UnisatAdapter } from '@/adapters/unisat/index.js';
import { __setUnisatAdapterForTests } from '@/lib/adapter-singleton.js';

export const FIXED_NOW = '2026-05-10T20:00:00.000Z';

export type MockResponse =
  | { status: number; body: unknown; bodyText?: string }
  | { throws: unknown };

export interface MockFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; init: RequestInit }>;
}

/**
 * Build a mock fetch that returns queued responses in FIFO order and
 * records each call's url + init. If an entry has a `throws` field, the
 * mock throws that value; otherwise it returns a Response with the body.
 */
export function makeMockFetch(responses: MockResponse[]): MockFetch {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
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
  return Object.assign(fn, { calls }) as MockFetch;
}

/**
 * Build a UnisatAdapter pointed at the mock and inject it into the
 * singleton so route handlers pick it up. Returns the adapter for tests
 * that want to inspect it directly (they usually don't).
 */
export function installAdapter(fetch_impl: typeof fetch): UnisatAdapter {
  const adapter = new UnisatAdapter({
    api_key: 'test-key',
    user_agent: 'floorboard-test/1.0',
    fetch_impl,
    now: () => new Date(FIXED_NOW),
  });
  __setUnisatAdapterForTests(adapter);
  return adapter;
}

export function resetAdapter(): void {
  __setUnisatAdapterForTests(undefined);
}

/**
 * Construct a Request object for a given URL path + optional query string.
 * Next.js passes a real Request to route handlers; for testing we can
 * construct one directly with the WHATWG URL API.
 */
export function makeRequest(path: string, query?: Record<string, string>): Request {
  const url = new URL(path, 'http://test.local');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return new Request(url.toString());
}

/**
 * Decode a recorded fetch call's JSON body. Throws if the body isn't a
 * string (route handlers should always send stringified JSON).
 */
export function bodyOf(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') {
    throw new Error('expected string body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}
