/**
 * Unisat API response schemas.
 *
 * Validates raw `unknown` bodies returned from UnisatClient.request() into
 * typed shapes. Mappers (mappers.ts) consume these and produce canonical
 * Floorboard types.
 *
 * Design notes:
 * - Permissive (.passthrough()) not strict: Unisat will add fields over time.
 *   We type the fields we read; we tolerate fields we don't.
 * - Every field that came back null in real fixtures is .nullable() here.
 *   Field nullability was determined empirically from May 10 fixture capture,
 *   not from the audit doc field lists.
 * - Numeric IDs and prices stay z.number().int(). Sats are always integers
 *   per project convention; never floats.
 * - The `Claim` event is included in the action enum because Unisat emits it,
 *   but the mapper drops Claim events (no canonical equivalent in V1 — they
 *   apply to auction-style listings, which are out of scope for fixedPrice V1).
 */

import { z } from 'zod';

// ---------- Envelope shapes ----------

/**
 * Every Unisat endpoint wraps its payload in { code, msg, data }.
 * code: 0 = success. Non-zero is a logical error returned with HTTP 200.
 * The HTTP client doesn't pre-check this — schemas surface it via mappers.
 */
export const UnisatEnvelopeSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z
    .object({
      code: z.number().int(),
      msg: z.string(),
      data: dataSchema,
    })
    .passthrough();

/**
 * List-style endpoints (auction/list, auction/actions, collection_statistic_list)
 * wrap their items in { list, total }. inscription_info_list does NOT — it
 * returns data: T[] directly.
 */
export const UnisatPaginatedSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z
    .object({
      list: z.array(itemSchema),
      total: z.number().int(),
    })
    .passthrough();

// ---------- Shared sub-shapes ----------

/**
 * Trait attribute entry. Appears on auction/list (full attrs[]) and
 * inscription_info_list (full attrs[]). On auction/actions, the field is
 * named `attributes` and uses a different shape (or is null) — handled below.
 *
 * count: total inscriptions in the collection with this trait
 * listingCount: how many of those are currently listed
 * floorPrice: cheapest listing among those, in sats; 0 if none listed
 */
export const UnisatTraitAttrSchema = z
  .object({
    traitType: z.string(),
    value: z.union([z.string(), z.number()]),
    count: z.number().int(),
    listingCount: z.number().int(),
    floorPrice: z.number().int(),
  })
  .passthrough();

// ---------- /v3/market/collection/auction/list ----------

/**
 * Single active listing record.
 *
 * Fixture-driven nullability:
 * - amount: nullable (5th nodemonkes listing has amount: null)
 * - unitPrice: nullable (same record)
 * - collectionHighResImgUrl: nullable (all 5 nodemonkes records had null)
 * - collectionItemName: nullable (all 5 nodemonkes records had null;
 *   compare with auction/actions where it's populated — this field is
 *   reliably present on events but not on listings)
 * - contentType: nullable (defensive; populated in fixtures)
 * - domain*: always nullable (only populated when nftType=domain)
 * - attrs: nullable (defensive; populated in fixtures for nftType=collection)
 *
 * The audit doc said unitPrice is "meaningful for fungibles" — true, but the
 * fixture also showed it null on a regular ordinal listing, so we can't
 * require it for any nftType.
 */
export const UnisatListingSchema = z
  .object({
    auctionId: z.string(),
    inscriptionId: z.string(),
    inscriptionNumber: z.number().int(),
    collectionId: z.string(),
    collectionItemName: z.string().nullable(),
    collectionHighResImgUrl: z.string().nullable(),
    contentType: z.string().nullable(),
    nftType: z.string(), // 'collection' | 'brc20' | 'runes' | 'alkanes' | 'domain' | 'brc20Prog'
    marketType: z.string(), // 'fixedPrice' for V1; auction-style is a separate value
    price: z.number().int(),
    unitPrice: z.number().int().nullable(),
    amount: z.number().int().nullable(),
    onSaleTime: z.number().int(), // ms epoch
    address: z.string(), // seller
    domain: z.string().nullable(),
    domainHex: z.string().nullable(),
    domainType: z.string().nullable(),
    attrs: z.array(UnisatTraitAttrSchema).nullable(),
  })
  .passthrough();

export const UnisatAuctionListResponseSchema = UnisatEnvelopeSchema(
  UnisatPaginatedSchema(UnisatListingSchema)
);
export type UnisatListing = z.infer<typeof UnisatListingSchema>;
export type UnisatAuctionListResponse = z.infer<typeof UnisatAuctionListResponseSchema>;

