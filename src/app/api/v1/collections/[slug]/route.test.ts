/**
 * /v1/collections/:slug route handler tests.
 *
 * Covers: happy path returning a single Collection in SourcedResult,
 * 404 collection_not_found for slugs missing from the directory,
 * 400 invalid_request for malformed slugs, and the degraded-source 200
 * contract (data: null + degraded status) on operational errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  FIXED_NOW,
  installAdapter,
  makeMockFetch,
  makeRequest,
  resetAdapter,
} from '@/lib/test-helpers.js';
import { GET } from './route.js';

import collectionStatListFixture from '@/adapters/unisat/__fixtures__/collection_statistic_list.json' with { type: 'json' };

describe('GET /v1/collections/:slug', () => {
  beforeEach(() => resetAdapter());
  afterEach(() => resetAdapter());

  it('returns the matching Collection wrapped in SourcedResult', async () => {
    // Fixture has 5 collections; bitmap is the first entry.
    installAdapter(makeMockFetch([{ status: 200, body: collectionStatListFixture }]));

    const res = await GET(makeRequest('/v1/collections/bitmap'), {
      params: { slug: 'bitmap' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.fetched_at).toBe(FIXED_NOW);
    expect(body.source_status.health).toBe('ok');
    expect(body.data.collection_id).toBe('bitmap');
    expect(body.data.name).toBe('Bitmap');
  });

  it('returns 404 when slug is not in the directory', async () => {
    // Fixture has 5 entries and the adapter sees list.length < PAGE (200),
    // so it breaks after one call and throws UnisatCollectionNotFoundError.
    installAdapter(makeMockFetch([{ status: 200, body: collectionStatListFixture }]));

    const res = await GET(makeRequest('/v1/collections/does-not-exist'), {
      params: { slug: 'does-not-exist' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('collection_not_found');
    expect(body.details.collection_id).toBe('does-not-exist');
    expect(body.details.source).toBe('unisat');
  });

  it('rejects slugs with invalid characters (400)', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(makeRequest('/v1/collections/bad..slug'), {
      params: { slug: 'bad..slug' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it('rejects empty slug (400)', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(makeRequest('/v1/collections/'), { params: { slug: '' } });
    expect(res.status).toBe(400);
  });

  it('returns 200 with data: null and degraded status on 503', async () => {
    installAdapter(makeMockFetch([{ status: 503, body: { error: 'down' } }]));

    const res = await GET(makeRequest('/v1/collections/bitmap'), {
      params: { slug: 'bitmap' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.source_status.health).toBe('degraded');
  });

  it('returns 200 with data: null and unavailable status on 401', async () => {
    installAdapter(makeMockFetch([{ status: 401, body: { error: 'no auth' } }]));

    const res = await GET(makeRequest('/v1/collections/bitmap'), {
      params: { slug: 'bitmap' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.source_status.health).toBe('unavailable');
  });
});
