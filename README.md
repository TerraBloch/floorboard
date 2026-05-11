# Floorboard

A self-hosted aggregator for Bitcoin Ordinals listings.

Floorboard normalizes listings, sales, and events across Ordinals venues
behind a single read-only API. One canonical schema, one set of endpoints,
one source-health model. Bring your own Unisat API key, run it locally or
on your own host, and use it however you like.

Floorboard is **not a marketplace.** It never custodies assets, never
brokers trades, never touches a buyer's money. Discovery and routing only,
by design and by code.

## Why self-hosted

Floorboard talks to upstream venues that meter their APIs. A shared public
deployment would put one rate-limit budget between everyone using it, with
the maintainer on the hook for the bill and the failure mode. Self-hosting
gives each operator their own budget, their own keys, their own uptime
expectations, and removes any single point of contention with upstreams.

The project is open source so that running your own copy is the easy path,
not the hard one.

## Status

V1 in progress. Unisat adapter complete with 97 tests; v1 API endpoints
over Unisat are live with 47 tests covering happy paths, parameter
validation, and the degraded-source contract. Total: 144 tests.

Audits complete for Satflow, Unisat, Horizon. V1 target: top Ordinals
collections, Satflow + Unisat as the V1 venues. Next adapter: Hiro
(inscription metadata) or Satflow (multi-source dedup).

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
empty `data` and a non-`ok` `source_status.health` — callers always get a
parseable envelope; UI surfaces health from `source_status`. Schema or
contract errors return HTTP 500. Invalid params return HTTP 400. Missing
resources return HTTP 404.

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

## Running your own

You'll need a Unisat API key (free tier, from
[developer.unisat.io](https://developer.unisat.io)). Each operator uses
their own key; Floorboard never embeds one.

```sh
git clone https://github.com/TerraBloch/floorboard.git
cd floorboard
cp .env.example .env.local           # add your UNISAT_API_KEY
npm install
npm run dev                           # → http://localhost:3000

curl http://localhost:3000/v1/health
```

Verifying a clean install:

```sh
npx vitest run                        # 144 tests
npx tsc --noEmit                      # strict tsc
npx next build                        # production build
```

### Notes on rate limits

Unisat's free tier is 5 req/sec and 2,000 req/day. The adapter enforces
the per-second limit internally via a token bucket; the daily limit is
the operator's to manage. For low-traffic personal use against a handful
of collections the free tier is comfortable. If you plan to refresh the
top ~50 collections on a tight cadence, look at Unisat's Specialist tier
or add a caching layer in front of the adapter.

## Structure

```
src/
  types/        Canonical types (Listing, Sale, Collection, etc.)
  adapters/     One folder per venue. Implements VenueAdapter.
  core/         Rate limiting, source health, future dedup
  lib/          Shared API helpers (response envelope, error translation)
  app/          Next.js App Router. /api/v1/* are the API endpoints.
```

## Stack

TypeScript, Next.js 14 App Router, Zod, Vitest. The adapter layer has no
database or cache dependencies in V1 — every endpoint is a thin pass-through
to the upstream venue. Operators are free to add their own caching,
storage, or scheduling on top.

## Contributing

Floorboard is open source and contributions are welcome, but support and
direction are best effort. Good targets: adapter fixes, bug fixes, tests,
docs, small API improvements consistent with the current model. Larger
proposals (new venues, scope expansions, trading or wallet features) are
likely to be declined — Floorboard is intentionally narrow.

## License

MIT.
