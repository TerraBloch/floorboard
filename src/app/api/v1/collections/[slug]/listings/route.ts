/**
 * GET /v1/collections/:slug/listings
 *
 * Paginated active listings for a collection. Calls adapter.listListings.
 *
 * Path params:
 *   slug: collection_id (alphanumeric, dash, underscore — 1..128 chars)
 *
 * Query params:
 *   sort?: 'price_asc' | 'price_desc' | 'recent' | 'oldest' (default 'price_asc')
 *   cursor?: string
 *   limit?:  integer 1..100 (default 50)
 *
 * Response: SourcedResult<Page<Listing>>. Non-fixedPrice listings are
 * dropped by the adapter mapper (auction-style variants), so the returned
 * count may be less than Unisat's reported total — that's documented in
 * mappers.ts and intentional for V1.
 *
 * Stale-listing note: Unisat doesn't auto-expire old listings. The adapter
 * faithfully returns them with their original onSaleTime. UI surfaces
 * freshness from listed_at. The handoff doc flags this as a future UI
 * concern, not an adapter or API concern.
 */

import { z } from 'zod';

import { getUnisatAdapter } from '@/lib/adapter-singleton.js';
import { handleError, nowIso, parseQuery, sourcedJson } from '@/lib/response.js';
import type { Listing, Page } from '@/types/index.js';

const SlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'slug must be alphanumeric, dash, or underscore');

const QuerySchema = z.object({
  sort: z.enum(['price_asc', 'price_desc', 'recent', 'oldest']).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const EMPTY_PAGE: Page<Listing> = { items: [], next_cursor: null, has_more: false };

interface RouteContext {
  params: { slug: string };
}

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const fetched_at = nowIso();
  try {
    const slug = SlugSchema.parse(ctx.params.slug);
    const params = parseQuery(request, QuerySchema);
    const adapter = getUnisatAdapter();
    const result = await adapter.listListings({
      collection_id: slug,
      sort: params.sort,
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