// ---------- /v3/market/collection/auction/actions ----------

/**
 * Event types Unisat emits.
 * Mappers in V1 emit canonical 'listed' | 'cancelled' | 'sold' | 'updated'.
 * 'Claim' is parsed (so the schema doesn't reject events that include it)
 * but dropped at the mapper layer — auction-style settlement isn't in
 * V1's fixedPrice scope.
 */
export const UnisatEventEnum = z.enum(['Listed', 'Cancel', 'Sold', 'Updated', 'Claim']);
export type UnisatEvent = z.infer<typeof UnisatEventEnum>;

/**
 * Event-feed `attributes` field uses a different shape than listings' `attrs`.
 * On Sold events in our fixture, it's null or [] (empty for runestones,
 * empty array for bitmap). Defensive: allow null OR an array of loosely-typed
 * trait records. We don't currently consume this field; it's kept for fidelity.
 */
const UnisatEventAttributeSchema = z
  .object({
    trait_type: z.string(),
    value: z.union([z.string(), z.number()]),
  })
  .passthrough();

/**
 * Single event record.
 *
 * Fixture-driven nullability:
 * - to: nullable (only populated for Sold events; null/undefined for Listed/Cancel)
 * - from: defensive nullable (always populated in our Sold fixtures)
 * - sellTxid, sellIndex: nullable (always null in our fixtures)
 * - alkaneid, atomicalId, atomicalIndex, atomicalTxid: nullable (cross-asset
 *   fields, null for collection events)
 * - attributes: nullable
 * - collectionHighResImgUrl: nullable (defensive; populated in fixtures)
 * - contentType, contentBody: nullable
 * - channel: optional (present on three runestone events, absent on bitmap event)
 * - height: optional (defensive)
 * - dbTag: present in fixtures but ignored — not part of public contract
 * - newest: present (boolean) but ignored — internal Unisat sort marker
 * - endMsg: nullable
 * - name: nullable
 * - amount, unitPrice: nullable for cross-asset consistency
 *
 * inscriptionId on event feed can have suffix iN where N > 0 (e.g. runestones'
 * multi-inscription envelopes — i100, i832, i1100). The whole string IS the
 * canonical asset_id; do not split.
 */
