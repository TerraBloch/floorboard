/**
 * /v1/collections route handler tests.
 *
 * Covers: happy path with mapped Collections, default and explicit sort,
 * cursor + limit passthrough, 400 on invalid query params, and the
 * degraded-source 200 contract on operational errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  bodyOf,
  FIXED_NOW,
  installAdapter,
  makeMockFetch,
  makeRequest,
  resetAdapter,
} from '@/lib/test-helpers.js';
import { GET } from './route.js';

import collectionStatListFixture from '@/adapters/unisat/__fixtures__/collection_statistic_list.json' with { type: 'json' };

describe('GET /v1/collections', () => {
  beforeEach(() => resetAdapter());
  afterEach(() => resetAdapter());

  it('returns a paginated Collection page wrapped in SourcedResult', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: collectionStatListFixture },
    ]);
    installAdapter(fetch_mock);

    const res = await GET(makeRequest('/v1/collections'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.fetched_at).toBe(FIXED_NOW);
    expect(body.source_status.health).toBe('ok');
    expect(body.data.items).toBeInstanceOf(Array);
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.data.items[0].collection_id).toBeTruthy();
    expect(body.data.items[0].name).toBeTruthy();
    expect(typeof body.data.has_more).toBe('boolean');
  });

  it('defaults to volume_desc sort and limit=50', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: collectionStatListFixture },
    ]);
    installAdapter(fetch_mock);

    await GET(makeRequest('/v1/collections'));
    const sent = bodyOf(fetch_mock.calls[0]!.init);
    expect(sent.sort).toEqual({ btcValue: -1 });
    expect(sent.start).toBe(0);
    expect(sent.limit).toBe(50);
  });

  it('passes sort, cursor, and limit through to the adapter', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: collectionStatListFixture },
    ]);
    installAdapter(fetch_mock);

    await GET(
      makeRequest('/v1/collections', {
        sort: 'floor_asc',
        cursor: '100',
        limit: '25',
      }),
    );
    const sent = bodyOf(fetch_mock.calls[0]!.init);
    expect(sent.sort).toEqual({ floorPrice: 1 });
    expect(sent.start).toBe(100);
    expect(sent.limit).toBe(25);
  });

  it('rejects invalid sort values with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(makeRequest('/v1/collections', { sort: 'banana' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details[0].path).toBe('sort');
  });

  it('rejects limit above 100 with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(makeRequest('/v1/collections', { limit: '500' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
    expect(body.details[0].path).toBe('limit');
  });

  it('rejects non-integer limit with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(makeRequest('/v1/collections', { limit: '12.5' }));
    expect(res.status).toBe(400);
  });

  it('returns 200 + degraded SourcedResult on 503 from upstream', async () => {
    installAdapter(makeMockFetch([{ status: 503, body: { error: 'down' } }]));

    const res = await GET(makeRequest('/v1/collections'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.source_status.health).toBe('degraded');
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
  });

  it('returns 200 + unavailable SourcedResult on 401 from upstream', async () => {
    installAdapter(makeMockFetch([{ status: 401, body: { error: 'no auth' } }]));

    const res = await GET(makeRequest('/v1/collections'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_status.health).toBe('unavailable');
    expect(body.data.items).toEqual([]);
  });
});
