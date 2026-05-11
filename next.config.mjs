/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // API-only project for V1. The root page exists to satisfy the App Router's
  // expectation of a UI; everything user-facing lives under /v1/* as JSON.
};

export default nextConfig;
