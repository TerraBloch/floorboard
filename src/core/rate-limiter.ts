/**
 * Token-bucket rate limiter.
 *
 * Used by every adapter that talks to a rate-limited venue API. Generic on
 * purpose — Unisat, Satflow, OKX all need this with different parameters.
 *
 * Two-bucket design:
 *   - Per-second bucket: smooth out bursts. acquire() waits if empty.
 *   - Per-day bucket: hard cap. acquire() throws RateLimitExceededError if empty.
 *
 * Rationale for the asymmetry: per-second exhaustion is normal traffic shaping
 * and the caller should never see it. Per-day exhaustion is a real outage —
 * waiting hours for UTC midnight is not a thing the call stack should do.
 *
 * V1 limitation: in-memory only. Process restart resets the day counter.
 * Documented in the README; revisited in V2 when persistence layer arrives.
 *
 * Day boundary: UTC midnight, matching standard rate-limit conventions. If a
 * venue documents otherwise we'll add a config knob, but no current target
 * venue (Unisat, Satflow, OKX) uses non-UTC.
 */

export class RateLimitExceededError extends Error {
  public readonly retry_after: string; // ISO 8601
  public readonly scope: 'per_second' | 'per_day';

  constructor(scope: 'per_second' | 'per_day', retry_after: string) {
    super(
      `Rate limit exceeded (${scope}). Retry after ${retry_after}.`,
    );
    this.name = 'RateLimitExceededError';
    this.scope = scope;
    this.retry_after = retry_after;
  }
}

export interface RateLimiterConfig {
  requests_per_second: number;
  requests_per_day?: number;
  /**
   * Now provider for testability. Defaults to Date.now.
   */
  now?: () => number;
}

export interface RateLimiterStatus {
  per_second_capacity: number;
  per_second_available: number; // float in [0, capacity], representing tokens
  per_day_limit: number | null;
  per_day_used: number;
  per_day_resets_at: string; // ISO 8601, next UTC midnight
}

interface QueuedRequest {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Returns the timestamp (ms since epoch) of the next UTC midnight strictly
 * after `now_ms`. If `now_ms` is exactly midnight, returns the following midnight.
 */
function nextUtcMidnight(now_ms: number): number {
  const d = new Date(now_ms);
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return next;
}

export class TokenBucketLimiter {
  private readonly per_second_capacity: number;
  private readonly per_second_refill_rate_per_ms: number;
  private readonly per_day_limit: number | null;
  private readonly now: () => number;

  // Per-second bucket — tokens replenish continuously
  private per_second_tokens: number;
  private last_refill_ms: number;

  // Per-day bucket — integer count, resets at UTC midnight
  private per_day_used: number;
  private day_resets_at_ms: number;

  // FIFO queue for callers waiting on the per-second bucket
  private queue: QueuedRequest[] = [];
  private drain_timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: RateLimiterConfig) {
    if (config.requests_per_second <= 0) {
      throw new Error('requests_per_second must be > 0');
    }
    if (config.requests_per_day !== undefined && config.requests_per_day <= 0) {
      throw new Error('requests_per_day must be > 0 if provided');
    }

    this.per_second_capacity = config.requests_per_second;
    this.per_second_refill_rate_per_ms = config.requests_per_second / 1000;
    this.per_day_limit = config.requests_per_day ?? null;
    this.now = config.now ?? Date.now;

    this.per_second_tokens = this.per_second_capacity;
    this.last_refill_ms = this.now();

    this.per_day_used = 0;
    this.day_resets_at_ms = nextUtcMidnight(this.last_refill_ms);
  }

  /**
   * Acquire one token. Resolves when a per-second token is available.
   * Rejects with RateLimitExceededError if the per-day cap is exhausted.
   *
   * Per-day check happens BEFORE queueing on per-second: no point waiting
   * 200ms for a token if we're going to fail the day check anyway.
   */
  async acquire(): Promise<void> {
    this.refill();

    // Day check first — fail fast on exhaustion, don't queue.
    if (this.per_day_limit !== null && this.per_day_used >= this.per_day_limit) {
      throw new RateLimitExceededError(
        'per_day',
        new Date(this.day_resets_at_ms).toISOString(),
      );
    }

    // Per-second: if a token is available, take it now.
    if (this.per_second_tokens >= 1) {
      this.per_second_tokens -= 1;
      this.per_day_used += 1;
      return;
    }

    // Otherwise queue and let the drain timer pick us up.
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.scheduleDrain();
    });
  }

  /**
   * Current limiter status, suitable for surfacing in adapter health() output.
   */
  status(): RateLimiterStatus {
    this.refill();
    return {
      per_second_capacity: this.per_second_capacity,
      per_second_available: this.per_second_tokens,
      per_day_limit: this.per_day_limit,
      per_day_used: this.per_day_used,
      per_day_resets_at: new Date(this.day_resets_at_ms).toISOString(),
    };
  }

  /**
   * Test-only: force the day counter forward. Real callers should never call this.
   */
  _resetDayForTest(): void {
    this.per_day_used = 0;
    this.day_resets_at_ms = nextUtcMidnight(this.now());
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private refill(): void {
    const now_ms = this.now();

    // Day rollover: reset counter if we've crossed UTC midnight.
    if (now_ms >= this.day_resets_at_ms) {
      this.per_day_used = 0;
      this.day_resets_at_ms = nextUtcMidnight(now_ms);
    }

    // Per-second: continuous refill, capped at capacity.
    const elapsed_ms = now_ms - this.last_refill_ms;
    if (elapsed_ms > 0) {
      const refilled = elapsed_ms * this.per_second_refill_rate_per_ms;
      this.per_second_tokens = Math.min(
        this.per_second_capacity,
        this.per_second_tokens + refilled,
      );
      this.last_refill_ms = now_ms;
    }
  }

  /**
   * Schedule the next drain attempt. Only one timer outstanding at a time.
   * Drain wakes when enough tokens have accumulated for the head-of-queue caller.
   */
  private scheduleDrain(): void {
    if (this.drain_timer !== null) return;
    if (this.queue.length === 0) return;

    this.refill();

    // Time until at least 1 token is available
    const tokens_needed = 1 - this.per_second_tokens;
    const ms_until_token =
      tokens_needed <= 0 ? 0 : Math.ceil(tokens_needed / this.per_second_refill_rate_per_ms);

    this.drain_timer = setTimeout(() => {
      this.drain_timer = null;
      this.drain();
    }, Math.max(ms_until_token, 1));
  }

  private drain(): void {
    this.refill();

    while (this.queue.length > 0 && this.per_second_tokens >= 1) {
      // Day check on every drain — the day could have rolled or could now be exhausted
      // (e.g. if test code modified the limit; in production it only ever increases used).
      if (this.per_day_limit !== null && this.per_day_used >= this.per_day_limit) {
        const retry_after = new Date(this.day_resets_at_ms).toISOString();
        // Reject everyone in the queue. Day-cap exhaustion is not a queue-able state.
        const queued = this.queue.splice(0, this.queue.length);
        for (const q of queued) {
          q.reject(new RateLimitExceededError('per_day', retry_after));
        }
        return;
      }

      const head = this.queue.shift();
      if (head === undefined) break; // defensive; loop guard already covers this
      this.per_second_tokens -= 1;
      this.per_day_used += 1;
      head.resolve();
    }

    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }
}
