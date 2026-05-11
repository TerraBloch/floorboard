/**
 * GET /v1/events
 *
 * Event feed: listings/cancellations/sales/updates across the venue.
 * Calls adapter.listEvents.
 *
 * Query params:
 *   since: REQUIRED ISO 8601 timestamp. Lower bound on event time.
 *   until?: ISO 8601 timestamp. Upper bound, exclusive of right side
 *          per the adapter's filter semantics.
 *   kinds?: comma-separated list of 'listed' | 'cancelled' | 'sold' | 'updated'.
 *          Exactly one kind uses Unisat's on-wire `event` filter; multiple
 *          kinds fall back to client-side filtering (documented in adapter).
 *   collection_id?: filter results to one collection (client-side filter;
 *          Unisat's /actions doesn't accept collectionId on the wire).
 *   cursor?: string
 *   limit?:  integer 1..100 (default 50)
 *
 * Time-window filtering is client-side because Unisat's /actions endpoint
 * silently ignores time params (per the May 9 audit). If `since` is deep
 * in the past relative to a busy feed, the adapter may return a sparse
 * page — callers paginate with the returned cursor. One wire call per
 * request, as with the other adapter methods.
 *
 * Response: SourcedResult<Page<VenueEvent>>.
 */

import { z } from 'zod';

import { getUnisatAdapter } from '@/lib/adapter-singleton';
import { handleError, nowIso, parseQuery, sourcedJson } from '@/lib/response';
import type { Page, VenueEvent } from '@/types/index';

const EventKindSchema = z.enum(['listed', 'cancelled', 'sold', 'updated']);

/**
 * ISO 8601 timestamp string. Validated by parsing through Date — Zod's
 * built-in datetime validator is stricter than what we want (rejects some
 * valid ISO forms). We accept anything Date.parse handles and reject
 * NaN — which is what the adapter does internally too.
 */
const IsoTimestampSchema = z
  .string()
  .min(1)
  .refine((s) => Number.isFinite(Date.parse(s)), {
    message: 'must be a parseable ISO 8601 timestamp',
  });

/**
 * Kinds query parsing: comma-separated. Empty entries (e.g. trailing
 * comma) are dropped before validation. Duplicates pass through — the
 * adapter handles them idempotently.
 */
const KindsSchema = z
  .string()
  .min(1)
  .optional()
  .transform((raw) =>
    raw === undefined
      ? undefined
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
  )
  .pipe(z.array(EventKindSchema).min(1).optional());

const QuerySchema = z.object({
  since: IsoTimestampSchema,
  until: IsoTimestampSchema.optional(),
  kinds: KindsSchema,
  collection_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const EMPTY_PAGE: Page<VenueEvent> = { items: [], next_cursor: null, has_more: false };

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const fetched_at = nowIso();
  try {
    const params = parseQuery(request, QuerySchema);
    const adapter = getUnisatAdapter();
    const result = await adapter.listEvents({
      since: params.since,
      until: params.until,
      kinds: params.kinds,
      collection_id: params.collection_id,
      cursor: params.cursor,
      limit: params.limit,
    });
    return sourcedJson(result);
  } catch (err) {
    return handleError(err, {
      empty_data: EMPTY_PAGE,
      fetched_at,
      source: 'unisat',
    });
  }
}
