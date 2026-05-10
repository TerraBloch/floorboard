/**
 * Mapper tests — fixture-driven.
 *
 * Tests parse the four real Unisat response fixtures (captured May 10) through
 * the corresponding Zod schemas, then map to canonical Floorboard types,
 * and assert specific field values. Schema validation and mapping are tested
 * end-to-end together because that's the actual production path.
 *
 * If a Unisat schema change breaks the fixtures, these tests fail at parse
 * time with a Zod error — exactly the loud signal we want.
 */

import { describe, it, expect } from 'vitest';

import {
  UnisatAuctionListResponseSchema,
  UnisatAuctionActionsResponseSchema,
  UnisatCollectionStatListResponseSchema,
  UnisatInscriptionInfoListResponseSchema,
} from './schemas.js';
import {
  mapListing,
  mapAction,
  mapSale,
  mapCollection,
  mapInscriptionInfo,
  MapperError,
} from './mappers.js';

import auctionListFixture from './__fixtures__/auction_list.json' with { type: 'json' };
import auctionActionsFixture from './__fixtures__/auction_actions.json' with { type: 'json' };
import collectionStatListFixture from './__fixtures__/collection_statistic_list.json' with { type: 'json' };
import inscriptionInfoListFixture from './__fixtures__/inscription_info_list.json' with { type: 'json' };

const FETCHED_AT = '2026-05-10T20:00:00.000Z';

// ============================================================================
// Schema parsing — fixtures must validate cleanly before we map anything
// ============================================================================

describe('Unisat schemas validate live fixtures', () => {
  it('parses auction_list fixture without error', () => {
    expect(() => UnisatAuctionListResponseSchema.parse(auctionListFixture)).not.toThrow();
  });

  it('parses auction_actions fixture without error', () => {
    expect(() => UnisatAuctionActionsResponseSchema.parse(auctionActionsFixture)).not.toThrow();
  });

  it('parses collection_statistic_list fixture without error', () => {
    expect(() =>
      UnisatCollectionStatListResponseSchema.parse(collectionStatListFixture)
    ).not.toThrow();
  });

  it('parses inscription_info_list fixture without error', () => {
    expect(() =>
      UnisatInscriptionInfoListResponseSchema.parse(inscriptionInfoListFixture)
    ).not.toThrow();
  });
});

// ============================================================================
// mapListing — auction/list → canonical Listing
// ============================================================================

describe('mapListing', () => {
  const parsed = UnisatAuctionListResponseSchema.parse(auctionListFixture);
  const rawListings = parsed.data.list;

  it('maps the first nodemonkes listing with all fields populated correctly', () => {
    const raw = rawListings[0]!;
    const result = mapListing(raw, FETCHED_AT);

    expect(result).not.toBeNull();
    expect(result).toEqual({
      protocol: 'ordinal',
      asset_id: 'dba88ce96eeb3eb93c4602ccb986880b43c9dd1de21cdda9d2ca24ee79f89bb9i0',
      inscription_number: 109654,
      collection_id: 'nodemonkes',
      collection_name: null,
      item_name: null,
      content_type: 'image/png',
      price_sats: 1800000,
      unit_price_sats: 18000000,
      quantity: 1,
      source: 'unisat',
      source_url:
        'https://unisat.io/inscription/dba88ce96eeb3eb93c4602ccb986880b43c9dd1de21cdda9d2ca24ee79f89bb9i0',
      source_listing_id: 'cdusou4421copuxvfr71b66gffdegrdg',
      seller_address: 'bc1plv650ttj9j2g5rl24x7yn9zmkfeslmjxq45lw6a63rdl2wrama3qtvvddw',
      listed_at: '2026-02-07T05:39:30.769Z',
      fetched_at: FETCHED_AT,
    });
  });

  it('handles the 5th listing where unitPrice and amount are null', () => {
    // Real fixture quirk: an old listing record with unitPrice=null, amount=null,
    // but price=39000000 populated. This validated empirically that
    // unitPrice/amount must be nullable in the schema and undefined in canonical.
    const raw = rawListings[4]!;
    expect(raw.unitPrice).toBeNull();
    expect(raw.amount).toBeNull();

    const result = mapListing(raw, FETCHED_AT);
    expect(result).not.toBeNull();
    expect(result!.price_sats).toBe(39000000);
    expect(result!.unit_price_sats).toBeUndefined();
    expect(result!.quantity).toBeUndefined();
  });

  it('builds source_url using inscriptionId, not auctionId', () => {
    // Verified empirically May 10: Unisat deep links use /inscription/{id},
    // not /market/collection/auction/{auctionId} as the audit doc had guessed.
    const raw = rawListings[0]!;
    const result = mapListing(raw, FETCHED_AT)!;
    expect(result.source_url).toContain('/inscription/');
    expect(result.source_url).toContain(raw.inscriptionId);
    expect(result.source_url).not.toContain(raw.auctionId);
  });

  it('returns null for non-fixedPrice listings', () => {
    const raw = { ...rawListings[0]!, marketType: 'auction' };
    expect(mapListing(raw, FETCHED_AT)).toBeNull();
  });

  it('every fixture listing maps to a non-null Listing (all are fixedPrice)', () => {
    const mapped = rawListings.map((r) => mapListing(r, FETCHED_AT));
    expect(mapped.every((m) => m !== null)).toBe(true);
    expect(mapped).toHaveLength(5);
  });

  it('passes through price as integer sats, never converting', () => {
    for (const raw of rawListings) {
      const result = mapListing(raw, FETCHED_AT)!;
      expect(Number.isInteger(result.price_sats)).toBe(true);
      expect(result.price_sats).toBe(raw.price);
    }
  });
});

