/**
 * GET /v1/collections/:slug
 *
 * Detailed stats for a single collection. Calls adapter.getCollectionStats.
 * The adapter implements this by paging Unisat's directory until a match —
 * it's not the cheapest possible call, but it's the only stats source
 * Unisat currently exposes per the audit.
 *
 * Response: SourcedResult<Collection>. On UnisatCollectionNotFoundError,
 * returns 404 collection_not_found. On UnisatAdapterUnavailableError,
 * returns 200 with `data: null` and degraded source_status. On ZodError
 * (slug validation), returns 400.
 *
 * Slug validation: alphanumeric + dash + underscore, 1-128 chars. Unisat
 * slugs in the May 10 fixture set fit this comfortably ('nodemonkes',
 * 'bitmap', 'runestone'). The pattern guards against path-traversal-ish
 * inputs and keeps error messages tight if someone fuzzes the endpoint.
 */

import { z } from 'zod';

import { getUnisatAdapter } from '@/lib/adapter-singleton.js';
import { handleError, nowIso, sourcedJson } from '@/lib/response.js';

const SlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'slug must be alphanumeric, dash, or underscore');

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const fetched_at = nowIso();
  try {
    const slug = SlugSchema.parse(ctx.params.slug);
    const adapter = getUnisatAdapter();
    const result = await adapter.getCollectionStats(slug);
    return sourcedJson(result);
  } catch (err) {
    return handleError(err, {
      // For single-resource endpoints, the degraded path returns null
      // (per response.ts contract). A consumer that sees data === null
      // and source_status.health !== 'ok' knows the source was unavailable.
      empty_data: null,
      fetched_at,
      source: 'unisat',
    });
  }
}
