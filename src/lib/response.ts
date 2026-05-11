/**
 * Shared HTTP response helpers for the v1 API.
 *
 * The whole error-translation contract lives in this file. Every route
 * handler's catch block ends with `return errorResponse(err, ...)` and the
 * mapping below is the single source of truth for what each error class
 * means at the HTTP layer.
 *
 * HTTP status mapping (the load-bearing decisions):
 *
 *   ZodError (query/path param validation failure)
 *     → 400 invalid_request, with details from issue.path/issue.message
 *
 *   UnisatCollectionNotFoundError (semantic 404)
 *     → 404 collection_not_found, body identifies the missing collection_id
 *
 *   UnisatAdapterUnavailableError (operational: rate, network, 5xx, auth)
 *     → 200 with a SourcedResult-shaped envelope: empty data + degraded
 *       source_status. This is the explicit Floorboard contract — a consumer
 *       always gets a parseable response shape, the UI surfaces health badges
 *       from source_status. NOT an HTTP error.
 *
 *   Anything else (schema parse failures, programmer errors, etc.)
 *     → 500 internal_error. These represent contract drift or bugs and
 *       should fail loudly in dev/CI. The body is intentionally generic;
 *       diagnostic detail goes to the server log.
 *
 * The UnisatAdapterUnavailableError → 200 mapping is the surprising one and
 * the most likely to be questioned. The reasoning: 5xx/503 would force
 * consumers to special-case their HTTP plumbing for "Unisat is down but
 * Floorboard is fine"; using the SourcedResult envelope means consumers can
 * write one parser for all responses and let source_status drive UI states.
 */

import { ZodError, type ZodTypeAny, type z } from 'zod';

import {
  UnisatAdapterUnavailableError,
  UnisatCollectionNotFoundError,
} from '@/adapters/unisat/index';
import type { Source, SourcedResult, SourceStatus } from '@/types/index';

// ─── Success envelopes ────────────────────────────────────────────────────

/**
 * Pass a SourcedResult through to the consumer unchanged. The adapter
 * contract IS the API contract — no field renaming, no re-wrapping.
 */
export function sourcedJson<T>(result: SourcedResult<T>, init?: ResponseInit): Response {
  return Response.json(result, init);
}

/**
 * Synthesize a SourcedResult-shaped envelope when the adapter threw an
 * operational error. The `empty_data` argument is the empty-but-valid shape
 * for whatever the route normally returns (an empty Page, an empty array,
 * etc.) — each route knows its own return type.
 */
export function degradedJson<T>(
  empty_data: T,
  status: SourceStatus,
  fetched_at: string,
): Response {
  const envelope: SourcedResult<T> = {
    data: empty_data,
    source: status.source,
    fetched_at,
    source_status: status,
  };
  return Response.json(envelope);
}

// ─── Error envelopes ──────────────────────────────────────────────────────

export interface ErrorBody {
  error: string;
  message?: string;
  details?: unknown;
}

export function errorJson(status: number, body: ErrorBody): Response {
  return Response.json(body, { status });
}

/**
 * Translate an unknown error from a route handler into an HTTP Response.
 *
 * Routes with non-Page return shapes (e.g. /v1/collections/:slug returns
 * a single Collection, not a Page) pass `empty_data: null` and we encode
 * `null` for the operational-degraded case. Routes that page list data pass
 * an empty Page.
 *
 * The `source` parameter is the Source identifier to surface in the degraded
 * status when no UnisatAdapterUnavailableError.status is available (currently
 * unused since we only have Unisat; will matter once Hiro/Satflow join).
 */
export function handleError<T>(
  err: unknown,
  ctx: {
    empty_data: T;
    fetched_at: string;
    source: Source;
  },
): Response {
  if (err instanceof ZodError) {
    return errorJson(400, {
      error: 'invalid_request',
      message: 'One or more parameters failed validation.',
      details: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  if (err instanceof UnisatCollectionNotFoundError) {
    return errorJson(404, {
      error: 'collection_not_found',
      message: `Collection '${err.collection_id}' not found in source directory.`,
      details: { collection_id: err.collection_id, source: ctx.source },
    });
  }

  if (err instanceof UnisatAdapterUnavailableError) {
    return degradedJson(ctx.empty_data, err.status, ctx.fetched_at);
  }

  // Anything else is a contract drift or programmer error. Log loudly,
  // return a generic 500 — never leak internals to the client.
  console.error('[floorboard] unhandled error in route handler:', err);
  return errorJson(500, {
    error: 'internal_error',
    message: 'An unexpected error occurred. The incident has been logged.',
  });
}

// ─── Query param parsing ──────────────────────────────────────────────────

/**
 * Parse a Request's search params with a Zod schema. Throws ZodError on
 * failure; handleError translates that to HTTP 400.
 *
 * The generic is `S extends ZodTypeAny` (not `ZodSchema<T>`) so schemas
 * with differing input/output types — e.g. comma-separated lists parsed
 * via .transform().pipe() — work. Return type is `z.output<S>`, i.e. the
 * post-transform shape.
 *
 * Why Object.fromEntries instead of URLSearchParams direct iteration:
 * Zod sees the params as a record, can apply default values, and reports
 * missing required fields with a clean path. Repeated keys (?a=1&a=2)
 * collapse to the last value — fine for V1; if we ever need real array
 * params we'll switch to `getAll()` per field.
 */
export function parseQuery<S extends ZodTypeAny>(request: Request, schema: S): z.output<S> {
  const url = new URL(request.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  return schema.parse(raw);
}

/**
 * Current timestamp as ISO string. Centralized so we can stub it in tests
 * that need deterministic fetched_at on the degraded path. (The success
 * paths take fetched_at from the adapter; only the catch block for
 * operational errors uses this.)
 */
export function nowIso(): string {
  return new Date().toISOString();
}
