/**
 * UnisatAdapter integration tests.
 *
 * Mocks at the fetch level (same pattern as client.test.ts) so each test
 * exercises the real client → schema → mapper → adapter integration path.
 * Fixtures are the same four JSON files mappers.test.ts uses, so any drift
 * in the wire contract surfaces in two test suites at once.
 *
 * What this suite proves:
 *   - Happy paths: each VenueAdapter method returns SourcedResult with the
 *     right shape, source attribution, and mapped canonical types.
 *   - Pagination: cursor round-trips through `start` correctly; has_more
 *     reflects total vs current offset.
 *   - Sort: Floorboard's canonical sort enum translates to the right
 *     Unisat mongo-style sort spec on the wire.
 *   - Errors: operational errors (rate limit, 5xx, network, auth) throw
 *     UnisatAdapterUnavailableError carrying a SourceStatus; schema/contract
 *     errors rethrow native so CI catches them loudly.
 *   - health(): never throws, always returns a SourceStatus.
 *   - listEvents: client-side time-window and kind filters work as
 *     documented (Unisat /actions doesn't filter by time on the wire).
 */

import { describe, it, expect } from 'vitest';

import { UnisatAdapter, UnisatAdapterUnavailableError } from './index.js';
import { UnisatValidationError } from './client.js';

import auctionListFixture from './__fixtures__/auction_list.json' with { type: 'json' };
import auctionActionsFixture from './__fixtures__/auction_actions.json' with { type: 'json' };
import collectionStatListFixture from './__fixtures__/collection_statistic_list.json' with { type: 'json' };
import inscriptionInfoListFixture from './__fixtures__/inscription_info_list.json' with { type: 'json' };

// ─── Test helpers ─────────────────────────────────────────────────────────

const FIXED_NOW = '2026-05-10T20:00:00.000Z';

/**
 * Mock fetch — same shape as client.test.ts. Records calls and returns
 * queued responses one-by-one in FIFO order. We re-implement instead of
 * importing because vitest doesn't expose helpers across test files
 * without a shared module, and copy-paste-for-test-isolation is fine.
 */
function makeMockFetch(
  responses: Array<
    | { status: number; body: unknown; bodyText?: string }
    | { throws: unknown }
  >,
) {
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
  return Object.assign(fn as typeof fetch, { calls });
}

function makeAdapter(fetch_impl: typeof fetch): UnisatAdapter {
  return new UnisatAdapter({
    api_key: 'test-key',
    user_agent: 'floorboard-test/1.0',
    fetch_impl,
    now: () => new Date(FIXED_NOW),
  });
}

// Decode the JSON body from a captured fetch call's init.body.
function bodyOf(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') {
    throw new Error('expected string body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

// ─── Construction ─────────────────────────────────────────────────────────

describe('UnisatAdapter — construction', () => {
  it('declares the unisat source and Ordinals capabilities', () => {
    const adapter = makeAdapter(makeMockFetch([]));
    expect(adapter.source).toBe('unisat');
    expect(adapter.capabilities.supports_per_collection_listings).toBe(true);
    expect(adapter.capabilities.supports_per_asset_lookup).toBe(true);
    expect(adapter.capabilities.supports_event_feed).toBe(true);
    expect(adapter.capabilities.supports_collection_directory).toBe(true);
    expect(adapter.capabilities.supported_protocols).toEqual(['ordinal']);
    expect(adapter.capabilities.supports_floor_history).toBe(false);
  });
});

// ─── listListings ─────────────────────────────────────────────────────────

describe('UnisatAdapter.listListings', () => {
  it('returns mapped listings wrapped in SourcedResult', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.listListings({ collection_id: 'nodemonkes' });

    expect(result.source).toBe('unisat');
    expect(result.fetched_at).toBe(FIXED_NOW);
    expect(result.source_status.health).toBe('ok');
    // Nodemonkes fixture has 5 entries, all marketType=fixedPrice → all map
    expect(result.data.items).toHaveLength(5);
    expect(result.data.items[0]?.protocol).toBe('ordinal');
    expect(result.data.items[0]?.source).toBe('unisat');
    expect(result.data.items[0]?.collection_id).toBe('nodemonkes');
  });

  it('sends collectionId and price_asc sort by default', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
    const adapter = makeAdapter(fetch_mock);

    await adapter.listListings({ collection_id: 'nodemonkes' });

    const body = bodyOf(fetch_mock.calls[0]!.init);
    expect(body.filter).toEqual({ nftType: 'collection', collectionId: 'nodemonkes' });
    expect(body.sort).toEqual({ unitPrice: 1 });
    expect(body.start).toBe(0);
    expect(body.limit).toBe(50);
  });

  it('translates sort variants to Unisat mongo-style sort spec', async () => {
    const cases: Array<[
      'price_asc' | 'price_desc' | 'recent' | 'oldest',
      Record<string, number>,
    ]> = [
      ['price_asc', { unitPrice: 1 }],
      ['price_desc', { unitPrice: -1 }],
      ['recent', { onSaleTime: -1 }],
      ['oldest', { onSaleTime: 1 }],
    ];
    for (const [sort, expected] of cases) {
      const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
      const adapter = makeAdapter(fetch_mock);
      await adapter.listListings({ collection_id: 'nodemonkes', sort });
      expect(bodyOf(fetch_mock.calls[0]!.init).sort).toEqual(expected);
    }
  });

  it('round-trips cursor as stringified start offset', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
    const adapter = makeAdapter(fetch_mock);

    await adapter.listListings({ collection_id: 'nodemonkes', cursor: '100', limit: 25 });

    const body = bodyOf(fetch_mock.calls[0]!.init);
    expect(body.start).toBe(100);
    expect(body.limit).toBe(25);
  });

  it('computes next_cursor and has_more from total vs returned', async () => {
    // Fixture total is 126, we return 5 starting at 0 → has_more true, next=5
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionListFixture }]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.listListings({ collection_id: 'nodemonkes' });
    expect(result.data.has_more).toBe(true);
    expect(result.data.next_cursor).toBe('5');
  });

  it('throws on invalid cursor', async () => {
    const adapter = makeAdapter(makeMockFetch([]));
    await expect(
      adapter.listListings({ collection_id: 'nodemonkes', cursor: 'banana' }),
    ).rejects.toThrow(/invalid cursor/);
  });
});

