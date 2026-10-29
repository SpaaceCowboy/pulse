import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const web = (p: string) => fileURLToPath(new URL(`./apps/web/src/${p}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: web('') },
      { find: /^server-only$/, replacement: web('testing/server-only-stub.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
  },
})
