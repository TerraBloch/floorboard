/**
 * /v1/events route handler tests.
 *
 * Covers: happy path returning VenueEvents page, since is required (400
 * if missing), since must be parseable (400 if junk), kinds parsing
 * (single → wire filter; multiple → client-side), collection_id
 * client-side filter, cursor/limit passthrough, degraded-source contract.
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

import auctionActionsFixture from '@/adapters/unisat/__fixtures__/auction_actions.json' with { type: 'json' };

// All fixture events are on 2026-05-10. Use a since well before to include them.
const SINCE = '2026-05-09T00:00:00.000Z';

describe('GET /v1/events', () => {
  beforeEach(() => resetAdapter());
  afterEach(() => resetAdapter());

  it('returns a VenueEvent page wrapped in SourcedResult', async () => {
    installAdapter(makeMockFetch([{ status: 200, body: auctionActionsFixture }]));

    const res = await GET(makeRequest('/v1/events', { since: SINCE }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.fetched_at).toBe(FIXED_NOW);
    expect(body.source_status.health).toBe('ok');
    // Fixture has 5 Sold events all on 2026-05-10, all pass the since filter.
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.data.items.every((ev: { source: string }) => ev.source === 'unisat')).toBe(true);
    expect(body.data.items.every((ev: { kind: string }) => ev.kind === 'sold')).toBe(true);
  });

  it('requires since with 400 when missing', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(makeRequest('/v1/events'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
    expect(body.details.some((d: { path: string }) => d.path === 'since')).toBe(true);
  });

  it('rejects since that is not a parseable timestamp', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(makeRequest('/v1/events', { since: 'banana' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.some((d: { path: string }) => d.path === 'since')).toBe(true);
  });

  it('translates a single kind to Unisat wire filter', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    installAdapter(fetch_mock);

    await GET(makeRequest('/v1/events', { since: SINCE, kinds: 'sold' }));
    const sent = bodyOf(fetch_mock.calls[0]!.init) as {
      filter: { event?: string };
    };
    expect(sent.filter.event).toBe('Sold');
  });

  it('omits wire filter when multiple kinds requested (client-side filter)', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    installAdapter(fetch_mock);

    await GET(makeRequest('/v1/events', { since: SINCE, kinds: 'sold,listed' }));
    const sent = bodyOf(fetch_mock.calls[0]!.init) as {
      filter: Record<string, unknown>;
    };
    expect(sent.filter.event).toBeUndefined();
  });

  it('rejects unknown event kind in kinds with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(
      makeRequest('/v1/events', { since: SINCE, kinds: 'sold,banana' }),
    );
    expect(res.status).toBe(400);
  });

  it('applies client-side collection_id filter to results', async () => {
    installAdapter(makeMockFetch([{ status: 200, body: auctionActionsFixture }]));

    // Fixture has 3 runestone events and 1 bitmap event among Sold events.
    const res = await GET(
      makeRequest('/v1/events', { since: SINCE, collection_id: 'bitmap' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.data.items.every(
        (ev: { collection_id: string }) => ev.collection_id === 'bitmap',
      ),
    ).toBe(true);
  });

  it('filters out events older than since (client-side)', async () => {
    installAdapter(makeMockFetch([{ status: 200, body: auctionActionsFixture }]));

    // Fixture events are on 2026-05-10; this since is the day after — everything filtered out.
    const res = await GET(
      makeRequest('/v1/events', { since: '2026-05-11T00:00:00.000Z' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });

  it('round-trips cursor and limit', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    installAdapter(fetch_mock);

    await GET(
      makeRequest('/v1/events', { since: SINCE, cursor: '100', limit: '25' }),
    );
    const sent = bodyOf(fetch_mock.calls[0]!.init);
    expect(sent.start).toBe(100);
    expect(sent.limit).toBe(25);
  });

  it('rejects invalid collection_id with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(
      makeRequest('/v1/events', { since: SINCE, collection_id: 'bad..slug' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 + degraded SourcedResult on 503', async () => {
    installAdapter(makeMockFetch([{ status: 503, body: { error: 'down' } }]));

    const res = await GET(makeRequest('/v1/events', { since: SINCE }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_status.health).toBe('degraded');
    expect(body.data.items).toEqual([]);
  });

  it('returns 200 + unavailable SourcedResult on 401', async () => {
    installAdapter(makeMockFetch([{ status: 401, body: { error: 'no auth' } }]));

    const res = await GET(makeRequest('/v1/events', { since: SINCE }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_status.health).toBe('unavailable');
  });
});
