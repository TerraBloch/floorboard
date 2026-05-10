/**
 * Unisat HTTP client.
 *
 * Thin wrapper around fetch that handles the cross-cutting concerns for every
 * Unisat call: rate limiting, auth, browser-realistic headers, and error mapping.
 *
 * Schema validation is NOT this layer's job — callers parse `unknown` bodies
 * with Zod schemas in `schemas.ts`. Keeping validation out of the client lets
 * us share the client across endpoints with different response shapes without
 * a generic-parameter explosion.
 *
 * Audit notes that drove this design (see FLOORBOARD_HANDOFF.md, May 9 session):
 *   - Cloudflare in front of open-api.unisat.io fingerprints UA. Default Node
 *     fetch UA gets 403'd. Browser-realistic UA + Origin + Referer pass cleanly.
 *   - Validation errors are descriptive Fastify/Joi (FST_ERR_VALIDATION with
 *     exact field path). We surface that field path in UnisatValidationError
 *     so adapter tests can assert on it without string-matching error messages.
 *   - No rate-limit headers are exposed. Client-side enforcement via
 *     TokenBucketLimiter is the only option.
 *
 * V1 limitations (intentional, document and revisit):
 *   - No retries. Adding speculatively would be wrong; we'll see the real
 *     failure modes from production traffic before designing retry policy.
 *   - No request logging beyond errors. Observability lives in V2.
 */

import type { TokenBucketLimiter } from '../../core/rate-limiter';
import { RateLimitExceededError } from '../../core/rate-limiter';

const UNISAT_API_BASE = 'https://open-api.unisat.io';

// Browser-realistic UA. Match a recent Chrome on macOS — what most Unisat
// users actually send. Updating this is a maintenance task; if Cloudflare
// starts 403'ing again, bump to the current Chrome version.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface UnisatClientConfig {
  /** Bearer token. Read from env by the adapter, never hard-coded. */
  api_key: string;
  /** The shared TokenBucketLimiter instance. One per adapter instance. */
  limiter: TokenBucketLimiter;
  /** Override the API base. Useful for tests pointing at a mock server. */
  base_url?: string;
  /** Override the User-Agent. Adapter passes its configured UA through. */
  user_agent?: string;
  /** Default request timeout in ms. Per-call override available on request(). */
  default_timeout_ms?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch_impl?: typeof fetch;
}

export interface RequestOptions {
  /** HTTP method. Defaults to POST since every audited endpoint is POST. */
  method?: 'GET' | 'POST';
  /** JSON body for POST. Ignored for GET. */
  body?: unknown;
  /** Per-call timeout override. */
  timeout_ms?: number;
  /** External AbortSignal — composed with the timeout signal. */
  signal?: AbortSignal;
}

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Base class for all Unisat client errors. Lets adapter code catch with one
 * `instanceof UnisatClientError` rather than enumerating every subclass.
 */
export class UnisatClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnisatClientError';
  }
}

/**
 * Thrown when Unisat returns a 4xx that is NOT a Fastify validation error.
 * 401/403 (auth), 404 (not found), 429 (rate limit from server even though
 * we limit client-side), and any other 4xx end up here.
 */
export class UnisatHttpError extends UnisatClientError {
  public readonly status: number;
  public readonly body: unknown;
  public readonly endpoint: string;

