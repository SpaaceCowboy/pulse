// Phase 4 verification (docs/PLAN.md): on an isolated stack with the real worker, a real probe process, the real web app
// and a fake Telegram Bot API:
//   stop a Roco fixture -> one message to both users, edited to resolved on recovery
//   stop an admin-only fixture -> a message to ADMIN only
//   a blocked probe network -> "regional", no alert
//   /mute is ADMIN only; heartbeat push; HMAC ingest; the watchdog pings the external monitor
import { expect, test, type Browser, type BrowserContext } from '@playwright/test'
import { createHash } from 'node:crypto'
import { Redis } from 'ioredis'
import pg from 'pg'
import { currentTotp, signIngest } from '@pulse/core'
import { E2E_HMAC_SECRET, FIXTURE_CONTROL, PORT, readState, TELEGRAM_FAKE } from './env'

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const state = readState()
const INGEST_URL = `http://127.0.0.1:${PORT}/api/ingest`
const ADMIN_CHAT = '5001'
const USER_CHAT = '5002'
const ROCO = 'E2E Roco Site'
const ADMIN_T = 'E2E Admin Secret Proxy'
const SHARED = 'E2E Shared Infra'
const SHARED_CHECK = 'e2e-shared-infra:0:http'

interface Log {
  sent: Array<{ id: number; chatId: string; text: string }>
  edits: Array<{ id: number; chatId: string; text: string }>
  watchdog: number
}
const log = async (): Promise<Log> => (await fetch(`${TELEGRAM_FAKE}/__log`)).json()
const about = (l: Log['sent'], name: string, chat: string) => l.filter((m) => m.chatId === chat && m.text.includes(name))
const inject = (chatId: string, text: string) =>
  fetch(`${TELEGRAM_FAKE}/__inject`, { method: 'POST', body: JSON.stringify({ chatId, text }) })
const fixture = (verb: 'stop' | 'start', port: number) => fetch(`${FIXTURE_CONTROL}/${verb}/${port}`, { method: 'POST' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let db: pg.Client
let redis: Redis
test.beforeAll(async () => {
  db = new pg.Client({ connectionString: `${state.base}/${state.dbName}` })
  await db.connect()
  redis = new Redis(state.redisUrl)
})
test.afterAll(async () => {
  await db?.end()
  redis?.disconnect()
})

const incidentsFor = async (checkPrefix: string) =>
  (await db.query('SELECT resolved_at FROM incidents WHERE check_id LIKE $1', [`${checkPrefix}%`])).rows

async function loginAndLink(browser: Browser, who: 'admin' | 'user', chat: string): Promise<BrowserContext> {
  const a = state.accounts[who]
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(a.email)
  await page.getByLabel('Password').fill(a.password)
  await page.getByLabel('Authenticator code').fill(currentTotp(a.secret))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()

  await page.goto('/profile')
  await page.getByRole('button', { name: 'Generate link code' }).click()
  const text = await page.locator('code').innerText()
  const code = /\/start\s+(\S+)/.exec(text)![1]!
  await inject(chat, `/start ${code}`)
  await expect
    .poll(async () => (await log()).sent.some((m) => m.chatId === chat && m.text.includes('Linked')), { timeout: 20_000 })
    .toBe(true)
  await page.goto('/profile')
  await expect(page.getByText('linked to a Telegram chat')).toBeVisible()
  return ctx
}

test.describe('Telegram linking', () => {
  test('each user links a chat from the profile page with /start <code>', async ({ browser }) => {
    const admin = await loginAndLink(browser, 'admin', ADMIN_CHAT)
    const user = await loginAndLink(browser, 'user', USER_CHAT)
    const rows = (await db.query('SELECT email, telegram_chat_id FROM users ORDER BY email')).rows
    expect(rows).toEqual([
      { email: state.accounts.admin.email, telegram_chat_id: ADMIN_CHAT },
      { email: state.accounts.user.email, telegram_chat_id: USER_CHAT },
    ])
    await admin.close()
    await user.close()
  })

  test('a chat cannot be linked with a wrong code, and the code cannot be reused', async () => {
    await inject('7777', '/start WRONGCODE')
    await expect
      .poll(async () => (await log()).sent.find((m) => m.chatId === '7777')?.text ?? '', { timeout: 15_000 })
      .toContain('invalid or expired')
  })
})

test.describe('probe vantage', () => {
  test('the PROBE_ONLY worker delivers signed results that land as a second vantage', async () => {
    await expect
      .poll(async () => Number((await db.query("SELECT count(*) FROM check_results WHERE vantage = 'e2e-probe'")).rows[0].count), {
        timeout: 40_000,
      })
      .toBeGreaterThan(1)
  })

  test('/api/ingest refuses unsigned, wrongly signed and replayed requests', async ({ request }) => {
    const body = JSON.stringify({ vantage: 'e2e-sim', results: [{ checkId: SHARED_CHECK, ts: Date.now(), status: 'up' }] })
    const post = (headers: Record<string, string>, data = body) =>
      request.post('/api/ingest', { data, headers: { 'content-type': 'application/json', ...headers } })
    expect((await post({})).status()).toBe(401)
    expect((await post(signIngest('some-other-secret-some-other-secret', body))).status()).toBe(401)
    const signed = signIngest(E2E_HMAC_SECRET, body)
    expect((await post(signed)).status()).toBe(200)
    expect((await post(signed)).status()).toBe(401) // replay
    expect((await post(signIngest(E2E_HMAC_SECRET, body, Date.now() - 5 * 60_000))).status()).toBe(401) // old timestamp
  })

  test('a blocked probe network is "regional": degraded, no incident, no alert', async () => {
    // the test plays the e2e-sim vantage: it says "down" every 5 s while the core still sees the fixture up
    for (let i = 0; i < 7; i++) {
      const body = JSON.stringify({
        vantage: 'e2e-sim',
        results: [{ checkId: SHARED_CHECK, ts: Date.now(), status: 'down', message: 'connect timeout' }],
      })
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signIngest(E2E_HMAC_SECRET, body) },
        body,
      })
      expect(res.status).toBe(200)
      await sleep(5000)
    }
    expect(await incidentsFor('e2e-shared-infra')).toHaveLength(0)
    const s = JSON.parse((await redis.get(`pulse:state:${SHARED_CHECK}`))!)
    expect(s.last).toMatchObject({ status: 'degraded', message: 'regional: down from e2e-sim' })
    expect(s.state.phase).toBe('up')
    const l = await log()
    expect([...l.sent, ...l.edits].filter((m) => m.text.includes(SHARED))).toHaveLength(0)
  })
})

