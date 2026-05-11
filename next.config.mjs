/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // API-only project for V1. The root page exists to satisfy the App Router's
  // expectation of a UI; everything user-facing lives under /v1/* as JSON.

  // The adapter code (src/adapters/**) uses explicit .js extensions on its
  // relative imports — this is the correct shape for ESM under
  // `"type": "module"` and is what vitest + tsc both expect. Webpack's
  // default resolver, however, doesn't know to look at .ts when .js is
  // requested. extensionAlias bridges that gap with no source changes.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