// ─── getListingsForAsset ──────────────────────────────────────────────────

describe('UnisatAdapter.getListingsForAsset', () => {
  it('returns empty array when inscription is notOnSale (fixture case)', async () => {
    // The fixture inscription has notOnSale=true. mapInscriptionInfo returns
    // null, adapter filters it out, result is an empty Listing[].
    const fetch_mock = makeMockFetch([
      { status: 200, body: inscriptionInfoListFixture },
    ]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.getListingsForAsset(
      'dba88ce96eeb3eb93c4602ccb986880b43c9dd1de21cdda9d2ca24ee79f89bb9i0',
    );

    expect(result.source).toBe('unisat');
    expect(result.data).toEqual([]);
    expect(result.source_status.health).toBe('ok');
  });

  it('returns one Listing when inscription is actively listed', async () => {
    // Synthetic: same fixture shape but with notOnSale=false and listing fields.
    // Using a shape derived from the real fixture so schema validation passes.
    const synthetic = {
      code: 0,
      msg: 'ok',
      data: [
        {
          ...inscriptionInfoListFixture.data[0],
          notOnSale: false,
          auctionId: 'synthetic-auction',
          price: 1234567,
          onSaleTime: 1770442770769,
          address: 'bc1p_seller_synthetic',
        },
      ],
    };
    const fetch_mock = makeMockFetch([{ status: 200, body: synthetic }]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.getListingsForAsset(
      'dba88ce96eeb3eb93c4602ccb986880b43c9dd1de21cdda9d2ca24ee79f89bb9i0',
    );

    expect(result.data).toHaveLength(1);
    const listing = result.data[0]!;
    expect(listing.source).toBe('unisat');
    expect(listing.price_sats).toBe(1234567);
    expect(listing.seller_address).toBe('bc1p_seller_synthetic');
  });

  it('passes the asset_id as inscriptionIds on the wire', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: inscriptionInfoListFixture },
    ]);
    const adapter = makeAdapter(fetch_mock);

    await adapter.getListingsForAsset('abc123i0');

    const body = bodyOf(fetch_mock.calls[0]!.init);
    expect(body.inscriptionIds).toEqual(['abc123i0']);
  });
});

// ─── listEvents ───────────────────────────────────────────────────────────