export const UnisatActionSchema = z
  .object({
    auctionId: z.string(),
    event: UnisatEventEnum,
    inscriptionId: z.string(),
    inscriptionNumber: z.number().int(),
    collectionId: z.string(),
    collectionItemName: z.string().nullable(),
    collectionHighResImgUrl: z.string().nullable(),
    contentType: z.string().nullable(),
    contentBody: z.string().nullable(),
    nftType: z.string(),
    price: z.number().int(),
    unitPrice: z.number().int().nullable(),
    amount: z.number().int().nullable(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    timestamp: z.number().int(), // ms epoch
    txid: z.string(),
    sellTxid: z.string().nullable(),
    sellIndex: z.number().int().nullable(),
    name: z.string().nullable(),
    endMsg: z.string().nullable(),
    attributes: z.array(UnisatEventAttributeSchema).nullable(),
    channel: z.string().optional(), // 'UniSat' on some events, absent on others
    height: z.number().int().optional(),
    // Cross-asset fields — null for nftType=collection events but present in shape
    alkaneid: z.string().nullable(),
    atomicalId: z.string().nullable(),
    atomicalIndex: z.number().int().nullable(),
    atomicalTxid: z.string().nullable(),
    domain: z.string().nullable(),
    domainCategorys: z.array(z.string()).nullable(),
    domainType: z.string().nullable(),
  })
  .passthrough();

export const UnisatAuctionActionsResponseSchema = UnisatEnvelopeSchema(
  UnisatPaginatedSchema(UnisatActionSchema)
);
export type UnisatAction = z.infer<typeof UnisatActionSchema>;
export type UnisatAuctionActionsResponse = z.infer<typeof UnisatAuctionActionsResponseSchema>;

// ---------- /v3/market/collection/auction/collection_statistic_list ----------

/**
 * Single collection record from the directory endpoint.
 *
 * Fixture-driven nullability:
 * - All fields are reliably populated for the top 5 collections in our
 *   fixture. Defensive nullability only on description-style fields.
 * - icon may be a full URL (bitmap) or a bare inscriptionId (bitcoin-frogs);
 *   we type it as string and let the mapper resolve.
 * - tag is empty string in fixtures, not null. Kept as string.
 * - btcValuePercent and pricePercent are 1 in our fixtures — likely a placeholder
 *   for percent change. Type as number, surface in canonical only if non-trivial.
 */
export const UnisatCollectionStatSchema = z
  .object({
    collectionId: z.string(),
    name: z.string(),
    desc: z.string(),
    icon: z.string(),
    iconContentType: z.string(),
    btcValue: z.number().int(),
    btcValuePercent: z.number(),
    floorPrice: z.number().int(),
    marketCap: z.number().int(),
    pricePercent: z.number(),
    listed: z.number().int(),
    total: z.number().int(),
    supply: z.number().int(),
    transactionCount24h: z.number().int(),
    tag: z.string(),
    twitter: z.string(),
    discord: z.string(),
    website: z.string(),
    verification: z.boolean(),
    isBrc2_0: z.boolean(),
    isGallery: z.boolean(),
  })
  .passthrough();

export const UnisatCollectionStatListResponseSchema = UnisatEnvelopeSchema(
  UnisatPaginatedSchema(UnisatCollectionStatSchema)
);
export type UnisatCollectionStat = z.infer<typeof UnisatCollectionStatSchema>;
export type UnisatCollectionStatListResponse = z.infer<
  typeof UnisatCollectionStatListResponseSchema
>;

// ---------- /v3/market/collection/auction/inscription_info_list ----------

/**
 * UTXO sub-record returned with each inscription. We don't currently consume
 * any of these fields, but typing them keeps the schema honest about the
 * actual response shape. Permissive on the nested inscriptions[] array.
 */
const UnisatUtxoInscriptionSchema = z
  .object({
    inscriptionNumber: z.number().int(),
    inscriptionId: z.string(),
    offset: z.number().int(),
    contentType: z.string(),
  })
  .passthrough();

const UnisatUtxoSchema = z
  .object({
    txid: z.string(),
    vout: z.number().int(),
    satoshi: z.number().int(),
    scriptType: z.string(),
    scriptPk: z.string(),
    address: z.string(),
    height: z.number().int(),
    inscriptionsCount: z.number().int(),
    inscriptions: z.array(UnisatUtxoInscriptionSchema),
  })
  .passthrough();

/**
 * Single inscription_info_list record.
 *
 * Critical fixture-driven decisions:
 * - notOnSale: boolean — the canonical "is this listed on Unisat right now"
 *   flag. When true, auctionId/price/onSaleTime/address are all null.
 *   When false, they're populated.
 * - auctionId, price, onSaleTime, address: nullable (null when notOnSale=true)
 * - verification on this endpoint is per-inscription and may disagree with
 *   the collection-level verification in collection_statistic_list — the
 *   collection-level value is authoritative for V1.
 * - contentBody: empty string in our fixture (not null). Kept as string.
 * - collectionName: present here but absent on auction/list — useful for
 *   single-inscription detail view enrichment.
 * - utxo: full UTXO record. Always present in our fixture, but defensive
 *   nullable in case of unindexed inscriptions.
 */
export const UnisatInscriptionInfoSchema = z
  .object({
    inscriptionId: z.string(),
    inscriptionNumber: z.number().int(),
    collectionId: z.string(),
    collectionName: z.string(),
    collectionItemName: z.string().nullable().optional(),
    contentType: z.string(),
    contentBody: z.string(),
    nftType: z.string(),
    marketType: z.string(),
    notOnSale: z.boolean(),
    auctionId: z.string().nullable(),
    price: z.number().int().nullable(),
    onSaleTime: z.number().int().nullable(),
    address: z.string().nullable(),
    supply: z.number().int(),
    verification: z.boolean(),
    attrs: z.array(UnisatTraitAttrSchema).nullable(),
    utxo: UnisatUtxoSchema.nullable(),
  })
  .passthrough();

/**
 * inscription_info_list returns data: T[] directly — NOT wrapped in {list, total}.
 * This is the only one of the four endpoints that breaks the paginated wrapper
 * pattern. The audit doc flagged it; the fixture confirmed it.
 */
export const UnisatInscriptionInfoListResponseSchema = UnisatEnvelopeSchema(
  z.array(UnisatInscriptionInfoSchema)
);
export type UnisatInscriptionInfo = z.infer<typeof UnisatInscriptionInfoSchema>;
export type UnisatInscriptionInfoListResponse = z.infer<
  typeof UnisatInscriptionInfoListResponseSchema
>;
