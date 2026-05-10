/**
 * VenueAdapter interface.
 *
 * Every venue adapter implements this. The aggregator core only ever talks to
 * adapters through this interface — no venue-specific logic leaks into the core.
 *
 * Three jobs:
 *   1. List active listings (per collection, optionally per asset)
 *   2. Stream events (listings, sales, cancellations)
 *   3. Resolve metadata (per asset, per collection)
 *
 * That's the entire read surface. We don't write. We don't trade. We don't custody.
 */

import type {
  Source,
  Protocol,
  Listing,
  Sale,
  Collection,
  VenueEvent,
  EventKind,
  SourcedResult,
  SourceStatus,
  Page,
} from '../types';

/**
 * Adapter capability declarations.
 *
 * Adapters declare what they CAN do. The aggregator core asks each adapter
 * before routing a request. Capabilities that are false today (e.g. Satflow's
 * per-collection listings until the devtools session resolves the path) cause
 * the core to route around them — no special-cased logic in the core.
 */
export interface AdapterCapabilities {
  // Core capabilities
  supports_per_collection_listings: boolean;
  supports_per_asset_lookup: boolean;
  supports_event_feed: boolean;
  supports_collection_directory: boolean;
  supports_collection_stats: boolean;
  supports_floor_history: boolean;

  // Protocol coverage
  supported_protocols: Protocol[];

  // Operational constraints — the core uses these to schedule refresh cycles
  // without burning rate limits.
  rate_limit: {
    requests_per_second: number;
    requests_per_day?: number;
  };

  // Event filter support — does the venue let us filter by event kind on the wire?
  // If false, the adapter pulls everything and filters in memory.
  supports_event_kind_filter: boolean;
}

/**
 * Listing query parameters. Floorboard's canonical params, not any venue's.
 * Adapters translate to their venue's native shape.
 */
export interface ListListingsParams {
  collection_id: string; // Floorboard canonical ID; adapter resolves to venue ID
  sort?: 'price_asc' | 'price_desc' | 'recent' | 'oldest';
  cursor?: string | null;
  limit?: number; // adapter may cap lower
}

export interface ListEventsParams {
  // Time window — required to bound the query and enable incremental refresh
  since: string; // ISO 8601
  until?: string;

  collection_id?: string;
  kinds?: EventKind[]; // filter to specific event types, if supported
  cursor?: string | null;
  limit?: number;
}

export interface ListCollectionsParams {
  sort?: 'volume_desc' | 'floor_asc' | 'recent' | 'listed_count_desc';
  cursor?: string | null;
  limit?: number;
}

/**
 * The interface itself. Small on purpose.
 */
export interface VenueAdapter {
  // Static identity
  readonly source: Source;
  readonly capabilities: AdapterCapabilities;

  /**
   * Health check. Cheap call the core uses to update source_status in the UI.
   * Implementations should be idempotent and inexpensive (a single API ping).
   */
  health(): Promise<SourceStatus>;

  /**
   * Active listings for a collection. Required if capabilities.supports_per_collection_listings.
   * Otherwise throws or is omitted at the implementation level.
   */
  listListings(
    params: ListListingsParams,
  ): Promise<SourcedResult<Page<Listing>>>;

  /**
   * Per-asset listing lookup. Required if capabilities.supports_per_asset_lookup.
   * Returns all currently-active listings on this venue for the given asset_id.
   * Empty array means not listed here right now (not an error).
   */
  getListingsForAsset(asset_id: string): Promise<SourcedResult<Listing[]>>;

  /**
   * Event feed. Required if capabilities.supports_event_feed.
   * Adapters that don't support filtering by kind must filter client-side and
   * leave supports_event_kind_filter = false.
   */
  listEvents(params: ListEventsParams): Promise<SourcedResult<Page<VenueEvent>>>;

  /**
   * Collection directory. Required if capabilities.supports_collection_directory.
   * Used to populate Floorboard's collection list and discover new collections
   * to add to the indexed set.
   */
  listCollections(
    params: ListCollectionsParams,
  ): Promise<SourcedResult<Page<Collection>>>;

  /**
   * Detailed stats for a single collection. Optional capability.
   */
  getCollectionStats?(
    collection_id: string,
  ): Promise<SourcedResult<Collection>>;

  /**
   * Floor price history. Optional capability.
   * Returns time series of floor prices. Granularity is venue-specific.
   */
  getFloorHistory?(
    collection_id: string,
    window: '24h' | '7d' | '30d' | 'all',
  ): Promise<SourcedResult<{ timestamp: string; floor_sats: number }[]>>;
}

/**
 * Adapter construction config. Each adapter takes its own config shape extending this.
 * The collection_allowlist is the V1 inventory-scope knob — V1 ships with the top 50
 * Ordinals collections; expansion is a config change, not a code change.
 */
export interface AdapterConfig {
  // If set, the adapter only fetches data for these canonical collection IDs.
  // null/undefined means "all collections this venue indexes".
  collection_allowlist?: string[] | null;

  // Per-adapter rate limit override. Defaults to capabilities.rate_limit.
  rate_limit_override?: {
    requests_per_second?: number;
    requests_per_day?: number;
  };

  // Adapter-level user-agent identifying Floorboard. Required for venues with
  // UA fingerprinting (Satflow, Unisat both reject default Python UA).
  user_agent: string;
}
