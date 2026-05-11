/**
 * GET /v1/collections
 *
 * Paginated collection directory. Calls adapter.listCollections.
 *
 * Query params:
 *   sort?: 'volume_desc' | 'floor_asc' | 'recent' | 'listed_count_desc'
 *          (default 'volume_desc')
 *   cursor?: string  (opaque pagination cursor from previous response)
 *   limit?:  integer 1..100 (default 50, adapter may cap further)
 *
 * Response: SourcedResult<Page<Collection>> — passed through from the
 * adapter unchanged. On UnisatAdapterUnavailableError, returns 200 with
 * an empty Page and degraded source_status. On ZodError, returns 400.
 */

import { z } from 'zod';

import { getUnisatAdapter } from '@/lib/adapter-singleton.js';
import { handleError, nowIso, parseQuery, sourcedJson } from '@/lib/response.js';
import type { Collection, Page } from '@/types/index.js';

const QuerySchema = z.object({
  sort: z
    .enum(['volume_desc', 'floor_asc', 'recent', 'listed_count_desc'])
    .optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const EMPTY_PAGE: Page<Collection> = { items: [], next_cursor: null, has_more: false };

export async function GET(request: Request): Promise<Response> {
  const fetched_at = nowIso();
  try {
    const params = parseQuery(request, QuerySchema);
    const adapter = getUnisatAdapter();
    const result = await adapter.listCollections({
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
