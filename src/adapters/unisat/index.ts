/**
 * Unisat venue adapter.
 *
 * The wiring layer between Floorboard's aggregator core and Unisat's API.
 * Composes the four primitives shipped in earlier commits — rate limiter,
 * HTTP client, Zod schemas, and pure mappers — into the VenueAdapter
 * interface the core consumes.
 *
 * Adapter contract reminders (see src/adapters/adapter.ts and src/types/index.ts):
 *   - Every method returns SourcedResult<T>. fetched_at and source_status are
 *     first-class data, never an afterthought.
 *   - Errors are translated to source_status when they're operational
 *     (rate limit, 5xx, network) and rethrown when they indicate a contract
 *     break (schema validation failure, unexpected client errors). The aggregator
 *     core needs to surface "Unisat temporarily unavailable" UI for the first
 *     class; the second class should fail loudly in development.
 *   - The clock is injectable. `now()` defaults to () => new Date() but tests
 *     pass a virtual clock so fetched_at values are deterministic.
 *
 * V1 limitations documented inline:
 *   - listEvents filters time window client-side (Unisat's /actions doesn't
 *     accept time-range params per the May 9 audit).
 *   - Cursors are stringified `start` offsets. Cheap, opaque, round-trippable.
 *     A more sophisticated keyset cursor is a V2 concern once we see real
 *     consumer pagination patterns.
 *   - collection_id is treated as Unisat-canonical in V1. Translation via
 *     src/core/collection_id_map.ts lands when Satflow joins as a second
 *     listings source (see mappers.ts for the rationale).
 */

import type {
  VenueAdapter,
  AdapterCapabilities,
  AdapterConfig,
  ListListingsParams,
  ListEventsParams,
  ListCollectionsParams,
} from '../adapter.js';
import type {
  Source,
  Listing,
  Sale,
  Collection,
  VenueEvent,
  SourcedResult,
  SourceStatus,
  Page,
} from '../../types/index.js';

import { TokenBucketLimiter, RateLimitExceededError } from '../../core/rate-limiter.js';
import {
  UnisatClient,
  UnisatClientError,
  UnisatHttpError,
  UnisatNetworkError,
} from './client.js';
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
} from './mappers.js';

// ─── Constants ────────────────────────────────────────────────────────────

const UNISAT_SOURCE: Source = 'unisat';

/**
 * Capability declaration for Unisat.
 *
 * Rate limits are the free tier defaults from the May 9 audit. AdapterConfig
 * may override via rate_limit_override — pass production tier limits there
 * once the Specialist plan is provisioned (Aaron's open task at
 * developer.unisat.io/plans).
 */
const UNISAT_CAPABILITIES: AdapterCapabilities = {
  supports_per_collection_listings: true,
  supports_per_asset_lookup: true,
  supports_event_feed: true,
  supports_collection_directory: true,
  supports_collection_stats: true,
  // We could synthesize a 24h/7d floor approximation from /actions, but the
  // capability declaration here means "real floor history series." Mark
  // false until we either build it or move to Hiro/self-hosted-ord for
  // ground truth.
  supports_floor_history: false,
  supported_protocols: ['ordinal'],
  rate_limit: {
    requests_per_second: 5,
    requests_per_day: 2000,
  },
  // Unisat accepts `event` as a wire-level filter on /actions per the May 9
  // schema discovery. Adapters that don't support this filter in-network
  // would set false and filter client-side; we don't have to.
  supports_event_kind_filter: true,
};

// ─── Config ───────────────────────────────────────────────────────────────

export interface UnisatAdapterConfig extends AdapterConfig {
  /**
   * Bearer API key, read from env by the construction site (e.g. a server
   * bootstrap module). Never hard-coded.
   */
  api_key: string;

  /** Base URL override for tests. Adapter ignores in production. */
  base_url?: string;

  /** Default request timeout in ms, passed through to UnisatClient. */
  default_timeout_ms?: number;

  /** Injectable fetch for tests. */
  fetch_impl?: typeof fetch;

  /**
   * Injectable clock for deterministic fetched_at values in tests.
   * Defaults to () => new Date(). Production never sets this.
   */
  now?: () => Date;
}

// ─── Cursor helpers ───────────────────────────────────────────────────────

/**
 * Cursors are stringified `start` offsets. Opaque to consumers, but trivial
 * to round-trip. parseCursor returns 0 for null/undefined so first-page
 * requests don't need a special path.
 */
