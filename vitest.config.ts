import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest config — minimal. The only thing we need from a config file is
 * the `@/*` path alias matching tsconfig.json's paths block, so route
 * handler imports stay short. Without this, vitest sees `@/lib/...` as
 * an unresolvable bare specifier.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
