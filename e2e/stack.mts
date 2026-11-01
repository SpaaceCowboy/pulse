// Isolated stack for the e2e run (started by run.ts): throwaway Postgres database + Redis db 1 on the dev-compose ports,
// fixture servers, the real worker (against e2e/targets.e2e.yaml) and a production `next start`.
// Nothing here touches the compose stack data.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { createDb, createUser, migrateUp, updateUser } from '@pulse/db'
import { generateApiToken, generateTotpSecret, hashPassword } from '@pulse/core'
import { execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { Redis } from 'ioredis'
import { E2E_HMAC_SECRET, PORT, STATE_FILE, type E2eState } from './env'

const root = resolve(import.meta.dirname, '..')
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)

function start(name: string, cmd: string, args: string[], extra: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(cmd, args, { cwd: root, shell: true, env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`))
  child.stderr?.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${name}] ${d}`))
  return child
}

async function waitFor(url: string, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timeout waiting for ${url}`)
}

export async function up(suite: 'dashboard' | 'alerts' = 'dashboard') {
  const alerts = suite === 'alerts'
  const user = env.POSTGRES_USER || 'pulse'
  const pass = encodeURIComponent(env.POSTGRES_PASSWORD ?? '')
  const base = `postgres://${user}:${pass}@127.0.0.1:5433`
  const dbName = `pulse_e2e_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ connectionString: `${base}/postgres` })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${dbName}`)
  await admin.end()
  const databaseUrl = `${base}/${dbName}`
  const redisUrl = 'redis://127.0.0.1:6380/1'

  const { db, pool } = createDb(databaseUrl)
  await migrateUp(pool)
  const accounts = {
    admin: { email: 'e2e-admin@pulse.test', password: 'e2e-admin-password-1', secret: generateTotpSecret(), role: 'ADMIN' as const },
    user: { email: 'e2e-user@pulse.test', password: 'e2e-user-password-1', secret: generateTotpSecret(), role: 'USER' as const },
  }
  for (const a of Object.values(accounts)) {
    await createUser(db, { email: a.email, passwordHash: await hashPassword(a.password), totpSecret: a.secret, role: a.role })
  }
  const userToken = generateApiToken()
  await updateUser(db, accounts.user.email, { apiTokenHash: userToken.hash })
  const adminToken = generateApiToken()
  await updateUser(db, accounts.admin.email, { apiTokenHash: adminToken.hash })
  await pool.end()

  const common = { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl }
  const alertEnv = {
    ALERTS_ENABLED: 'true',
    ALERTS_RECONCILE_MS: '2000',
    TELEGRAM_BOT_TOKEN: 'e2etoken',
    TELEGRAM_API_BASE: 'http://127.0.0.1:4110',
    PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    HMAC_INGEST_SECRET: E2E_HMAC_SECRET,
    WATCHDOG_URL: 'http://127.0.0.1:4110/watchdog',
  }
  const procs = {
    fixtures: start('fixtures', 'node', ['e2e/fixture-server.mjs'], {}),
    worker: start('worker', 'pnpm', ['--filter', '@pulse/worker', 'start'], {
      ...common,
      TARGETS_FILE: resolve(root, alerts ? 'e2e/targets.alerts.e2e.yaml' : 'e2e/targets.e2e.yaml'),
      ...(alerts ? alertEnv : {}),
    }),
    web: start('web', 'pnpm', ['--filter', '@pulse/web', 'exec', 'next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
      ...common,
      AUTH_SECRET: randomBytes(32).toString('base64'),
      HMAC_INGEST_SECRET: E2E_HMAC_SECRET,
      NODE_ENV: 'production',
    }),
  }
  const extra: ChildProcess[] = []
  if (alerts) {
    extra.push(start('telegram', 'node', ['e2e/fake-telegram.mjs'], {}))
    extra.push(
      start('probe', 'pnpm', ['--filter', '@pulse/worker', 'start'], {
        PROBE_ONLY: '1',
        PROBE_VANTAGE: 'e2e-probe',
        CORE_INGEST_URL: `http://127.0.0.1:${PORT}/api/ingest`,
        HMAC_INGEST_SECRET: E2E_HMAC_SECRET,
        TARGETS_FILE: resolve(root, 'e2e/targets.alerts.e2e.yaml'),
        PORT: '3002',
      }),
    )
  }
  await waitFor(`http://127.0.0.1:${PORT}/api/healthz`)
  if (alerts) await waitFor('http://127.0.0.1:4110/__log')
  await waitFor('http://127.0.0.1:4101/')

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      dbName,
      base,
      redisUrl,
      pids: [...Object.values(procs), ...extra].map((p) => p.pid),
      accounts,
      tokens: { user: userToken.token, admin: adminToken.token },
    }),
  )
}

export async function down() {
  if (!existsSync(STATE_FILE)) return
  const s: E2eState = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  for (const pid of s.pids) {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 1000))
  const redis = new Redis(s.redisUrl)
  await redis.flushdb() // db 1 is e2e-only
  redis.disconnect()
  const admin = new pg.Client({ connectionString: `${s.base}/postgres` })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${s.dbName} WITH (FORCE)`)
  await admin.end()
  rmSync(STATE_FILE, { force: true })
}
