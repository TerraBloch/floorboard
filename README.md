# Floorboard

Open-data aggregation layer for Bitcoin Ordinals listings.

One place to see every active listing across every major venue, normalized,
deduplicated, sorted by best price. One click out to the source venue to
complete the purchase.

Floorboard is **not a marketplace.** It never custodies assets, never brokers
trades, never touches a buyer's money. Routing-only, by design and by code.

## Status

V1 in progress. Unisat adapter complete with 97 tests; public v1 API
endpoints over Unisat are live with 47 tests covering happy paths,
parameter validation, and the degraded-source contract. Total: 144 tests.

Audits complete for Satflow, Unisat, Horizon. V1 target: top ~50
Ordinals collections, Satflow + Unisat as the V1 venues. Next adapter:
Hiro (inscription metadata) or Satflow (multi-source dedup).

## API

All endpoints return a `SourcedResult<T>` envelope:

```json
{
  "data": "...",
  "source": "unisat",
  "fetched_at": "ISO 8601",
  "source_status": { "source": "unisat", "health": "ok|degraded|unavailable" }
}
```

Operational failures (rate limit, network, 5xx, auth) return HTTP 200 with
empty `data` and a non-`ok` `source_status.health`. Schema/contract errors
return HTTP 500. Invalid params return HTTP 400. Missing resources return
HTTP 404.

| Endpoint | Description |
| --- | --- |
| `GET /v1/health` | Source health probe |
| `GET /v1/collections` | Collection directory |
| `GET /v1/collections/:slug` | Single collection stats |
| `GET /v1/collections/:slug/listings` | Active listings for a collection |
| `GET /v1/assets/:id/listings` | Listings for one inscription |
| `GET /v1/events` | Event feed (listings, sales, cancellations) |

Common query params: `sort`, `cursor`, `limit` (1–100, default 50).
`/v1/events` additionally requires `since` and accepts `until`, `kinds`,
`collection_id`.

## Structure

```
src/
  types/        Canonical types (Listing, Sale, Collection, etc.)
  adapters/     One folder per venue. Implements VenueAdapter.
  core/         Normalization, dedup, scheduling, source health
  lib/          Shared API helpers (response envelope, error translation)
  app/          Next.js App Router. /api/v1/* are the public endpoints.
```

## Build order

1. `src/types` — canonical shapes (done)
2. `src/adapters/adapter.ts` — VenueAdapter interface (done)
3. `src/adapters/unisat` — primary listings backbone (done)
4. `src/app/api/v1` — public API endpoints over Unisat (done)
5. `src/adapters/hiro` OR `src/adapters/satflow` — next session
6. `src/core` — dedup, source health, refresh scheduling
7. Frontend pages, consuming the public API

## Run locally

```sh
cp .env.example .env.local       # add UNISAT_API_KEY
npm install
npm run dev                       # → http://localhost:3000
npx vitest run                    # one-shot test run (or `npm test` for watch)
npm run typecheck                 # strict tsc
```

## Stack

TypeScript, Next.js 14, Postgres, Redis, single VPS for V1. Hiro for
inscription metadata in V1 → self-hosted ord in V2.

## License

MIT.