// ============================================================================
// mapAction — auction/actions → canonical VenueEvent
// ============================================================================

describe('mapAction', () => {
  const parsed = UnisatAuctionActionsResponseSchema.parse(auctionActionsFixture);
  const rawActions = parsed.data.list;

  it('maps the first Sold event correctly', () => {
    const raw = rawActions[0]!;
    expect(raw.event).toBe('Sold');

    const result = mapAction(raw, FETCHED_AT);

    expect(result).toEqual({
      kind: 'sold',
      protocol: 'ordinal',
      asset_id: 'fa05d7a410075f4c872e9550bd38ad9ab5f5df8554b8ea3ea46ce783f2919a18i832',
      inscription_number: 64400257,
      collection_id: 'runestone',
      collection_name: null,
      item_name: 'Runestone #30234',
      price_sats: 134500,
      unit_price_sats: 134500,
      from_address: 'bc1pskcskpgljlr234rh8648sqggmfkqu9spgzqf3c5jg3g8gefkaxmsxy9e0y',
      to_address: 'bc1pj8dnrnnw6uk2newca2wlunsrv6dthqayv6r3r5d9y02qykk833dswgdmxx',
      source: 'unisat',
      source_event_id: '46na55tzjoo6031t54ca5ik4xacthhwu',
      txid: '6507db498696a08ef06b5454b7dab71c245b750bd61d596dc98e247d2814a676',
      occurred_at: '2026-05-10T17:20:03.406Z',
      fetched_at: FETCHED_AT,
    });
  });

  it('preserves multi-inscription suffix in asset_id (runestones use iN with N>0)', () => {
    // Runestone #71102 has inscriptionId ending in i1100 — a real test of the
    // "asset_id is the whole string, do not split on i" rule.
    const runestone71102 = rawActions.find(
      (r) => r.collectionItemName === 'Runestone #71102'
    )!;
    expect(runestone71102).toBeDefined();
    expect(runestone71102.inscriptionId).toMatch(/i1100$/);

    const result = mapAction(runestone71102, FETCHED_AT)!;
    expect(result.asset_id).toBe(runestone71102.inscriptionId);
    expect(result.asset_id).toContain('i1100');
  });

  it('returns null for Claim events (auction settlement, out of V1 scope)', () => {
    const raw = { ...rawActions[0]!, event: 'Claim' as const };
    expect(mapAction(raw, FETCHED_AT)).toBeNull();
  });

  it('all five Sold fixture events map to non-null', () => {
    const mapped = rawActions.map((r) => mapAction(r, FETCHED_AT));
    expect(mapped.every((m) => m !== null)).toBe(true);
    expect(mapped).toHaveLength(5);
    expect(mapped.every((m) => m!.kind === 'sold')).toBe(true);
  });

  it('event kind enum maps Listed/Cancel/Sold/Updated correctly', () => {
    const cases: Array<[string, string]> = [
      ['Listed', 'listed'],
      ['Cancel', 'cancelled'],
      ['Sold', 'sold'],
      ['Updated', 'updated'],
    ];
    for (const [unisatEvent, canonical] of cases) {
      const raw = { ...rawActions[0]!, event: unisatEvent as 'Listed' };
      expect(mapAction(raw, FETCHED_AT)!.kind).toBe(canonical);
    }
  });
});