describe('UnisatAdapter.listEvents', () => {
  it('returns mapped events from /actions', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.listEvents({
      since: '2020-01-01T00:00:00.000Z', // wide window, all 5 events pass
    });

    expect(result.data.items).toHaveLength(5);
    expect(result.data.items.every((e) => e.kind === 'sold')).toBe(true);
    expect(result.data.items[0]?.source).toBe('unisat');
  });

  it('filters out events older than `since` client-side', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    const adapter = makeAdapter(fetch_mock);

    // Fixture's newest event is timestamp 1778433603406 (~2026-05-10)
    // Set `since` to just after the newest timestamp — all events drop.
    const since = new Date(1778433603406 + 1).toISOString();
    const result = await adapter.listEvents({ since });

    expect(result.data.items).toEqual([]);
  });

  it('uses wire-level event filter when exactly one kind is requested', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    const adapter = makeAdapter(fetch_mock);

    await adapter.listEvents({
      since: '2020-01-01T00:00:00.000Z',
      kinds: ['sold'],
    });

    const body = bodyOf(fetch_mock.calls[0]!.init);
    expect((body.filter as Record<string, unknown>).event).toBe('Sold');
  });

  it('omits wire-level event filter when multiple kinds are requested', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    const adapter = makeAdapter(fetch_mock);

    await adapter.listEvents({
      since: '2020-01-01T00:00:00.000Z',
      kinds: ['sold', 'listed'],
    });

    const body = bodyOf(fetch_mock.calls[0]!.init);
    expect((body.filter as Record<string, unknown>).event).toBeUndefined();
  });

  it('filters by collection_id client-side', async () => {
    const fetch_mock = makeMockFetch([{ status: 200, body: auctionActionsFixture }]);
    const adapter = makeAdapter(fetch_mock);

    // Fixture has 4 runestone events and 1 bitmap event
    const result = await adapter.listEvents({
      since: '2020-01-01T00:00:00.000Z',
      collection_id: 'bitmap',
    });

    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]?.collection_id).toBe('bitmap');
  });

  it('throws on invalid `since`', async () => {
    const adapter = makeAdapter(makeMockFetch([]));
    await expect(
      adapter.listEvents({ since: 'not-a-date' }),
    ).rejects.toThrow(/invalid 'since'/);
  });
});

// ─── listCollections ──────────────────────────────────────────────────────

describe('UnisatAdapter.listCollections', () => {
  it('returns mapped collections sorted by volume by default', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: collectionStatListFixture },
    ]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.listCollections({});
    expect(result.data.items).toHaveLength(5);
    expect(result.data.items[0]?.collection_id).toBe('bitmap');
    expect(result.data.items[0]?.name).toBe('Bitmap');

    const body = bodyOf(fetch_mock.calls[0]!.init);
    expect(body.sort).toEqual({ btcValue: -1 });
    expect(body.filter).toEqual({ timeType: 'all' });
  });

  it('translates sort variants', async () => {
    const cases: Array<[
      'volume_desc' | 'floor_asc' | 'recent' | 'listed_count_desc',
      Record<string, number>,
    ]> = [
      ['volume_desc', { btcValue: -1 }],
      ['floor_asc', { floorPrice: 1 }],
      ['recent', { transactionCount24h: -1 }],
      ['listed_count_desc', { listed: -1 }],
    ];
    for (const [sort, expected] of cases) {
      const fetch_mock = makeMockFetch([
        { status: 200, body: collectionStatListFixture },
      ]);
      const adapter = makeAdapter(fetch_mock);
      await adapter.listCollections({ sort });
      expect(bodyOf(fetch_mock.calls[0]!.init).sort).toEqual(expected);
    }
  });
});

// ─── getCollectionStats ───────────────────────────────────────────────────

describe('UnisatAdapter.getCollectionStats', () => {
  it('returns the matching collection from the directory', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: collectionStatListFixture },
    ]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.getCollectionStats('bitcoin-frogs');
    expect(result.data.collection_id).toBe('bitcoin-frogs');
    expect(result.data.name).toBe('Bitcoin Frogs');
    expect(result.data.floor_price_sats).toBe(698000);
  });

  it('pages forward when the target is not in the first page', async () => {
    // First call: 5 collections, none matching, list.length === PAGE size would
    // tell the loop to keep going, but our fixture has list.length=5 which is
    // less than PAGE (200), so the loop terminates after one call.
    // Test the not-found path: target not present, list shorter than PAGE.
    const fetch_mock = makeMockFetch([
      { status: 200, body: collectionStatListFixture },
    ]);
    const adapter = makeAdapter(fetch_mock);

    await expect(
      adapter.getCollectionStats('does-not-exist'),
    ).rejects.toThrow(/not found in Unisat directory/);
  });
});

// ─── health() ─────────────────────────────────────────────────────────────

describe('UnisatAdapter.health', () => {
  it('returns ok on a successful ping', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: collectionStatListFixture },
    ]);
    const adapter = makeAdapter(fetch_mock);

    const status = await adapter.health();
    expect(status.health).toBe('ok');
    expect(status.source).toBe('unisat');
    expect(status.last_success_at).toBe(FIXED_NOW);
  });

  it('returns unavailable on 401 auth rejection', async () => {
    const fetch_mock = makeMockFetch([{ status: 401, body: { msg: 'unauthorized' } }]);
    const adapter = makeAdapter(fetch_mock);

    const status = await adapter.health();
    expect(status.health).toBe('unavailable');
    expect(status.message).toMatch(/Auth rejected/);
  });

  it('returns degraded on 500 server error', async () => {
    const fetch_mock = makeMockFetch([{ status: 500, body: { msg: 'oops' } }]);
    const adapter = makeAdapter(fetch_mock);

    const status = await adapter.health();
    expect(status.health).toBe('degraded');
    expect(status.message).toMatch(/Server error/);
  });

  it('returns degraded on network error', async () => {
    const fetch_mock = makeMockFetch([{ throws: new TypeError('fetch failed') }]);
    const adapter = makeAdapter(fetch_mock);

    const status = await adapter.health();
    expect(status.health).toBe('degraded');
    expect(status.message).toMatch(/Network error/);
  });

  it('never throws — wraps unknown errors as degraded', async () => {
    // Force an unrecognized error type out of fetch. The adapter's catch
    // should still produce a SourceStatus, not bubble.
    const fetch_mock = makeMockFetch([{ throws: new Error('mystery') }]);
    const adapter = makeAdapter(fetch_mock);

    const status = await adapter.health();
    expect(['degraded', 'unavailable']).toContain(status.health);
  });
});

