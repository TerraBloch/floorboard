/**
 * Unisat → Floorboard canonical type mappers.
 *
 * Pure functions. No I/O, no Date.now(), no module-level state. The adapter
 * layer above passes `fetched_at` in so mappers stay deterministic and testable.
 *
 * Return-type convention:
 * - `null` means "valid Unisat data, but not a canonical Floorboard concept"
 *   (e.g. Claim events, auction-style listings, notOnSale=true inscriptions).
 *   Adapter callers filter nulls before returning.
 * - Throws (`MapperError`) means "this data is malformed in a way that
 *   shouldn't happen if schemas validated upstream." Indicates a Unisat
 *   contract change or schema gap; should surface loudly, not silently drop.
 *
 * collection_id translation:
 * - V1 uses Unisat collectionId as the canonical Floorboard collection_id.
 *   This works because Unisat is the V1 listings backbone (the
 *   authoritative source for active listings). When Satflow joins,
 *   src/core/collection_id_map.ts will translate Satflow slugs into Unisat
 *   IDs — Unisat IDs remain canonical, Satflow becomes a translated source.
 *   This deferral is documented in FLOORBOARD_HANDOFF.md.
 */

import type {
  Listing,
  Sale,
  Collection,
  VenueEvent,
  EventKind,
} from '../../types/index.js';
import type {
  UnisatListing,
  UnisatAction,
  UnisatCollectionStat,
  UnisatInscriptionInfo,
} from './schemas.js';

// ---------- Errors ----------

export class MapperError extends Error {
  public readonly source_record: unknown;
  public readonly reason: string;

  constructor(reason: string, source_record: unknown) {
    super(`Unisat mapper: ${reason}`);
    this.name = 'MapperError';
    this.source_record = source_record;
    this.reason = reason;
  }
}

// ---------- Constants ----------

const SOURCE = 'unisat' as const;
const UNISAT_BASE_URL = 'https://unisat.io';

/**
 * Unisat's deep-link pattern for individual inscriptions.
 * Confirmed empirically May 10: clicking any listing card on a collection
 * page routes to /inscription/{inscriptionId}. Same URL renders whether
 * the inscription is currently listed or not.
 *
 * Audit doc had proposed /market/collection/auction/{auctionId} — that 404s.
 */
function buildSourceUrl(inscriptionId: string): string {
  return `${UNISAT_BASE_URL}/inscription/${inscriptionId}`;
}

/**
 * ms epoch → ISO 8601 UTC string. Throws on non-finite or negative input.
 * All Unisat timestamps in our fixtures are ms-precision UTC.
 */
function msToIso(ms: number, source_record: unknown): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new MapperError(`invalid ms timestamp: ${ms}`, source_record);
  }
  return new Date(ms).toISOString();
}

// ---------- Listing mapper ----------

/**
 * Maps a Unisat auction/list record to canonical Listing.
 *
 * Returns null when the listing is not a fixedPrice listing (auction-style
 * listings are out of V1 scope — they have different lifecycle semantics
 * and the canonical Listing type assumes a single immediate-purchase price).
 *
 * Field mapping:
 *   address              → seller_address
 *   onSaleTime (ms)      → listed_at (ISO 8601)
 *   collectionId         → collection_id (canonical V1: Unisat ID is canonical)
 *   inscriptionId        → asset_id (V1 only emits 'ordinal' protocol)
 *   auctionId            → source_listing_id
 *   inscriptionId        → deep link in source_url
 *
 * Dropped:
 *   attrs[]              — per-trait floor data, no canonical home in V1.
 *                          Revisit on AggregatedAsset.metadata in V2.
 *   collectionHighResImgUrl — only populated for some queries; image URLs
 *                          come from Hiro adapter in canonical AssetMetadata.
 *   nftType, marketType  — gating fields, not data fields.
 *   domain*              — only meaningful when nftType=domain (out of V1 scope).
 */
