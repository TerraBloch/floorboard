/**
 * /v1/assets/:id/listings route handler tests.
 *
 * Covers: empty array when the inscription is notOnSale (fixture case),
 * adapter receives the exact asset_id, asset_id validation (400 paths),
 * and the degraded-source 200 contract.
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

import inscriptionInfoListFixture from '@/adapters/unisat/__fixtures__/inscription_info_list.json' with { type: 'json' };

// A real-shaped inscription id (64 hex chars + 'i' + index). The fixture's
// matching inscription has notOnSale=true so getListingsForAsset returns []
// for the happy "not currently listed" path.
const ASSET_ID = 'dba88ce96eeb3eb93c4602ccb986880b43c9dd1de21cdda9d2ca24ee79f89bb9i0';

describe('GET /v1/assets/:id/listings', () => {
  beforeEach(() => resetAdapter());
  afterEach(() => resetAdapter());

  it('returns empty array when inscription is not currently listed', async () => {
    installAdapter(makeMockFetch([{ status: 200, body: inscriptionInfoListFixture }]));

    const res = await GET(
      makeRequest(`/v1/assets/${ASSET_ID}/listings`),
      { params: { id: ASSET_ID } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('unisat');
    expect(body.fetched_at).toBe(FIXED_NOW);
    expect(body.source_status.health).toBe('ok');
    expect(body.data).toEqual([]);
  });

  it('passes the asset_id through to the adapter', async () => {
    const fetch_mock = makeMockFetch([
      { status: 200, body: inscriptionInfoListFixture },
    ]);
    installAdapter(fetch_mock);

    await GET(
      makeRequest(`/v1/assets/${ASSET_ID}/listings`),
      { params: { id: ASSET_ID } },
    );
    const sent = bodyOf(fetch_mock.calls[0]!.init);
    expect(sent.inscriptionIds).toEqual([ASSET_ID]);
  });

  it('rejects malformed asset_id (no "i" separator) with 400', async () => {
    installAdapter(makeMockFetch([]));

    const bad = 'a'.repeat(64) + '0'; // missing 'i'
    const res = await GET(
      makeRequest(`/v1/assets/${bad}/listings`),
      { params: { id: bad } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
    expect(body.details[0].path).toBe('');
  });

  it('rejects asset_id with non-hex characters with 400', async () => {
    installAdapter(makeMockFetch([]));

    const bad = 'z'.repeat(64) + 'i0';
    const res = await GET(
      makeRequest(`/v1/assets/${bad}/listings`),
      { params: { id: bad } },
    );
    expect(res.status).toBe(400);
  });

  it('rejects asset_id with wrong hex length with 400', async () => {
    installAdapter(makeMockFetch([]));

    const bad = 'a'.repeat(32) + 'i0'; // only 32 hex chars
    const res = await GET(
      makeRequest(`/v1/assets/${bad}/listings`),
      { params: { id: bad } },
    );
    expect(res.status).toBe(400);
  });

  it('rejects empty asset_id with 400', async () => {
    installAdapter(makeMockFetch([]));

    const res = await GET(
      makeRequest('/v1/assets//listings'),
      { params: { id: '' } },
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 + degraded SourcedResult on 503', async () => {
    installAdapter(makeMockFetch([{ status: 503, body: { error: 'down' } }]));

    const res = await GET(
      makeRequest(`/v1/assets/${ASSET_ID}/listings`),
      { params: { id: ASSET_ID } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_status.health).toBe('degraded');
    expect(body.data).toEqual([]);
  });

  it('returns 200 + unavailable SourcedResult on 401', async () => {
    installAdapter(makeMockFetch([{ status: 401, body: { error: 'no auth' } }]));

    const res = await GET(
      makeRequest(`/v1/assets/${ASSET_ID}/listings`),
      { params: { id: ASSET_ID } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_status.health).toBe('unavailable');
    expect(body.data).toEqual([]);
  });
});