// ============================================================================
// mapSale — Sold events specifically → canonical Sale
// ============================================================================

describe('mapSale', () => {
  const parsed = UnisatAuctionActionsResponseSchema.parse(auctionActionsFixture);
  const rawActions = parsed.data.list;

  it('maps a Sold event to a full Sale record', () => {
    const raw = rawActions[0]!;
    const result = mapSale(raw, FETCHED_AT);

    expect(result).toEqual({
      protocol: 'ordinal',
      asset_id: 'fa05d7a410075f4c872e9550bd38ad9ab5f5df8554b8ea3ea46ce783f2919a18i832',
      inscription_number: 64400257,
      collection_id: 'runestone',
      collection_name: null,
      item_name: 'Runestone #30234',
      price_sats: 134500,
      unit_price_sats: 134500,
      source: 'unisat',
      source_sale_id: '46na55tzjoo6031t54ca5ik4xacthhwu',
      seller_address: 'bc1pskcskpgljlr234rh8648sqggmfkqu9spgzqf3c5jg3g8gefkaxmsxy9e0y',
      buyer_address: 'bc1pj8dnrnnw6uk2newca2wlunsrv6dthqayv6r3r5d9y02qykk833dswgdmxx',
      txid: '6507db498696a08ef06b5454b7dab71c245b750bd61d596dc98e247d2814a676',
      sold_at: '2026-05-10T17:20:03.406Z',
      fetched_at: FETCHED_AT,
    });
  });

  it('returns null for non-Sold events', () => {
    const raw = { ...rawActions[0]!, event: 'Listed' as const };
    expect(mapSale(raw, FETCHED_AT)).toBeNull();
  });

  it('throws MapperError on Sold event with null from address', () => {
    const raw = { ...rawActions[0]!, from: null };
    expect(() => mapSale(raw, FETCHED_AT)).toThrow(MapperError);
  });

  it('throws MapperError on Sold event with null to address', () => {
    const raw = { ...rawActions[0]!, to: null };
    expect(() => mapSale(raw, FETCHED_AT)).toThrow(MapperError);
  });
});

// ============================================================================
// mapCollection — collection_statistic_list → canonical Collection
// ============================================================================

describe('mapCollection', () => {
  const parsed = UnisatCollectionStatListResponseSchema.parse(collectionStatListFixture);
  const rawCollections = parsed.data.list;

  it('maps the top collection (Bitmap) correctly', () => {
    const bitmap = rawCollections[0]!;
    expect(bitmap.collectionId).toBe('bitmap');

    const result = mapCollection(bitmap, FETCHED_AT);
    expect(result).toEqual({
      collection_id: 'bitmap',
      name: 'Bitmap',
      description: null, // empty string normalized to null
      icon_url: 'https://next-cdn.unisat.space/collection/logo/bitmap.png',
      twitter: null,
      discord: null,
      website: null,
      floor_price_sats: 10000,
      total_listed: 3429,
      total_supply: 948823,
      market_cap_sats: 9488230000,
      fetched_at: FETCHED_AT,
    });
  });

  it('preserves twitter/discord/website when populated (Bitcoin Frogs)', () => {
    const frogs = rawCollections.find((c) => c.collectionId === 'bitcoin-frogs')!;
    expect(frogs).toBeDefined();

    const result = mapCollection(frogs, FETCHED_AT);
    expect(result.twitter).toBe('https://twitter.com/BitcoinFrogs');
    expect(result.discord).toBe('https://discord.gg/ymZmyBzaSR');
    expect(result.website).toBe('https://bitcoinfrogs.com');
    expect(result.description).toContain('Bitcoin Frogs are 10,000');
  });

  it('passes bare-inscription-id icons through unchanged (Hiro resolves later)', () => {
    // bitcoin-frogs has icon = "d199...i0" (an inscription ID, not a URL).
    // Hiro adapter will resolve this to a content URL downstream.
    const frogs = rawCollections.find((c) => c.collectionId === 'bitcoin-frogs')!;
    const result = mapCollection(frogs, FETCHED_AT);
    expect(result.icon_url).toMatch(/^[a-f0-9]+i\d+$/);
  });

  it('all five fixture collections map to valid Collection records', () => {
    const mapped = rawCollections.map((c) => mapCollection(c, FETCHED_AT));
    expect(mapped).toHaveLength(5);
    for (const m of mapped) {
      expect(m.collection_id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.fetched_at).toBe(FETCHED_AT);
    }
  });
});

