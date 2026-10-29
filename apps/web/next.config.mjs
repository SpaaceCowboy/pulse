import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // monorepo root, so the standalone trace includes workspace packages
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
}