export function mapListing(
  raw: UnisatListing,
  fetched_at: string
): Listing | null {
  if (raw.marketType !== 'fixedPrice') {
    // Auction-style listing — no canonical Listing equivalent in V1.
    return null;
  }

  return {
    protocol: 'ordinal',
    asset_id: raw.inscriptionId,
    inscription_number: raw.inscriptionNumber,
    collection_id: raw.collectionId,
    collection_name: null, // auction/list doesn't include collectionName; enriched downstream
    item_name: raw.collectionItemName,
    content_type: raw.contentType,
    price_sats: raw.price,
    unit_price_sats: raw.unitPrice ?? undefined,
    quantity: raw.amount ?? undefined,
    source: SOURCE,
    source_url: buildSourceUrl(raw.inscriptionId),
    source_listing_id: raw.auctionId,
    seller_address: raw.address,
    listed_at: msToIso(raw.onSaleTime, raw),
    fetched_at,
  };
}

// ---------- Event mapper ----------

/**
 * Maps a Unisat event-feed enum to canonical EventKind.
 * Returns null for 'Claim' — auction settlement events have no V1 equivalent.
 */
function mapEventKind(event: UnisatAction['event']): EventKind | null {
  switch (event) {
    case 'Listed':
      return 'listed';
    case 'Cancel':
      return 'cancelled';
    case 'Sold':
      return 'sold';
    case 'Updated':
      return 'updated';
    case 'Claim':
      return null;
  }
}

/**
 * Maps a Unisat auction/actions record to canonical VenueEvent.
 *
 * Returns null for Claim events (auction-style, out of V1 scope).
 *
 * Field mapping:
 *   event           → kind (Listed→listed, Cancel→cancelled, Sold→sold,
 *                     Updated→updated; Claim returns null)
 *   inscriptionId   → asset_id
 *   timestamp (ms)  → occurred_at (ISO 8601)
 *   from            → from_address
 *   to              → to_address (only meaningful on Sold events)
 *   txid            → txid (kept on all event kinds — fidelity > strict typing)
 *   auctionId       → source_event_id
 *
 * Dropped:
 *   attributes[], dbTag, newest, channel, height, sellTxid, sellIndex,
 *   collectionHighResImgUrl, contentBody, name, endMsg — internal Unisat
 *   fields not part of the public canonical contract.
 */
export function mapAction(
  raw: UnisatAction,
  fetched_at: string
): VenueEvent | null {
  const kind = mapEventKind(raw.event);
  if (kind === null) return null;

  return {
    kind,
    protocol: 'ordinal',
    asset_id: raw.inscriptionId,
    inscription_number: raw.inscriptionNumber,
    collection_id: raw.collectionId,
    collection_name: null, // events don't carry collectionName; enriched downstream
    item_name: raw.collectionItemName,
    price_sats: raw.price,
    unit_price_sats: raw.unitPrice ?? undefined,
    from_address: raw.from ?? undefined,
    to_address: raw.to ?? undefined,
    source: SOURCE,
    source_event_id: raw.auctionId,
    txid: raw.txid,
    occurred_at: msToIso(raw.timestamp, raw),
    fetched_at,
  };
}

/**
 * Maps a Sold event specifically to a canonical Sale record.
 * Used by the sales-feed code path; the event mapper is for the full event
 * stream (which includes non-sale events).
 *
 * Returns null if the input is not a Sold event, or if required Sold-only
 * fields (from, to) are missing — which would indicate Unisat data corruption.
 */
export function mapSale(
  raw: UnisatAction,
  fetched_at: string
): Sale | null {
  if (raw.event !== 'Sold') return null;

  if (raw.from === null || raw.to === null) {
    throw new MapperError(
      `Sold event missing from/to addresses (auctionId=${raw.auctionId})`,
      raw
    );
  }

  return {
    protocol: 'ordinal',
    asset_id: raw.inscriptionId,
    inscription_number: raw.inscriptionNumber,
    collection_id: raw.collectionId,
    collection_name: null,
    item_name: raw.collectionItemName,
    price_sats: raw.price,
    unit_price_sats: raw.unitPrice ?? undefined,
    source: SOURCE,
    source_sale_id: raw.auctionId,
    seller_address: raw.from,
    buyer_address: raw.to,
    txid: raw.txid,
    sold_at: msToIso(raw.timestamp, raw),
    fetched_at,
  };
}

