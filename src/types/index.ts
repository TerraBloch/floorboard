/**
 * Floorboard canonical types.
 *
 * These are the normalized shapes every adapter emits and every consumer reads.
 * The whole project's type system is downstream of this file.
 *
 * Design notes:
 * - asset_id is the universal join key. For Ordinals, asset_id === inscription_id.
 *   The field is named protocol-agnostic so Counterparty/Stamps expansion in V2
 *   doesn't require a refactor.
 * - Every adapter response is wrapped in SourcedResult so freshness and source
 *   health are first-class data, not afterthoughts. UI components must show this.
 * - Prices are sats (integers). Never floats, never BTC strings. Display layer
 *   converts.
 */

export type Source =
  | 'satflow'
  | 'unisat'
  | 'horizon'
  | 'okx'
  | 'gamma'
  | 'ordinals_wallet'
  | (string & {}); // open enum — adapters can be added without touching this file

export type Protocol = 'ordinal' | 'counterparty' | 'stamp';

// V1 only emits 'ordinal'. The enum exists so V2 expansion is type-safe, not a refactor.

export interface Listing {
  // Universal join keys — same across every venue
  protocol: Protocol;
  asset_id: string; // inscription_id for ordinals; asset_name for XCP/Stamps in V2

  // Identity (Ordinals-specific where applicable)
  inscription_number?: number;
  collection_id?: string | null; // canonical Floorboard slug, see collection_id_map.ts
  collection_name?: string | null;
  item_name?: string | null;
  content_type?: string | null;

  // Price — always in sats, never floats
  price_sats: number;
  unit_price_sats?: number; // for divisible/fungible (BRC-20, Runes, multi-quantity)
  quantity?: number;

  // Source attribution — non-negotiable, every listing knows where it came from
  source: Source;
  source_url: string; // direct deep link back to the listing on the source venue
  source_listing_id: string; // venue-internal ID, used for refresh and dedup

  // Lifecycle
  seller_address: string;
  listed_at: string; // ISO 8601
  expires_at?: string | null;

  // Freshness — when Floorboard last verified this listing was live
  fetched_at: string; // ISO 8601

  // Optional: raw PSBT for verification or debugging. Not exposed via public API by default.
  raw_psbt?: string;
}

export interface Sale {
  protocol: Protocol;
  asset_id: string;

  inscription_number?: number;
  collection_id?: string | null;
  collection_name?: string | null;
  item_name?: string | null;

  price_sats: number;
  unit_price_sats?: number;
  quantity?: number;

  source: Source;
  source_sale_id: string;

  seller_address: string;
  buyer_address: string;
  txid: string;
  sold_at: string; // ISO 8601

  fetched_at: string;
}

export interface Collection {
  // Floorboard's canonical slug. May differ from any single venue's ID.
  // The collection_id_map handles venue-specific ID translation.
  collection_id: string;
  name: string;
  description?: string | null;
  icon_url?: string | null;
  twitter?: string | null;
  discord?: string | null;
  website?: string | null;

  // Aggregate stats — these are consensus/best-effort across venues
  floor_price_sats?: number | null;
  total_listed?: number | null;
  total_supply?: number | null;
  market_cap_sats?: number | null;

  // Time-windowed metrics. Optional because not every adapter exposes these.
  volume_24h_sats?: number | null;
  volume_7d_sats?: number | null;
  volume_30d_sats?: number | null;
  sales_24h?: number | null;
  sales_7d?: number | null;
  sales_30d?: number | null;

  fetched_at: string;
}

/**
 * The aggregated view consumers actually see. Cross-venue dedup happens here.
 * best_listing is the cheapest active listing across all venues.
 */
export interface AggregatedAsset {
  protocol: Protocol;
  asset_id: string;

  // Inscription/asset metadata (from Hiro in V1, self-hosted ord in V2)
  metadata: AssetMetadata;
  collection: Collection | null;

  // Cross-venue rollup
  best_listing: Listing | null; // null if not currently listed anywhere
  all_listings: Listing[]; // every active listing across venues, sorted by price asc
  last_sale: Sale | null;
}

export interface AssetMetadata {
  inscription_number?: number;
  content_type: string;
  content_url: string; // CDN or rendered URL
  attributes?: Record<string, string | number> | null;
  sat_number?: number; // for ordinals only
  sat_rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
}

/**
 * Event feed shape — listing/cancellation/sale activity normalized across venues.
 * Powers the global sales firehose and per-collection activity views.
 */
export type EventKind = 'listed' | 'cancelled' | 'sold' | 'updated';

export interface VenueEvent {
  kind: EventKind;
  protocol: Protocol;
  asset_id: string;

  inscription_number?: number;
  collection_id?: string | null;
  collection_name?: string | null;
  item_name?: string | null;

  price_sats?: number;
  unit_price_sats?: number;

  from_address?: string; // seller for listed/sold/cancelled
  to_address?: string; // buyer for sold

  source: Source;
  source_event_id: string;
  txid?: string; // present for 'sold'

  occurred_at: string; // ISO 8601
  fetched_at: string;
}

/**
 * Source health is a first-class value. Every adapter response carries it.
 * UI components must surface 'degraded' and 'unavailable' states visibly.
 */
export type SourceHealth = 'ok' | 'degraded' | 'unavailable';

export interface SourceStatus {
  source: Source;
  health: SourceHealth;
  last_success_at?: string;
  message?: string; // human-readable context for non-ok states
}

/**
 * Every adapter method returns one of these. The data may be partial or
 * stale — fetched_at and source_status tell the consumer what they're looking at.
 */
export interface SourcedResult<T> {
  data: T;
  source: Source;
  fetched_at: string;
  source_status: SourceStatus;
}

/**
 * Pagination is opaque cursors. Adapters encode their own pagination state
 * in the cursor string; consumers just round-trip it. Different venues use
 * page numbers, timestamps, item IDs — none of that leaks into the type.
 */
export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
  has_more: boolean;
}