// ============================================================================
// mapInscriptionInfo — inscription_info_list → canonical Listing | null
// ============================================================================

describe('mapInscriptionInfo', () => {
  const parsed = UnisatInscriptionInfoListResponseSchema.parse(
    inscriptionInfoListFixture
  );
  const rawInscriptions = parsed.data;

  it('returns null for inscriptions where notOnSale is true', () => {
    // Our fixture inscription has notOnSale=true (the nodemonkes we looked up
    // wasn't currently listed when we fetched it).
    const raw = rawInscriptions[0]!;
    expect(raw.notOnSale).toBe(true);

    const result = mapInscriptionInfo(raw, FETCHED_AT);
    expect(result).toBeNull();
  });

  it('maps an active listing correctly when notOnSale is false', () => {
    // Synthesize an active-listing record by flipping notOnSale and populating
    // the listing-specific fields. We don't have a fixture with notOnSale=false
    // because our test inscription happened to be unlisted; this test covers
    // the populated path.
    const raw = rawInscriptions[0]!;
    const active = {
      ...raw,
      notOnSale: false,
      auctionId: 'test-auction-id',
      price: 5000000,
      onSaleTime: 1778000000000,
      address: 'bc1ptest123',
    };

    const result = mapInscriptionInfo(active, FETCHED_AT);
    expect(result).not.toBeNull();
    expect(result).toEqual({
      protocol: 'ordinal',
      asset_id: raw.inscriptionId,
      inscription_number: raw.inscriptionNumber,
      collection_id: 'nodemonkes',
      collection_name: 'NodeMonkes', // populated here, unlike auction/list
      item_name: raw.collectionItemName,
      content_type: 'image/png',
      price_sats: 5000000,
      quantity: undefined,
      source: 'unisat',
      source_url: `https://unisat.io/inscription/${raw.inscriptionId}`,
      source_listing_id: 'test-auction-id',
      seller_address: 'bc1ptest123',
      listed_at: '2026-05-05T16:53:20.000Z',
      fetched_at: FETCHED_AT,
    });
  });

  it('throws MapperError on contract violation (notOnSale=false but auctionId null)', () => {
    const raw = rawInscriptions[0]!;
    const broken = {
      ...raw,
      notOnSale: false,
      auctionId: null,
      price: 5000000,
      onSaleTime: 1778000000000,
      address: 'bc1ptest',
    };
    expect(() => mapInscriptionInfo(broken, FETCHED_AT)).toThrow(MapperError);
  });

  it('returns null for non-fixedPrice listings even when notOnSale=false', () => {
    const raw = rawInscriptions[0]!;
    const auctionStyle = {
      ...raw,
      notOnSale: false,
      auctionId: 'a',
      price: 1,
      onSaleTime: 1778000000000,
      address: 'bc1ptest',
      marketType: 'auction',
    };
    expect(mapInscriptionInfo(auctionStyle, FETCHED_AT)).toBeNull();
  });

  it('populates collection_name (unlike mapListing which gets null)', () => {
    // This is the differentiator: inscription_info_list returns collectionName,
    // auction/list does not. Adapter callers can rely on this difference.
    const raw = rawInscriptions[0]!;
    const active = {
      ...raw,
      notOnSale: false,
      auctionId: 'a',
      price: 1,
      onSaleTime: 1778000000000,
      address: 'bc1ptest',
    };
    const result = mapInscriptionInfo(active, FETCHED_AT)!;
    expect(result.collection_name).toBe('NodeMonkes');
  });
});

// ============================================================================
// Cross-cutting: msToIso error path
// ============================================================================

describe('timestamp conversion error handling', () => {
  it('throws MapperError on negative ms timestamp in mapListing', () => {
    const parsed = UnisatAuctionListResponseSchema.parse(auctionListFixture);
    const raw = { ...parsed.data.list[0]!, onSaleTime: -1 };
    expect(() => mapListing(raw, FETCHED_AT)).toThrow(MapperError);
  });

  it('throws MapperError on non-finite ms timestamp in mapAction', () => {
    const parsed = UnisatAuctionActionsResponseSchema.parse(auctionActionsFixture);
    const raw = { ...parsed.data.list[0]!, timestamp: Number.POSITIVE_INFINITY };
    expect(() => mapAction(raw, FETCHED_AT)).toThrow(MapperError);
  });
});
