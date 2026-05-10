# Floorboard

Open-data aggregation layer for Bitcoin Ordinals listings.

One place to see every active listing across every major venue, normalized,
deduplicated, sorted by best price. One click out to the source venue to
complete the purchase.

Floorboard is **not a marketplace.** It never custodies assets, never brokers
trades, never touches a buyer's money. Routing-only, by design and by code.

## Status

Pre-build. Audits complete for Satflow, Unisat, Horizon. V1 target: top ~50
Ordinals collections, Satflow + Unisat as the V1 venues.

## Structure

```
src/
  types/        Canonical types (Listing, Sale, Collection, etc.)
  adapters/     One folder per venue. Implements VenueAdapter.
  core/         Normalization, dedup, scheduling, source health
  api/          Public API surface (/v1/...)
```

## Build order

1. `src/types` — canonical shapes (done)
2. `src/adapters/adapter.ts` — VenueAdapter interface (done)
3. `src/adapters/unisat` — primary listings backbone
4. `src/adapters/satflow` — discovery + sales feed
5. `src/core` — dedup, source health, refresh scheduling
6. `src/api` — public API endpoints
7. Frontend pages, consuming the public API

## Stack

TypeScript, Next.js 14, Postgres, Redis, single VPS for V1. Hiro for
inscription metadata in V1 → self-hosted ord in V2.

## License

MIT.
