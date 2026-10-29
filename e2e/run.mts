// pnpm test:e2e: production build, isolated stack, Playwright, teardown (even on failure).
// Needs the dev services: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
import { spawnSync } from 'node:child_process'
import { down, up } from './stack.mts'

process.env.PULSE_NO_STANDALONE = '1'
const env = process.env
const run = (cmd: string) => spawnSync(cmd, { shell: true, stdio: 'inherit', env }).status ?? 1

let code = 0
try {
  if (!process.env.E2E_SKIP_BUILD) code = run('pnpm --filter @pulse/web build')
  if (code === 0) {
    await up()
    code = run(`pnpm exec playwright test -c e2e/playwright.config.ts ${process.argv.slice(2).join(' ')}`)
  }
} finally {
  await down()
}
process.exit(code)
