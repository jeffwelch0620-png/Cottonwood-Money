import type { NextConfig } from 'next';

// The console calls the 8a API on the same origin; Next proxies /v1/* to it (no CORS, no tokens in URLs).
// API_URL is read at BUILD time (rewrites are compiled into the build), so set it for `next build`.
const API_URL = process.env.API_URL ?? 'http://localhost:3000';

const config: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${API_URL}/v1/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    }];
  },
};
export default config;
