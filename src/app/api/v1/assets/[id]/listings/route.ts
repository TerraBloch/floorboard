/**
 * GET /v1/assets/:id/listings
 *
 * Per-asset listing lookup. Calls adapter.getListingsForAsset.
 * Returns all currently-active listings on this venue for the given
 * asset_id. Empty array means not listed here right now (not an error).
 *
 * For Ordinals, asset_id is the inscription_id — the standard 64-hex
 * txid + 'i' + index format. Validation enforces shape; the adapter
 * passes it through to Unisat's /inscription_info_list endpoint, which
 * returns notOnSale=true for inscriptions Unisat tracks but isn't
 * currently listing. mapInscriptionInfo drops those rows; the adapter
 * filters them out; the API returns an empty array.
 *
 * V1 limitation: only Unisat is queried. When Satflow joins, this
 * endpoint will fan out to both adapters and dedup at the inscription_id
 * key — which is the whole multi-venue thesis.
 *
 * Response: SourcedResult<Listing[]>. Empty array on no listings,
 * degraded source_status on operational failures.
 */

import { z } from 'zod';

import { getUnisatAdapter } from '@/lib/adapter-singleton';
import { handleError, nowIso, sourcedJson } from '@/lib/response';
import type { Listing } from '@/types/index';

/**
 * Inscription ID shape: 64-hex transaction id, literal 'i', non-negative
 * integer index. Case-insensitive on the hex part. Total length bounded.
 * This is strict enough to reject path-traversal-ish inputs while
 * accepting every real inscription ID Unisat will recognize.
 */
const AssetIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-f0-9]{64}i\d+$/i, 'asset_id must be a valid inscription id (64-hex + "i" + index)');

const EMPTY_LISTINGS: Listing[] = [];

interface RouteContext {
  params: { id: string };
}

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const fetched_at = nowIso();
  try {
    const asset_id = AssetIdSchema.parse(ctx.params.id);
    const adapter = getUnisatAdapter();
    const result = await adapter.getListingsForAsset(asset_id);
    return sourcedJson(result);
  } catch (err) {
    return handleError(err, {
      empty_data: EMPTY_LISTINGS,
      fetched_at,
      source: 'unisat',
    });
  }
}
