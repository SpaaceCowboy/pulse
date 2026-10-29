// Runs the vitest suite including the Postgres/Redis integration tests against the
// loopback ports from docker-compose.dev.yml (credentials come from .env).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const user = env.POSTGRES_USER || 'pulse'
const pass = encodeURIComponent(env.POSTGRES_PASSWORD ?? '')

const r = spawnSync('pnpm', ['exec', 'vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgres://${user}:${pass}@127.0.0.1:5433/postgres`,
    TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380',
  },
})
process.exit(r.status ?? 1)
