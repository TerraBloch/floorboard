/**
 * GET /v1/health
 *
 * Single-source health probe. Calls adapter.health() — which is the one
 * adapter method that never throws by contract — and returns the
 * SourceStatus directly. Always 200; check source_status.health for
 * 'ok' | 'degraded' | 'unavailable'.
 *
 * Costs one Unisat rate-limit token per request. If this endpoint gets
 * polled aggressively (e.g. by a status page or load balancer), point
 * those at a cached version or accept that they'll burn quota. The
 * adapter's health() docstring notes the same concern.
 */

import { getUnisatAdapter } from '@/lib/adapter-singleton';
import { errorJson } from '@/lib/response';

/**
 * Always re-invoke on every request. The static-optimization detector
 * would otherwise prerender this route at build time because GET() takes
 * no Request — but a health probe must reflect live upstream state.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const adapter = getUnisatAdapter();
    const status = await adapter.health();
    return Response.json(status);
  } catch (err) {
    // health() never throws per contract. The only way we reach here is
    // if getUnisatAdapter() throws (missing env var) — that's a deploy
    // misconfiguration, not a transient failure.
    console.error('[floorboard] /v1/health bootstrap error:', err);
    return errorJson(500, {
      error: 'internal_error',
      message: 'Adapter could not be constructed.',
    });
  }
}
