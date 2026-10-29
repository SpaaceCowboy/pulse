import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
export default {
  // Docker image uses standalone. PULSE_NO_STANDALONE=1 skips it for local builds on Windows, where the
  // standalone trace cannot create symlinks without developer mode.
  output: process.env.PULSE_NO_STANDALONE ? undefined : 'standalone',
  // monorepo root, so the standalone trace includes workspace packages
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  transpilePackages: ['@pulse/core', '@pulse/db'],
  serverExternalPackages: ['pg', 'ioredis'],
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }]
  },
}