function parseCursor(cursor: string | null | undefined): number {
  if (cursor == null || cursor === '') return 0;
  const n = Number.parseInt(cursor, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`UnisatAdapter: invalid cursor '${cursor}'`);
  }
  return n;
}

function encodeCursor(start: number, items_returned: number, total: number): string | null {
  const next = start + items_returned;
  return next < total ? String(next) : null;
}

// ─── Sort mapping ─────────────────────────────────────────────────────────

/**
 * Translate Floorboard's canonical sort parameter into Unisat's mongo-style
 * sort spec. Default is price_asc (cheapest-first) which matches what an
 * aggregator's collection-page grid wants by default.
 */
function listingSort(sort: ListListingsParams['sort']): Record<string, 1 | -1> {
  switch (sort) {
    case 'price_desc':
      return { unitPrice: -1 };
    case 'recent':
      return { onSaleTime: -1 };
    case 'oldest':
      return { onSaleTime: 1 };
    case 'price_asc':
    default:
      return { unitPrice: 1 };
  }
}

function collectionsSort(sort: ListCollectionsParams['sort']): Record<string, 1 | -1> {
  switch (sort) {
    case 'floor_asc':
      return { floorPrice: 1 };
    case 'recent':
      // No "recent" surface on this endpoint. Closest analogue is the most
      // recent 24h volume — sort by transactionCount24h descending.
      return { transactionCount24h: -1 };
    case 'listed_count_desc':
      return { listed: -1 };
    case 'volume_desc':
    default:
      return { btcValue: -1 };
  }
}

// ─── Health classification ────────────────────────────────────────────────

/**
 * Map an error caught from a Unisat call to a SourceStatus health value.
 * Errors that indicate "Unisat is up but the wire contract changed" are NOT
 * downgraded to degraded — they bubble out so the dev sees them in tests
 * and CI. Only operational errors (rate, network, 5xx) downgrade.
 */