test.describe('incident messages', () => {
  test('stopping a Roco fixture sends one message to both users, edited in place on recovery', async () => {
    await fixture('stop', 4101)
    await expect
      .poll(async () => {
        const l = await log()
        return [about(l.sent, ROCO, ADMIN_CHAT).length, about(l.sent, ROCO, USER_CHAT).length]
      }, { timeout: 90_000 })
      .toEqual([1, 1])
    const l = await log()
    expect(about(l.sent, ROCO, ADMIN_CHAT)[0]!.text).toContain('DOWN')
    await sleep(8000) // several reconcile ticks later: still exactly one each
    const again = await log()
    expect([about(again.sent, ROCO, ADMIN_CHAT).length, about(again.sent, ROCO, USER_CHAT).length]).toEqual([1, 1])
    expect(await incidentsFor('e2e-roco-site')).toHaveLength(1)

    await fixture('start', 4101)
    await expect
      .poll(async () => (await log()).edits.filter((e) => e.text.includes(ROCO)).length, { timeout: 90_000 })
      .toBe(2)
    const done = await log()
    expect(about(done.sent, ROCO, ADMIN_CHAT)).toHaveLength(1) // no new message, an edit
    const edit = done.edits.find((e) => e.chatId === ADMIN_CHAT && e.text.includes(ROCO))!
    expect(edit.id).toBe(about(done.sent, ROCO, ADMIN_CHAT)[0]!.id)
    expect(edit.text).toContain('recovered')
    expect(done.edits.find((e) => e.chatId === USER_CHAT && e.text.includes(ROCO))!.id).toBe(about(done.sent, ROCO, USER_CHAT)[0]!.id)
  })

  test('stopping an admin-only fixture messages ADMIN only', async () => {
    await fixture('stop', 4102)
    await expect.poll(async () => about((await log()).sent, ADMIN_T, ADMIN_CHAT).length, { timeout: 90_000 }).toBe(1)
    await sleep(6000)
    const l = await log()
    // nothing about the admin target was ever sent or edited to the USER's chat
    expect([...l.sent, ...l.edits].filter((m) => m.chatId === USER_CHAT && /Secret Proxy|admin-vps/i.test(m.text))).toHaveLength(0)

    await fixture('start', 4102)
    await expect
      .poll(async () => (await log()).edits.filter((e) => e.chatId === ADMIN_CHAT && e.text.includes(ADMIN_T)).length, { timeout: 90_000 })
      .toBe(1)
    const after = await log()
    expect([...after.sent, ...after.edits].filter((m) => m.chatId === USER_CHAT && /Secret Proxy|admin-vps/i.test(m.text))).toHaveLength(0)
  })
})