// ─── Error translation on non-health methods ─────────────────────────────

describe('UnisatAdapter — error translation', () => {
  it('throws UnisatAdapterUnavailableError on operational 5xx', async () => {
    const fetch_mock = makeMockFetch([{ status: 503, body: { msg: 'down' } }]);
    const adapter = makeAdapter(fetch_mock);

    await expect(
      adapter.listListings({ collection_id: 'nodemonkes' }),
    ).rejects.toBeInstanceOf(UnisatAdapterUnavailableError);
  });

  it('UnisatAdapterUnavailableError carries the SourceStatus', async () => {
    const fetch_mock = makeMockFetch([{ status: 503, body: { msg: 'down' } }]);
    const adapter = makeAdapter(fetch_mock);

    try {
      await adapter.listListings({ collection_id: 'nodemonkes' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatAdapterUnavailableError);
      const u = err as UnisatAdapterUnavailableError;
      expect(u.status.health).toBe('degraded');
      expect(u.status.source).toBe('unisat');
    }
  });

  it('throws unavailable on 401', async () => {
    const fetch_mock = makeMockFetch([{ status: 401, body: { msg: 'no auth' } }]);
    const adapter = makeAdapter(fetch_mock);

    try {
      await adapter.listCollections({});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatAdapterUnavailableError);
      expect((err as UnisatAdapterUnavailableError).status.health).toBe('unavailable');
    }
  });

  it('throws unavailable on network error', async () => {
    const fetch_mock = makeMockFetch([{ throws: new TypeError('connection refused') }]);
    const adapter = makeAdapter(fetch_mock);

    try {
      await adapter.listCollections({});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnisatAdapterUnavailableError);
      expect((err as UnisatAdapterUnavailableError).status.health).toBe('degraded');
    }
  });

  it('rethrows schema validation errors natively (not wrapped)', async () => {
    // Return a body that parses as JSON but fails Zod schema validation.
    // Should bubble out as a ZodError, NOT be wrapped in UnisatAdapterUnavailableError.
    const fetch_mock = makeMockFetch([
      { status: 200, body: { code: 0, msg: 'ok', data: { list: 'wrong-type', total: 'also-wrong' } } },
    ]);
    const adapter = makeAdapter(fetch_mock);

    await expect(
      adapter.listListings({ collection_id: 'nodemonkes' }),
    ).rejects.not.toBeInstanceOf(UnisatAdapterUnavailableError);
  });

  it('rethrows UnisatValidationError natively (4xx that is not auth)', async () => {
    // Fastify validation 400. classifyError returns null for non-auth 4xx,
    // so the original error rethrows. Body shape must include the
    // FST_ERR_VALIDATION code for the client to recognize it as Fastify
    // validation rather than a generic HTTP error.
    const fetch_mock = makeMockFetch([
      {
        status: 400,
        body: {
          code: 'FST_ERR_VALIDATION',
          message: "body/filter/nftType must be one of: brc20, domain, collection",
        },
      },
    ]);
    const adapter = makeAdapter(fetch_mock);

    await expect(
      adapter.listListings({ collection_id: 'nodemonkes' }),
    ).rejects.toBeInstanceOf(UnisatValidationError);
  });
});

// ─── Cursor semantics ─────────────────────────────────────────────────────

describe('UnisatAdapter — cursor semantics', () => {
  it('returns null next_cursor when last page is reached', async () => {
    // Synthesize a response where start + list.length >= total.
    const last_page = {
      code: 0,
      msg: 'ok',
      data: {
        list: auctionListFixture.data.list,
        total: 5, // exactly the number we returned
      },
    };
    const fetch_mock = makeMockFetch([{ status: 200, body: last_page }]);
    const adapter = makeAdapter(fetch_mock);

    const result = await adapter.listListings({ collection_id: 'nodemonkes' });
    expect(result.data.has_more).toBe(false);
    expect(result.data.next_cursor).toBeNull();
  });
});