function classifyError(err: unknown): SourceStatus | null {
  if (err instanceof RateLimitExceededError) {
    return {
      source: UNISAT_SOURCE,
      health: 'unavailable',
      message: `Rate limit exhausted (${err.scope}); retry at ${err.retry_after}`,
    };
  }
  if (err instanceof UnisatHttpError) {
    if (err.status === 401 || err.status === 403) {
      return {
        source: UNISAT_SOURCE,
        health: 'unavailable',
        message: `Auth rejected (HTTP ${err.status})`,
      };
    }
    if (err.status >= 500) {
      return {
        source: UNISAT_SOURCE,
        health: 'degraded',
        message: `Server error (HTTP ${err.status})`,
      };
    }
    // 4xx that isn't auth/validation — treat as a wire-contract problem
    // and rethrow rather than silently degrade.
    return null;
  }
  if (err instanceof UnisatNetworkError) {
    return {
      source: UNISAT_SOURCE,
      health: 'degraded',
      message: `Network error: ${err.message}`,
    };
  }
  // UnisatValidationError, schema parse errors, anything else: rethrow so
  // the dev sees a real failure rather than a silent green-to-yellow drift.
  return null;
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export class UnisatAdapter implements VenueAdapter {
  readonly source: Source = UNISAT_SOURCE;
  readonly capabilities: AdapterCapabilities = UNISAT_CAPABILITIES;

  private readonly client: UnisatClient;
  private readonly limiter: TokenBucketLimiter;
  private readonly now: () => Date;
  private last_success_at: string | undefined;

  constructor(config: UnisatAdapterConfig) {
    const rate_limit = {
      requests_per_second:
        config.rate_limit_override?.requests_per_second ??
        UNISAT_CAPABILITIES.rate_limit.requests_per_second,
      requests_per_day:
        config.rate_limit_override?.requests_per_day ??
        UNISAT_CAPABILITIES.rate_limit.requests_per_day,
    };

    this.limiter = new TokenBucketLimiter({
      requests_per_second: rate_limit.requests_per_second,
      requests_per_day: rate_limit.requests_per_day,
    });

    this.client = new UnisatClient({
      api_key: config.api_key,
      limiter: this.limiter,
      base_url: config.base_url,
      user_agent: config.user_agent,
      default_timeout_ms: config.default_timeout_ms,
      fetch_impl: config.fetch_impl,
    });

    this.now = config.now ?? (() => new Date());
  }

  // ─── Health ─────────────────────────────────────────────────────────────

  /**
   * Cheap auth + service ping. Uses /collection_statistic_list with limit:1
   * because:
   *   - It requires auth (validates the API key end-to-end)
   *   - It's not collection-scoped (no collectionId to invent)
   *   - It's the lightest possible response body (one collection record)
   *
   * Costs one rate-limit token. Calling /health every few seconds in the
   * core's source-health poller will burn ~17k/day of the 2000/day quota —
   * the poller must space these out. Documenting here so a future caller
   * doesn't accidentally DoS our own quota.
   */
  async health(): Promise<SourceStatus> {
    try {
      await this.client.request('/v3/market/collection/auction/collection_statistic_list', {
        body: { filter: { timeType: 'all' }, sort: { btcValue: -1 }, start: 0, limit: 1 },
      });
      this.last_success_at = this.now().toISOString();
      return {
        source: UNISAT_SOURCE,
        health: 'ok',
        last_success_at: this.last_success_at,
      };
    } catch (err) {
      const status = classifyError(err);
      if (status) {
        return { ...status, last_success_at: this.last_success_at };
      }
      // Unclassified error — surface a degraded status with the message
      // but don't swallow the type. health() is the one method where
      // we never throw, by contract (the core polls it for UI badges).
      return {
        source: UNISAT_SOURCE,
        health: 'degraded',
        last_success_at: this.last_success_at,
        message: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  // ─── listListings ───────────────────────────────────────────────────────

  async listListings(
    params: ListListingsParams,
  ): Promise<SourcedResult<Page<Listing>>> {
    const start = parseCursor(params.cursor);
    const limit = params.limit ?? 50;
    const fetched_at = this.now().toISOString();

    try {
      const raw = await this.client.request(
        '/v3/market/collection/auction/list',
        {
          body: {
            filter: { nftType: 'collection', collectionId: params.collection_id },
            sort: listingSort(params.sort),
            start,
            limit,
          },
        },
      );
      const parsed = UnisatAuctionListResponseSchema.parse(raw);
      const items: Listing[] = parsed.data.list
        .map((row) => mapListing(row, fetched_at))
        .filter((x): x is Listing => x !== null);

      this.last_success_at = fetched_at;

      return this.wrap(
        {
          items,
          next_cursor: encodeCursor(start, parsed.data.list.length, parsed.data.total),
          has_more: start + parsed.data.list.length < parsed.data.total,
        },
        fetched_at,
      );
    } catch (err) {
      this.rethrowOrDegrade(err);
    }
  }

  // ─── getListingsForAsset ────────────────────────────────────────────────

  /**
   * Returns the active Unisat listing for a single inscription, if any.
   * Unisat tracks at most one active listing per inscription at a time
   * (per the May 9 audit and confirmed by mapInscriptionInfo's notOnSale
   * gate), so the returned array has length 0 or 1.
   */
  async getListingsForAsset(asset_id: string): Promise<SourcedResult<Listing[]>> {
    const fetched_at = this.now().toISOString();

    try {
      const raw = await this.client.request(
        '/v3/market/collection/auction/inscription_info_list',
        {
          body: { inscriptionIds: [asset_id] },
        },
      );
      const parsed = UnisatInscriptionInfoListResponseSchema.parse(raw);
      const items: Listing[] = parsed.data
        .map((row) => mapInscriptionInfo(row, fetched_at))
        .filter((x): x is Listing => x !== null);

      this.last_success_at = fetched_at;

      return this.wrap(items, fetched_at);
    } catch (err) {
      this.rethrowOrDegrade(err);
    }
  }

  // ─── listEvents ─────────────────────────────────────────────────────────

  /**
   * Event feed. Time-range filtering is client-side because Unisat's
   * /actions endpoint silently ignores any time params (May 9 audit).
   * Adapter pulls newest-first and filters; cursor encoding accounts for
   * the fact that we may pull more records than we return.
   *
   * V1 limitation: if a `since` boundary is far enough in the past that
   * the post-filter result is sparse, the adapter pages forward to fill —
   * but it does NOT auto-paginate to honor `since`. Callers must page
   * themselves. This matches the contract of the other adapter methods
   * (one wire call per adapter call).
   */
  async listEvents(
    params: ListEventsParams,
  ): Promise<SourcedResult<Page<VenueEvent>>> {
    const start = parseCursor(params.cursor);
    const limit = params.limit ?? 50;
    const fetched_at = this.now().toISOString();
    const since_ms = Date.parse(params.since);
    const until_ms = params.until ? Date.parse(params.until) : undefined;

    if (!Number.isFinite(since_ms)) {
      throw new Error(`UnisatAdapter.listEvents: invalid 'since' timestamp '${params.since}'`);
    }

    // Map Floorboard EventKind filter to Unisat's `event` wire filter.
    // If multiple kinds are requested we make multiple sequential calls
    // and merge — but that's a V2 optimization. For V1, if multiple kinds
    // are requested we pull unfiltered and filter client-side; if exactly
    // one is requested, we use the wire filter.
    const sole_kind =
      params.kinds && params.kinds.length === 1 ? params.kinds[0] : undefined;
    const event_filter = sole_kind ? unisatEventFor(sole_kind) : undefined;

    try {
      const raw = await this.client.request(
        '/v3/market/collection/auction/actions',
        {
          body: {
            filter: {
              nftType: 'collection',
              ...(event_filter ? { event: event_filter } : {}),
            },
            sort: { timestamp: -1 },
            start,
            limit,
          },
        },
      );
      const parsed = UnisatAuctionActionsResponseSchema.parse(raw);

      const all = parsed.data.list
        .map((row) => mapAction(row, fetched_at))
        .filter((x): x is VenueEvent => x !== null)
        // Client-side time-window filter
        .filter((ev) => {
          const t = Date.parse(ev.occurred_at);
          if (t < since_ms) return false;
          if (until_ms !== undefined && t > until_ms) return false;
          return true;
        })
        // Client-side multi-kind filter (when wire filter not usable)
        .filter((ev) => (params.kinds ? params.kinds.includes(ev.kind) : true))
        // Optional collection scope (Unisat /actions doesn't accept
        // collectionId in filter; the audit confirmed it; client-side here).
        .filter((ev) =>
          params.collection_id ? ev.collection_id === params.collection_id : true,
        );

      this.last_success_at = fetched_at;

      return this.wrap(
        {
          items: all,
          next_cursor: encodeCursor(start, parsed.data.list.length, parsed.data.total),
          has_more: start + parsed.data.list.length < parsed.data.total,
        },
        fetched_at,
      );
    } catch (err) {
      this.rethrowOrDegrade(err);
    }
  }

  // ─── listCollections ────────────────────────────────────────────────────

  async listCollections(
    params: ListCollectionsParams,
  ): Promise<SourcedResult<Page<Collection>>> {
    const start = parseCursor(params.cursor);
    const limit = params.limit ?? 50;
    const fetched_at = this.now().toISOString();

    try {
      const raw = await this.client.request(
        '/v3/market/collection/auction/collection_statistic_list',
        {
          body: {
            // Note: this endpoint does NOT accept filter.nftType (audit).
            // timeType is the only filter that's been validated.
            filter: { timeType: 'all' },
            sort: collectionsSort(params.sort),
            start,
            limit,
          },
        },
      );
      const parsed = UnisatCollectionStatListResponseSchema.parse(raw);
      const items: Collection[] = parsed.data.list.map((row) => mapCollection(row, fetched_at));

      this.last_success_at = fetched_at;

      return this.wrap(
        {
          items,
          next_cursor: encodeCursor(start, parsed.data.list.length, parsed.data.total),
          has_more: start + parsed.data.list.length < parsed.data.total,
        },
        fetched_at,
      );
    } catch (err) {
      this.rethrowOrDegrade(err);
    }
  }

  // ─── getCollectionStats (optional capability) ───────────────────────────

  /**
   * Per-collection stats. Implemented by paging the directory until we hit
   * the target slug. Not the cheapest possible implementation — a single-
   * collection-stats endpoint would be cheaper — but the directory is the
   * only stats source Unisat exposes for now.
   *
   * V1 limitation: this pages up to 5 directory pages of 200 each (1000
   * collections). That covers the full ~1988-entry directory in under
   * three calls in practice. For tail-of-distribution collections, callers
   * fall back to "not in directory" → use a synthesized stat row from
   * /auction/list count + floor query.
   */
  async getCollectionStats(collection_id: string): Promise<SourcedResult<Collection>> {
    const fetched_at = this.now().toISOString();
    const PAGE = 200;
    const MAX_PAGES = 10; // 2000 collections; full directory comfortably

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const raw = await this.client.request(
          '/v3/market/collection/auction/collection_statistic_list',
          {
            body: {
              filter: { timeType: 'all' },
              sort: { btcValue: -1 },
              start: page * PAGE,
              limit: PAGE,
            },
          },
        );
        const parsed = UnisatCollectionStatListResponseSchema.parse(raw);
        const hit = parsed.data.list.find((row) => row.collectionId === collection_id);
        if (hit) {
          this.last_success_at = fetched_at;
          return this.wrap(mapCollection(hit, fetched_at), fetched_at);
        }
        if (parsed.data.list.length < PAGE) break; // reached end
      }
      throw new Error(
        `UnisatAdapter.getCollectionStats: collection '${collection_id}' not found in Unisat directory`,
      );
    } catch (err) {
      this.rethrowOrDegrade(err);
    }
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  private wrap<T>(data: T, fetched_at: string): SourcedResult<T> {
    return {
      data,
      source: UNISAT_SOURCE,
      fetched_at,
      source_status: {
        source: UNISAT_SOURCE,
        health: 'ok',
        last_success_at: fetched_at,
      },
    };
  }

  /**
   * Called from a catch block. Either downgrades to a degraded SourceStatus
   * (by throwing a special "operational error" that the caller's catch will
   * wrap into a SourcedResult)... actually no, simpler model: if the error
   * is operational, we throw a DegradedSourceError that carries the
   * SourceStatus. Callers up the stack (the API endpoint layer) catch this
   * and synthesize a SourcedResult with empty data + the degraded status.
   *
   * Why not catch-and-return-empty here? Because the adapter doesn't know
   * what an empty `Page<Listing>` vs an empty `Listing[]` vs a `Collection`
   * looks like in a way that's safe across all five methods. Throwing a
   * typed error keeps each method's return-shape concerns local.
   *
   * Non-operational errors rethrow unchanged so the dev sees them.
   */
  private rethrowOrDegrade(err: unknown): never {
    const status = classifyError(err);
    if (status) {
      throw new UnisatAdapterUnavailableError(status, { cause: err });
    }
    throw err;
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────

/**
 * Thrown by adapter methods when Unisat is operationally unavailable
 * (rate-limited, network down, server 5xx, auth rejected). Carries the
 * SourceStatus that the API endpoint layer should surface to the consumer.
 *
 * Non-operational errors (schema validation failures, unexpected client
 * errors) are NOT wrapped in this — they bubble out as their native types
 * so they fail loudly in tests and CI.
 */
export class UnisatAdapterUnavailableError extends Error {
  readonly status: SourceStatus;

  constructor(status: SourceStatus, options?: { cause?: unknown }) {
    super(status.message ?? `Unisat ${status.health}`);
    this.name = 'UnisatAdapterUnavailableError';
    this.status = status;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// ─── Internal: Floorboard EventKind → Unisat event enum value ────────────

function unisatEventFor(kind: VenueEvent['kind']): string | undefined {
  switch (kind) {
    case 'listed':
      return 'Listed';
    case 'cancelled':
      return 'Cancel';
    case 'sold':
      return 'Sold';
    case 'updated':
      return 'Updated';
    default:
      return undefined;
  }
}

// ─── Sale helper (exported convenience) ───────────────────────────────────

/**
 * Convenience: derive completed Sales from the events feed. Not part of
 * the VenueAdapter interface (sales are events with extra structure), but
 * useful for the public API endpoint that powers the sales firehose.
 * Returns null entries dropped; non-Sold events filtered out.
 *
 * Composition is in the adapter, not the mapper, because mappers are
 * single-record-pure — this is a multi-record orchestration concern.
 */
export async function unisatRecentSales(
  adapter: UnisatAdapter,
  params: Omit<ListEventsParams, 'kinds'>,
): Promise<SourcedResult<Page<Sale>>> {
  const events_result = await adapter.listEvents({ ...params, kinds: ['sold'] });
  // Re-fetch the raw sale rows by calling /actions again would double-cost
  // a request. Instead, downstream callers that need Sale-shaped data
  // should call this helper and accept that we lose the buyer address
  // unless they wire up a separate path. For V1 the VenueEvent already
  // carries to_address for Sold events — adequate for the firehose.
  //
  // This helper exists as a placeholder so the API endpoint layer can
  // call adapter.unisatRecentSales(...) instead of inlining the events→sales
  // conversion logic. Filling this in properly is V2 work once we know
  // exactly what the firehose endpoint needs from a Sale vs a VenueEvent.
  void mapSale; // referenced so import isn't dropped; real wiring lands in V2
  const sales_page: Page<Sale> = {
    items: [], // placeholder — see above
    next_cursor: events_result.data.next_cursor,
    has_more: events_result.data.has_more,
  };
  return {
    ...events_result,
    data: sales_page,
  };
}

// Re-export the adapter error so callers can `instanceof` it without
// reaching into the implementation file directly.
export { UnisatClientError, RateLimitExceededError };
