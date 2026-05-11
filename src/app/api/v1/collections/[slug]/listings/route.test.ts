/**
 * /v1/collections/:slug/listings route handler tests.
 *
 * Covers: happy path returning mapped Listings page, default and explicit
 * sort, cursor/limit passthrough, slug validation (400), query validation
 * (400), and the degraded-source 200 contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  bodyOf,
  FIXED_NOW,
  installAdapter,
  makeMockFetch,
  makeRequest,
  resetAdapter,
} from '@/lib/test-helpers';
import { GET } from './route.js';

import auctionListFixture from '@/adapters/unisat/__fixtures__/auction_list.json' with { type: 'json' };

describe('GET /v1/collections/:slug/listings', () => {
  beforeEach(() => resetAdapter());
  afterEach(() => resetAdapter());

  it('returns a paginated Listing page wrapped in SourcedResult', async () => {
    installAdapter(makeMockFetch([{ status: 200, body: auctionListFixture }]));

    const res = await GET(
      makeRequest('/v1/collections/nodemonkes/listings'),
      { params: { slug: 'nodemonkes' } },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.fetched_at).toBe(FIXED_NOW);
    expect(body.source_status.health).toBe('ok');
    // Fixture has 5 entries, all marketType=fixedPrice → all map through.
    expect(body.data.items).toHaveLength(5);
    expect(body.data.items[0].protocol).toBe('ordinal');
    expect(body.data.items[0].source).toBe('unisat');
    expect(body.data.items[0].collection_id).toBe('nodemonkes');
    // Total 126 vs 5 returned → has_more true.
    expect(body.data.has_more).toBe(true);
    expect(body.data.next_cursor).toBe('5');
  });

  it('passes slug to adapter as collectionId filter with price_asc default', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
    installAdapter(fetch_mock);

    await GET(
      makeRequest('/v1/collections/nodemonkes/listings'),
      { params: { slug: 'nodemonkes' } },
    );
    const sent = bodyOf(fetch_mock.calls[0]!.init);
    expect(sent.filter).toEqual({ nftType: 'collection', collectionId: 'nodemonkes' });
    expect(sent.sort).toEqual({ unitPrice: 1 });
    expect(sent.start).toBe(0);
    expect(sent.limit).toBe(50);
  });

  it('translates sort variants to the right Unisat sort spec', async () => {
    const cases: Array<['price_asc' | 'price_desc' | 'recent' | 'oldest', Record<string, number>]> = [
      ['price_asc', { unitPrice: 1 }],
      ['price_desc', { unitPrice: -1 }],
      ['recent', { onSaleTime: -1 }],
      ['oldest', { onSaleTime: 1 }],
    ];
    for (const [sort, expected] of cases) {
      const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
      installAdapter(fetch_mock);
      await GET(
        makeRequest('/v1/collections/nodemonkes/listings', { sort }),
        { params: { slug: 'nodemonkes' } },
      );
      expect(bodyOf(fetch_mock.calls[0]!.init).sort).toEqual(expected);
    }
  });

  it('round-trips cursor and limit', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
    installAdapter(fetch_mock);

    await GET(
      makeRequest('/v1/collections/nodemonkes/listings', { cursor: '100', limit: '25' }),
      { params: { slug: 'nodemonkes' } },
    );
    const sent = bodyOf(fetch_mock.calls[0]!.init);
    expect(sent.start).toBe(100);
    expect(sent.limit).toBe(25);
  });

  it('rejects invalid slug with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(
      makeRequest('/v1/collections/bad..slug/listings'),
      { params: { slug: 'bad..slug' } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it('rejects invalid sort with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(
      makeRequest('/v1/collections/nodemonkes/listings', { sort: 'banana' }),
      { params: { slug: 'nodemonkes' } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details[0].path).toBe('sort');
  });

  it('rejects limit above 100 with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(
      makeRequest('/v1/collections/nodemonkes/listings', { limit: '500' }),
      { params: { slug: 'nodemonkes' } },
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 + degraded SourcedResult on 503', async () => {
    installAdapter(makeMockFetch([{ status: 503, body: { error: 'down' } }]));

    const res = await GET(
      makeRequest('/v1/collections/nodemonkes/listings'),
      { params: { slug: 'nodemonkes' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_status.health).toBe('degraded');
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
  });

  it('returns 200 + unavailable SourcedResult on 401', async () => {
    installAdapter(makeMockFetch([{ status: 401, body: { error: 'no auth' } }]));

    const res = await GET(
      makeRequest('/v1/collections/nodemonkes/listings'),
      { params: { slug: 'nodemonkes' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_status.health).toBe('unavailable');
    expect(body.data.items).toEqual([]);
  });
});