// ---------- Collection mapper ----------

/**
 * Maps a Unisat collection_statistic_list record to canonical Collection.
 *
 * Field mapping:
 *   collectionId    → collection_id (V1 canonical = Unisat ID)
 *   name            → name
 *   desc            → description (empty string normalized to null)
 *   icon            → icon_url (full URLs passed through; bare inscription
 *                     IDs returned as-is — Hiro adapter resolves to URL later)
 *   floorPrice      → floor_price_sats
 *   listed          → total_listed
 *   total           → total_supply
 *   marketCap       → market_cap_sats
 *   twitter/discord → empty strings normalized to null
 *   website         → empty string normalized to null
 *
 * Dropped:
 *   btcValue, btcValuePercent, pricePercent, transactionCount24h, tag,
 *   verification, isBrc2_0, isGallery, supply (==total), iconContentType
 *   — present-but-secondary metadata. transactionCount24h could populate
 *   sales_24h if it represents sales count, but the audit/fixtures don't
 *   confirm semantics. Conservative: drop until we can verify.
 */
export function mapCollection(
  raw: UnisatCollectionStat,
  fetched_at: string
): Collection {
  return {
    collection_id: raw.collectionId,
    name: raw.name,
    description: raw.desc === '' ? null : raw.desc,
    icon_url: raw.icon === '' ? null : raw.icon,
    twitter: raw.twitter === '' ? null : raw.twitter,
    discord: raw.discord === '' ? null : raw.discord,
    website: raw.website === '' ? null : raw.website,
    floor_price_sats: raw.floorPrice,
    total_listed: raw.listed,
    total_supply: raw.total,
    market_cap_sats: raw.marketCap,
    fetched_at,
  };
}

// ---------- Inscription info mapper ----------

/**
 * Maps a Unisat inscription_info_list record to canonical Listing.
 *
 * Returns null when the inscription has no active Unisat listing
 * (notOnSale === true, or auctionId/price/onSaleTime/address are null).
 *
 * This is the bulk-lookup endpoint, used to enrich a known inscription with
 * its current Unisat listing state. The "no active listing" case is normal
 * and expected — most inscriptions aren't currently for sale.
 *
 * When the listing IS active, the same canonical Listing shape comes out as
 * mapListing() above, just sourced from a different endpoint. Critically,
 * collectionName IS available here (unlike auction/list), so we populate it.
 */
export function mapInscriptionInfo(
  raw: UnisatInscriptionInfo,
  fetched_at: string
): Listing | null {
  if (raw.notOnSale) return null;

  // notOnSale=false should mean all four fields are populated; if not,
  // Unisat's contract has shifted and we should know about it loudly.
  if (
    raw.auctionId === null ||
    raw.price === null ||
    raw.onSaleTime === null ||
    raw.address === null
  ) {
    throw new MapperError(
      `inscription_info has notOnSale=false but missing listing fields ` +
        `(inscriptionId=${raw.inscriptionId}, auctionId=${raw.auctionId}, ` +
        `price=${raw.price}, onSaleTime=${raw.onSaleTime}, address=${raw.address})`,
      raw
    );
  }

  if (raw.marketType !== 'fixedPrice') {
    return null;
  }

  return {
    protocol: 'ordinal',
    asset_id: raw.inscriptionId,
    inscription_number: raw.inscriptionNumber,
    collection_id: raw.collectionId,
    collection_name: raw.collectionName,
    item_name: raw.collectionItemName,
    content_type: raw.contentType,
    price_sats: raw.price,
    quantity: undefined, // inscription_info_list doesn't expose amount
    source: SOURCE,
    source_url: buildSourceUrl(raw.inscriptionId),
    source_listing_id: raw.auctionId,
    seller_address: raw.address,
    listed_at: msToIso(raw.onSaleTime, raw),
    fetched_at,
  };
}
