// `pnpm user:dev <args>`: runs the user CLI against the dev-compose Postgres (127.0.0.1:5433),
// building DATABASE_URL from .env (same parsing as test-db.mjs). Example: pnpm user:dev create me@x.com --role ADMIN
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
const db = env.POSTGRES_DB || 'pulse'

const r = spawnSync('pnpm', ['--filter', '@pulse/db', 'user', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || `postgres://${user}:${pass}@127.0.0.1:5433/${db}` },
})
process.exit(r.status ?? 1)