  constructor(status: number, endpoint: string, body: unknown) {
    super(`Unisat HTTP ${status} on ${endpoint}`);
    this.name = 'UnisatHttpError';
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

/**
 * Fastify validation error from the Unisat API. The audit confirmed these
 * come back with FST_ERR_VALIDATION code and a descriptive `message` field
 * that includes the exact failing field path (e.g. "body/filter/nftType").
 *
 * We pull out `field_path` for tests/adapter logic; the raw body is preserved
 * for debugging. If Unisat ever changes the error shape, parsing degrades to
 * field_path = null but the error still surfaces.
 */
export class UnisatValidationError extends UnisatClientError {
  public readonly field_path: string | null;
  public readonly endpoint: string;
  public readonly body: unknown;

  constructor(endpoint: string, body: unknown, field_path: string | null) {
    super(
      `Unisat validation error on ${endpoint}` +
        (field_path !== null ? ` at ${field_path}` : ''),
    );
    this.name = 'UnisatValidationError';
    this.endpoint = endpoint;
    this.body = body;
    this.field_path = field_path;
  }
}

/**
 * Thrown for network-level failures (DNS, TCP, TLS, abort) and timeouts.
 * Distinct from HTTP errors because retry policy will eventually want to
 * treat them differently.
 */
export class UnisatNetworkError extends UnisatClientError {
  public readonly endpoint: string;
  public readonly cause_name: string;

  constructor(endpoint: string, cause: unknown) {
    const cause_name =
      cause instanceof Error ? cause.name : 'UnknownNetworkError';
    super(
      `Unisat network error on ${endpoint}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'UnisatNetworkError';
    this.endpoint = endpoint;
    this.cause_name = cause_name;
  }
}

// ─── Client ────────────────────────────────────────────────────────────────

export class UnisatClient {
  private readonly api_key: string;
  private readonly limiter: TokenBucketLimiter;
  private readonly base_url: string;
  private readonly user_agent: string;
  private readonly default_timeout_ms: number;
  private readonly fetch_impl: typeof fetch;

  constructor(config: UnisatClientConfig) {
    if (!config.api_key) {
      throw new Error('UnisatClient: api_key is required');
    }
    this.api_key = config.api_key;
    this.limiter = config.limiter;
    this.base_url = (config.base_url ?? UNISAT_API_BASE).replace(/\/$/, '');
    this.user_agent = config.user_agent ?? DEFAULT_USER_AGENT;
    this.default_timeout_ms = config.default_timeout_ms ?? 15_000;
    this.fetch_impl = config.fetch_impl ?? fetch;
  }

  /**
   * Make a request to a Unisat endpoint. Returns the parsed JSON body as
   * `unknown` — caller validates with Zod.
   *
   * @param endpoint Path beginning with `/` (e.g. `/v3/market/collection/auction/list`)
   */
  async request<T = unknown>(
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!endpoint.startsWith('/')) {
      throw new Error(`UnisatClient: endpoint must start with '/', got '${endpoint}'`);
    }

    // Rate limit BEFORE fetch. acquire() throws RateLimitExceededError on
    // per-day exhaustion; the caller's own handler will see that as a typed
    // error distinct from anything originating in the HTTP path.
    await this.limiter.acquire();

    const method = options.method ?? 'POST';
    const url = `${this.base_url}${endpoint}`;
    const timeout_ms = options.timeout_ms ?? this.default_timeout_ms;

    // Compose the external signal (if any) with our timeout signal so EITHER
    // can abort the request. AbortSignal.any is available in Node 20+ and
    // modern browsers, both of which our package.json targets.
    const timeout_controller = new AbortController();
    const timeout_id = setTimeout(() => timeout_controller.abort(), timeout_ms);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout_controller.signal])
      : timeout_controller.signal;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.api_key}`,
      Accept: 'application/json',
      'User-Agent': this.user_agent,
      // Cloudflare fingerprinting requires these. Don't remove without re-auditing.
      Origin: 'https://unisat.io',
      Referer: 'https://unisat.io/',
    };

    let body_text: string | undefined;
    if (method === 'POST' && options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body_text = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetch_impl(url, {
        method,
        headers,
        body: body_text,
        signal,
      });
    } catch (err) {
      throw new UnisatNetworkError(endpoint, err);
    } finally {
      clearTimeout(timeout_id);
    }

    // Parse body as JSON if possible; some error responses are HTML or empty.
    // If parsing fails, we still surface the status — the body is just `null`
    // in the typed error.
    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text; // preserve raw text for debugging non-JSON error pages
      }
    }

    if (!response.ok) {
      // Detect Fastify validation errors and surface them as a typed subclass.
      const validation_field_path = extractFastifyValidationFieldPath(parsed);
      if (validation_field_path !== undefined) {
        throw new UnisatValidationError(endpoint, parsed, validation_field_path);
      }
      throw new UnisatHttpError(response.status, endpoint, parsed);
    }

    return parsed as T;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Detect Fastify validation errors in a parsed body and extract the field path.
 *
 * Returns:
 *   - `string` — field path extracted (e.g. "body/filter/nftType")
 *   - `null` — body looks like a Fastify validation error but no field path could be parsed
 *   - `undefined` — body is NOT a Fastify validation error
 *
 * The undefined-vs-null distinction lets the caller decide between
 * UnisatValidationError (field_path may be null) and UnisatHttpError.
 *
 * Fastify validation errors have shape:
 *   { code: "FST_ERR_VALIDATION", error: "Bad Request", message: "body/x must be ..." }
 */
function extractFastifyValidationFieldPath(
  body: unknown,
): string | null | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  if (obj['code'] !== 'FST_ERR_VALIDATION') return undefined;

  const message = obj['message'];
  if (typeof message !== 'string') return null;

  // Messages start with the field path: "body/filter/nftType must be string"
  const m = message.match(/^([\w/[\]]+)\s/);
  if (m && m[1] !== undefined) return m[1];
  return null;
}
