/**
 * Adapter singleton for the API layer.
 *
 * Why a singleton:
 *   - The TokenBucketLimiter inside UnisatAdapter is stateful. A fresh
 *     adapter per request would create a fresh bucket and burst-violate
 *     Unisat's 5 req/sec limit immediately under any concurrent load.
 *   - The HTTP client is cheap to reuse and uses Node's keepalive pool
 *     when the same fetch instance is shared.
 *
 * Why lazy:
 *   - Tests import the route handlers without setting UNISAT_API_KEY. If
 *     construction happened at import time we'd crash before any test
 *     even runs. Lazy construction means routes that hit the adapter must
 *     have the env set; routes that don't (errors-only paths) work either way.
 *   - In Next.js dev mode, modules re-import on hot-reload. Lazy + module-scoped
 *     state means we get one adapter per worker process, which is what we want.
 *
 * When V2 adds Hiro/Satflow:
 *   - Each gets its own getXxxAdapter() function here.
 *   - The aggregator core (V2) takes all three adapters in its constructor.
 *   - This file stays the bootstrap boundary; route handlers above never
 *     read env directly.
 */

import { UnisatAdapter } from '@/adapters/unisat/index.js';

let _unisat: UnisatAdapter | undefined;

const DEFAULT_USER_AGENT = 'floorboard/0.0 (+https://github.com/TerraBloch/floorboard)';

export function getUnisatAdapter(): UnisatAdapter {
  if (_unisat) return _unisat;

  const api_key = process.env.UNISAT_API_KEY;
  if (!api_key || api_key.trim() === '') {
    throw new Error(
      'UNISAT_API_KEY env var is required. See .env.example.',
    );
  }

  _unisat = new UnisatAdapter({
    api_key,
    user_agent: process.env.FLOORBOARD_USER_AGENT ?? DEFAULT_USER_AGENT,
  });

  return _unisat;
}

/**
 * Test-only escape hatch: inject a pre-built adapter so route handler tests
 * don't have to monkey-patch process.env or wait for module re-imports.
 * Production code never calls this.
 */
export function __setUnisatAdapterForTests(adapter: UnisatAdapter | undefined): void {
  _unisat = adapter;
}
