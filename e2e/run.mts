// pnpm test:e2e: production build, isolated stack, Playwright, teardown (even on failure).
// Needs the dev services: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
import { spawnSync } from 'node:child_process'
import { down, up } from './stack.mts'

process.env.PULSE_NO_STANDALONE = '1'
const env = process.env
const run = (cmd: string) => spawnSync(cmd, { shell: true, stdio: 'inherit', env }).status ?? 1

let code = 0
if (!process.env.E2E_SKIP_BUILD) code = run('pnpm --filter @pulse/web build')

// Two isolated stacks, one after the other: the dashboard suite, then the alerts suite (fake Telegram, real probe).
const suites: Array<[Parameters<typeof up>[0], string]> = [
  ['dashboard', 'dashboard.spec.ts'],
  ['alerts', 'alerts.spec.ts'],
]
const only = process.env.E2E_SUITE
for (const [suite, spec] of suites) {
  if (code !== 0 || (only && only !== suite)) continue
  try {
    await up(suite)
    code = run(`pnpm exec playwright test -c e2e/playwright.config.ts ${spec} ${process.argv.slice(2).join(' ')}`)
  } finally {
    await down()
  }
}
process.exit(code)
