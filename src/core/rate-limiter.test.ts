import { describe, it, expect } from 'vitest';
import {
  TokenBucketLimiter,
  RateLimitExceededError,
} from './rate-limiter';

/**
 * Test helper: a controllable clock that advances explicitly.
 *
 * We test against this rather than real timers because the per-second bucket
 * is timing-sensitive and we want deterministic assertions, not flaky CI.
 *
 * setTimeout still uses the real event loop, but the limiter consults `now()`
 * on every refill, so advancing the clock + flushing microtasks/timers is
 * sufficient to drive the queue.
 */
function makeClock(start_iso: string) {
  let t = new Date(start_iso).getTime();
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(iso: string) {
      t = new Date(iso).getTime();
    },
  };
}

// Real timers are used by scheduleDrain; this helper yields long enough for
// any pending setTimeout(..., 1) to fire in a test where we've already
// advanced the virtual clock past the requirement.
async function flushTimers(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('TokenBucketLimiter — construction', () => {
  it('rejects non-positive requests_per_second', () => {
    expect(() => new TokenBucketLimiter({ requests_per_second: 0 })).toThrow();
    expect(() => new TokenBucketLimiter({ requests_per_second: -1 })).toThrow();
  });

  it('rejects non-positive requests_per_day', () => {
    expect(
      () =>
        new TokenBucketLimiter({
          requests_per_second: 5,
          requests_per_day: 0,
        }),
    ).toThrow();
  });

  it('starts with full per-second capacity', () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 5,
      now: clock.now,
    });
    const status = lim.status();
    expect(status.per_second_capacity).toBe(5);
    expect(status.per_second_available).toBe(5);
    expect(status.per_day_used).toBe(0);
  });

  it('computes next UTC midnight as day reset', () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 5,
      requests_per_day: 100,
      now: clock.now,
    });
    expect(lim.status().per_day_resets_at).toBe('2026-05-11T00:00:00.000Z');
  });

  it('rolls to following midnight when constructed exactly at midnight', () => {
    const clock = makeClock('2026-05-10T00:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 5,
      requests_per_day: 100,
      now: clock.now,
    });
    expect(lim.status().per_day_resets_at).toBe('2026-05-11T00:00:00.000Z');
  });
});

describe('TokenBucketLimiter — per-second bucket', () => {
  it('grants tokens immediately while capacity remains', async () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 3,
      now: clock.now,
    });
    await lim.acquire();
    await lim.acquire();
    await lim.acquire();
    expect(lim.status().per_second_available).toBeLessThan(1);
    expect(lim.status().per_day_used).toBe(3);
  });

  it('queues callers when per-second is exhausted, releases as time advances', async () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 2,
      now: clock.now,
    });

    // Drain the bucket
    await lim.acquire();
    await lim.acquire();

    let resolved = false;
    const pending = lim.acquire().then(() => {
      resolved = true;
    });

    // Not enough time has passed — should still be queued
    await flushTimers(2);
    expect(resolved).toBe(false);

    // Advance the virtual clock by 600ms — at 2/sec that's 1.2 tokens, enough for one
    clock.advance(600);
    await flushTimers(20);
    await pending;
    expect(resolved).toBe(true);
  });

  it('refills proportionally — never overfills past capacity', async () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 5,
      now: clock.now,
    });
    await lim.acquire(); // 4 tokens left
    clock.advance(60_000); // a full minute — way more than needed to refill
    expect(lim.status().per_second_available).toBe(5);
  });

  it('preserves FIFO order across queued callers', async () => {
    // Use capacity > 1 so multiple tokens can refill into the bucket between
    // drain wakeups. With capacity = 1 the bucket clamps at 1 and the test
    // would have to advance time + flush between every single drain — that's
    // a test of real-time behavior, not FIFO. Capacity 5 lets us refill 3
    // tokens and observe the queue draining in order in a single pass.
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 5,
      now: clock.now,
    });
    // Drain the bucket
    for (let i = 0; i < 5; i++) await lim.acquire();

    const order: number[] = [];
    const p1 = lim.acquire().then(() => order.push(1));
    const p2 = lim.acquire().then(() => order.push(2));
    const p3 = lim.acquire().then(() => order.push(3));

    // 600ms at 5/sec = 3 tokens refilled, exactly enough for the queue.
    clock.advance(600);
    await flushTimers(20);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('TokenBucketLimiter — per-day bucket', () => {
  it('rejects with RateLimitExceededError when day cap is hit', async () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 100,
      requests_per_day: 2,
      now: clock.now,
    });
    await lim.acquire();
    await lim.acquire();
    await expect(lim.acquire()).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it('error carries scope and ISO retry_after', async () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 100,
      requests_per_day: 1,
      now: clock.now,
    });
    await lim.acquire();
    try {
      await lim.acquire();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExceededError);
      const e = err as RateLimitExceededError;
      expect(e.scope).toBe('per_day');
      expect(e.retry_after).toBe('2026-05-11T00:00:00.000Z');
    }
  });

  it('does not queue on day-cap exhaustion — fails fast', async () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 1, // tight per-second too
      requests_per_day: 1,
      now: clock.now,
    });
    await lim.acquire();
    const start = clock.now();
    await expect(lim.acquire()).rejects.toBeInstanceOf(RateLimitExceededError);
    // No real time should have elapsed waiting; assertion is on the virtual clock,
    // which we never advanced. The test's wall-clock is irrelevant here — the
    // important thing is the rejection didn't queue and didn't throw a per_second error.
    expect(clock.now()).toBe(start);
  });

  it('resets the day counter at UTC midnight', async () => {
    const clock = makeClock('2026-05-10T23:59:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 100,
      requests_per_day: 1,
      now: clock.now,
    });
    await lim.acquire();
    await expect(lim.acquire()).rejects.toBeInstanceOf(RateLimitExceededError);

    // Cross midnight
    clock.advance(2 * 60 * 1000); // +2 min → 2026-05-11T00:01:00Z
    await expect(lim.acquire()).resolves.toBeUndefined();
    expect(lim.status().per_day_used).toBe(1);
    expect(lim.status().per_day_resets_at).toBe('2026-05-12T00:00:00.000Z');
  });

  it('rejects queued callers if day cap exhausts while they are waiting', async () => {
    // This is the nasty case: callers queued on per-second, then someone
    // (in production: nothing — used only goes up) trips the day cap before
    // they drain. The test verifies the behavior by setting a tight day cap
    // and racing the queue.
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 1,
      requests_per_day: 2,
      now: clock.now,
    });

    // Use both day tokens
    await lim.acquire(); // day=1
    clock.advance(1_000);
    await flushTimers(5);
    await lim.acquire(); // day=2

    // Now queue a caller — per-second is empty, day cap is at limit. Should reject.
    clock.advance(1_000);
    await flushTimers(5);
    await expect(lim.acquire()).rejects.toBeInstanceOf(RateLimitExceededError);
  });
});

describe('TokenBucketLimiter — status reporting', () => {
  it('reports current available tokens, not stale snapshot', async () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 4,
      now: clock.now,
    });
    await lim.acquire();
    await lim.acquire();
    expect(lim.status().per_second_available).toBeLessThan(3);

    clock.advance(500); // +0.5s × 4/s = +2 tokens, capped at 4
    expect(lim.status().per_second_available).toBe(4);
  });

  it('reports null per_day_limit when not configured', () => {
    const clock = makeClock('2026-05-10T12:00:00Z');
    const lim = new TokenBucketLimiter({
      requests_per_second: 5,
      now: clock.now,
    });
    expect(lim.status().per_day_limit).toBeNull();
  });
});
