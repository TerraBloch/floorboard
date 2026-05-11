/**
 * /v1/health route handler tests.
 *
 * Strategy: build a real UnisatAdapter pointed at a mock fetch, inject it
 * via the test-only singleton setter, call the route handler's GET function
 * directly. See src/lib/test-helpers.ts for the shared mock + install pattern.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  FIXED_NOW,
  installAdapter,
  makeMockFetch,
  resetAdapter,
} from '@/lib/test-helpers';
import { GET } from './route.js';

import collectionStatListFixture from '@/adapters/unisat/__fixtures__/collection_statistic_list.json' with { type: 'json' };

describe('GET /v1/health', () => {
  beforeEach(() => resetAdapter());
  afterEach(() => resetAdapter());

  it('returns 200 with health ok when adapter ping succeeds', async () => {
    installAdapter(makeMockFetch([{ status: 200, body: collectionStatListFixture }]));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.health).toBe('ok');
    expect(body.last_success_at).toBe(FIXED_NOW);
  });

  it('returns 200 with degraded health on server error (never throws)', async () => {
    installAdapter(makeMockFetch([{ status: 503, body: { error: 'service down' } }]));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.health).toBe('degraded');
    expect(body.message).toMatch(/HTTP 503/);
  });

  it('returns 200 with unavailable health on auth rejection (never throws)', async () => {
    installAdapter(makeMockFetch([{ status: 401, body: { error: 'unauthorized' } }]));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.health).toBe('unavailable');
    expect(body.message).toMatch(/Auth rejected/);
  });

  it('returns 500 when env-var bootstrap fails', async () => {
    const original = process.env.UNISAT_API_KEY;
    delete process.env.UNISAT_API_KEY;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await GET();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('internal_error');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (original !== undefined) process.env.UNISAT_API_KEY = original;
    }
  });
});