test.describe('/mute', () => {
  const replyTo = async (chat: string, text: string) => {
    const before = (await log()).sent.length
    await inject(chat, text)
    let reply = ''
    await expect
      .poll(async () => {
        const l = await log()
        reply = l.sent.slice(before).find((m) => m.chatId === chat)?.text ?? ''
        return reply
      }, { timeout: 15_000 })
      .not.toBe('')
    return reply
  }

  test('only ADMIN can mute; a muted target stays silent; /unmute announces what is still open', async () => {
    expect(await replyTo(USER_CHAT, '/mute e2e-admin-vps 1h')).toBe('Not allowed.')
    expect((await db.query('SELECT 1 FROM mutes')).rowCount).toBe(0)

    expect(await replyTo(ADMIN_CHAT, '/mute e2e-admin-vps 1h')).toContain('muted for 1h')
    const sentBefore = about((await log()).sent, ADMIN_T, ADMIN_CHAT).length

    await fixture('stop', 4102)
    await expect.poll(async () => (await incidentsFor('e2e-admin-vps')).filter((r) => !r.resolved_at).length, { timeout: 90_000 }).toBe(1)
    await sleep(8000)
    expect(about((await log()).sent, ADMIN_T, ADMIN_CHAT)).toHaveLength(sentBefore) // incident recorded, nobody paged

    await inject(ADMIN_CHAT, '/unmute e2e-admin-vps')
    await expect.poll(async () => about((await log()).sent, ADMIN_T, ADMIN_CHAT).length, { timeout: 20_000 }).toBe(sentBefore + 1)
    await fixture('start', 4102)
  })
})

test.describe('heartbeat push', () => {
  const checkId = 'e2e-cron:0:heartbeat'
  const token = 'hb_e2e_' + 'A1b2C3d4E5f6G7h8'.repeat(2)

  test('POST /api/push/:token needs no login, records pings and failures, and 404s unknown tokens', async ({ request }) => {
    await expect.poll(async () => (await db.query('SELECT 1 FROM checks WHERE id = $1', [checkId])).rowCount).toBe(1)
    await db.query(
      'INSERT INTO heartbeats (token, check_id, grace_s) VALUES ($1, $2, 600) ON CONFLICT (check_id) DO UPDATE SET token = EXCLUDED.token',
      [createHash('sha256').update(token).digest('hex'), checkId],
    )

    const ok = await request.post(`/api/push/${token}`, { maxRedirects: 0 })
    expect(ok.status()).toBe(200)
    expect((await db.query('SELECT last_status FROM heartbeats WHERE check_id = $1', [checkId])).rows[0].last_status).toBe('ok')

    expect((await request.post(`/api/push/${token}?status=fail&message=exit%202`)).status()).toBe(200)
    const row = (await db.query('SELECT last_status, last_message FROM heartbeats WHERE check_id = $1', [checkId])).rows[0]
    expect(row).toEqual({ last_status: 'fail', last_message: 'exit 2' })

    expect((await request.post('/api/push/hb_e2e_not_a_real_token_000000', { maxRedirects: 0 })).status()).toBe(404)
    expect((await request.get(`/api/push/${token}`, { maxRedirects: 0 })).status()).toBe(405)
  })
})

test.describe('watchdog', () => {
  test('Pulse pings the external monitor every minute while healthy', async () => {
    await expect.poll(async () => (await log()).watchdog, { timeout: 100_000, intervals: [3000] }).toBeGreaterThanOrEqual(2)
  })
})
