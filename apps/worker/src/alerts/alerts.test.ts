// Integration tests on real Postgres + Redis (`pnpm test:db`); skipped otherwise.
// Covers the Phase 4 contract: role-based routing, one message per incident edited on resolve, mutes,
// maintenance, email only on Telegram failure, bot linking and authorization, heartbeats, regional vantages.
import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  closeIncident,
  createTestDb,
  createUser,
  migrateUp,
  openIncident,
  sha256,
  syncTargets,
  TEST_DATABASE_URL,
  upsertHeartbeat,
  pingHeartbeat,
} from '@pulse/db'
import { Bot, LINK_CODE_KEY } from './bot'
import { Notifier } from './notifier'
import type { TelegramApi, TgUpdate } from './telegram'
import { TelegramError } from './telegram'
import { StateStore } from '../state-store'
import { recordResult } from '../record'
import { evaluateHeartbeats } from '../heartbeat'

const REDIS_URL = process.env.TEST_REDIS_URL
const tag = randomBytes(3).toString('hex')

class FakeTelegram implements TelegramApi {
  sent: Array<{ chatId: string; id: number; text: string }> = []
  edits: Array<{ chatId: string; id: number; text: string }> = []
  failSend = false
  failEdit = false
  private n = 1000
  async sendMessage(chatId: string, text: string) {
    if (this.failSend) throw new TelegramError('send: 502', false)
    const id = ++this.n
    this.sent.push({ chatId, id, text })
    return id
  }
  async editMessage(chatId: string, id: number, text: string) {
    if (this.failEdit) throw new TelegramError('edit: 502', false)
    this.edits.push({ chatId, id, text })
  }
  async getUpdates(): Promise<TgUpdate[]> {
    return []
  }
  async deleteWebhook() {}
  to(chatId: string) {
    return this.sent.filter((m) => m.chatId === chatId)
  }
}

describe.skipIf(!TEST_DATABASE_URL || !REDIS_URL)('alerts', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  let redis: Redis
  let store: StateStore
  const ids = {
    roco: `site-${tag}`,
    admin: `vps-${tag}`,
  }
  const ROCO_NAME = `Roco Site ${tag}`
  const ADMIN_NAME = `Secret Proxy ${tag}`
  const rocoCheck = `${ids.roco}:0:http`
  const adminCheck = `${ids.admin}:0:http`
  const users = {} as Record<'admin' | 'user' | 'unlinked', { id: number; email: string; chat: string | null }>
  const keys: string[] = []

  const mkNotifier = (tg: FakeTelegram, over: Partial<ConstructorParameters<typeof Notifier>[0]> = {}) =>
    new Notifier({
      db: t.db,
      redis,
      store,
      telegram: tg,
      mailer: null,
      publicUrl: 'https://pulse.test',
      inMaintenance: () => false,
      ...over,
    })

  async function reset() {
    await t.pool.query('DELETE FROM alert_messages; DELETE FROM incidents; DELETE FROM mutes')
  }

  beforeAll(async () => {
    t = await createTestDb()
    await migrateUp(t.pool)
    redis = new Redis(REDIS_URL!)
    store = new StateStore(redis, `test:${tag}:state:`, `test:${tag}:vantage:`)
    const mk = (id: string, name: string, audience: 'roco' | 'admin', checkId: string, vantage = ['core']) => ({
      id,
      name,
      group: 'g',
      audience,
      tags: [],
      env: 'production',
      checks: [{ id: checkId, kind: 'http', config: {}, intervalS: 60, timeoutMs: 5000, vantage }],
    })
    await syncTargets(t.db, [mk(ids.roco, ROCO_NAME, 'roco', rocoCheck, ['core', 'hostvds']), mk(ids.admin, ADMIN_NAME, 'admin', adminCheck)])

    const mkUser = async (key: 'admin' | 'user' | 'unlinked', role: 'ADMIN' | 'USER', chat: string | null) => {
      const email = `${key}-${tag}@pulse.test`
      const u = await createUser(t.db, { email, passwordHash: 'x', totpSecret: 'x', role })
      if (chat) await t.pool.query('UPDATE users SET telegram_chat_id = $1 WHERE id = $2', [chat, u.id])
      users[key] = { id: u.id, email, chat }
    }
    await mkUser('admin', 'ADMIN', '100')
    await mkUser('user', 'USER', '200')
    await mkUser('unlinked', 'USER', null)
  })

  afterAll(async () => {
    const found = await redis.keys(`test:${tag}:*`)
    if (found.length || keys.length) await redis.del(...found, ...keys)
    redis.disconnect()
    await t.drop()
  })

  describe('routing and edit-in-place', () => {
    it('a roco incident reaches ADMIN and USER once each, and resolves by editing the same messages', async () => {
      await reset()
      const tg = new FakeTelegram()
      const n = mkNotifier(tg)
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date(), cause: 'HTTP 500' })

      expect(await n.reconcile()).toEqual({ sent: 2, resolved: 0 })
      expect(tg.to('100')).toHaveLength(1)
      expect(tg.to('200')).toHaveLength(1)
      expect(tg.sent[0]!.text).toContain(ROCO_NAME)
      expect(tg.sent[0]!.text).toContain('HTTP 500')

      // more ticks (and a "restarted" notifier) never duplicate
      await n.reconcile()
      await mkNotifier(tg).reconcile()
      expect(tg.sent).toHaveLength(2)

      await closeIncident(t.db, rocoCheck, new Date())
      expect(await n.reconcile()).toEqual({ sent: 0, resolved: 2 })
      expect(tg.sent).toHaveLength(2) // no new message
      expect(tg.edits).toHaveLength(2)
      expect(tg.edits.map((e) => e.id).sort()).toEqual(tg.sent.map((m) => m.id).sort())
      expect(tg.edits[0]!.text).toContain('recovered')

      await n.reconcile()
      expect(tg.edits).toHaveLength(2) // resolve edit is also once
    })

    it('an admin-only incident reaches ADMIN only; USER and unlinked users get nothing about it', async () => {
      await reset()
      const tg = new FakeTelegram()
      const n = mkNotifier(tg)
      await openIncident(t.db, { checkId: adminCheck, openedAt: new Date(), cause: 'xray unit failed' })
      expect(await n.reconcile()).toEqual({ sent: 1, resolved: 0 })
      expect(tg.to('100')).toHaveLength(1)
      expect(tg.to('200')).toHaveLength(0)
      await closeIncident(t.db, adminCheck, new Date())
      await n.reconcile()
      // nothing sent or edited to the USER's chat, in any form
      expect(JSON.stringify([...tg.sent, ...tg.edits].filter((m) => m.chatId === '200'))).not.toContain(ADMIN_NAME)
      expect([...tg.sent, ...tg.edits].filter((m) => m.chatId === '200')).toHaveLength(0)
    })

    it('never announces a recovery for an outage nobody was told about', async () => {
      await reset()
      const tg = new FakeTelegram()
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date(Date.now() - 600_000) })
      await closeIncident(t.db, rocoCheck, new Date())
      await mkNotifier(tg).reconcile()
      // the incident is resolved already and has no message rows: the notifier does not send an "open" for it
      expect(tg.sent).toHaveLength(0)
      expect(tg.edits).toHaveLength(0)
    })
  })

  describe('mutes and maintenance', () => {
    it('a muted target is not announced; unmuting announces a still-open incident', async () => {
      await reset()
      const tg = new FakeTelegram()
      const n = mkNotifier(tg)
      await t.pool.query("INSERT INTO mutes (target_id, until) VALUES ($1, now() + interval '2 hours')", [ids.roco])
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date() })
      await n.reconcile()
      expect(tg.sent).toHaveLength(0)
      await t.pool.query('DELETE FROM mutes')
      await n.reconcile()
      expect(tg.sent).toHaveLength(2)
    })

    it('an expired mute no longer suppresses', async () => {
      await reset()
      const tg = new FakeTelegram()
      await t.pool.query("INSERT INTO mutes (target_id, until) VALUES ($1, now() - interval '1 minute')", [ids.roco])
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date() })
      await mkNotifier(tg).reconcile()
      expect(tg.sent).toHaveLength(2)
    })

    it('a maintenance window suppresses', async () => {
      await reset()
      const tg = new FakeTelegram()
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date() })
      await mkNotifier(tg, { inMaintenance: (id) => id === ids.roco }).reconcile()
      expect(tg.sent).toHaveLength(0)
    })
  })

  describe('email fallback', () => {
    const mailbox = () => {
      const sent: Array<{ to: string; subject: string; text: string }> = []
      return { sent, mailer: { send: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) } }
    }

    it('no email while Telegram works', async () => {
      await reset()
      const tg = new FakeTelegram()
      const mb = mailbox()
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date() })
      await mkNotifier(tg, { mailer: mb.mailer }).reconcile()
      expect(mb.sent).toHaveLength(0)
    })

    it('when Telegram fails, exactly one email per linked user, and none again on later ticks', async () => {
      await reset()
      const tg = new FakeTelegram()
      tg.failSend = true
      const mb = mailbox()
      const n = mkNotifier(tg, { mailer: mb.mailer })
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date(), cause: 'boom' })
      await n.reconcile()
      await n.reconcile()
      expect(mb.sent.map((m) => m.to).sort()).toEqual([users.admin.email, users.user.email].sort())
      expect(mb.sent[0]!.text).toContain(ROCO_NAME)
      expect(mb.sent[0]!.text).not.toMatch(/<\/?b>/)

      // the user without a linked chat never gets email either (email is a fallback for Telegram failures)
      expect(mb.sent.some((m) => m.to === users.unlinked.email)).toBe(false)

      // the recovery also goes by email, because the original went by email
      await closeIncident(t.db, rocoCheck, new Date())
      await n.reconcile()
      expect(mb.sent).toHaveLength(4)
      expect(mb.sent.at(-1)!.subject).toContain('recovered')
    })

    it('a failed edit falls back to email and still marks the incident resolved once', async () => {
      await reset()
      const tg = new FakeTelegram()
      const mb = mailbox()
      const n = mkNotifier(tg, { mailer: mb.mailer })
      await openIncident(t.db, { checkId: adminCheck, openedAt: new Date() })
      await n.reconcile()
      await closeIncident(t.db, adminCheck, new Date())
      tg.failEdit = true
      await n.reconcile()
      await n.reconcile()
      expect(mb.sent).toHaveLength(1)
      expect(mb.sent[0]!.to).toBe(users.admin.email)
    })

    it('Telegram down and no mailer configured: nothing is lost, it is delivered once Telegram is back', async () => {
      await reset()
      const tg = new FakeTelegram()
      tg.failSend = true
      const n = mkNotifier(tg)
      await openIncident(t.db, { checkId: rocoCheck, openedAt: new Date() })
      await n.reconcile()
      expect(tg.sent).toHaveLength(0)
      tg.failSend = false
      await n.reconcile()
      expect(tg.sent).toHaveLength(2)
    })
  })

  describe('degraded notices', () => {
    const setLast = (checkId: string, message: string) =>
      store.set(checkId, {
        state: { phase: 'up', fails: 0, passes: 0, degradedSince: 1, degradedSustained: true, changedAt: 1 },
        last: { status: 'degraded', ts: Date.now(), message },
      })

    it('a sustained non-regional degradation notifies once and is edited when it clears', async () => {
      const tg = new FakeTelegram()
      const n = mkNotifier(tg)
      await setLast(rocoCheck, 'slow: 3200 ms')
      await n.onStateEvent(rocoCheck, { type: 'degraded_sustained' })
      expect(tg.sent).toHaveLength(2)
      expect(tg.sent[0]!.text).toContain('degraded')
      await n.onStateEvent(rocoCheck, { type: 'degraded_cleared' })
      expect(tg.edits).toHaveLength(2)
    })

    it('a regional split is silent (PLAN: no page)', async () => {
      const tg = new FakeTelegram()
      await setLast(rocoCheck, 'regional: down from hostvds')
      await mkNotifier(tg).onStateEvent(rocoCheck, { type: 'degraded_sustained' })
      expect(tg.sent).toHaveLength(0)
    })

    it('an admin target degrades for ADMIN only', async () => {
      const tg = new FakeTelegram()
      await setLast(adminCheck, 'slow')
      await mkNotifier(tg).onStateEvent(adminCheck, { type: 'degraded_sustained' })
      expect(tg.to('200')).toHaveLength(0)
      expect(tg.to('100')).toHaveLength(1)
    })
  })

  describe('bot', () => {
    const mkBot = (tg = new FakeTelegram()) => ({ tg, bot: new Bot({ db: t.db, redis, telegram: tg }) })
    const issue = async (userId: number, code = randomBytes(4).toString('hex').toUpperCase()) => {
      await redis.set(LINK_CODE_KEY(code), String(userId), 'EX', 600)
      keys.push(LINK_CODE_KEY(code))
      return code
    }

    it('/start <code> links the chat to the account, once', async () => {
      const { bot } = mkBot()
      const code = await issue(users.unlinked.id)
      const reply = await bot.handleText('300', 'private', `/start ${code}`)
      expect(reply).toContain('Linked')
      const row = await t.pool.query('SELECT telegram_chat_id FROM users WHERE id = $1', [users.unlinked.id])
      expect(row.rows[0].telegram_chat_id).toBe('300')
      // the code was consumed
      expect(await bot.handleText('301', 'private', `/start ${code}`)).toContain('invalid or expired')
      await t.pool.query('UPDATE users SET telegram_chat_id = NULL WHERE id = $1', [users.unlinked.id])
    })

    it('rejects wrong codes, group chats, and a chat that is already linked elsewhere', async () => {
      const { bot } = mkBot()
      expect(await bot.handleText('310', 'private', '/start NOPE1234')).toContain('invalid or expired')
      const code = await issue(users.unlinked.id)
      expect(await bot.handleText('311', 'group', `/start ${code}`)).toContain('private chat')
      const code2 = await issue(users.unlinked.id)
      expect(await bot.handleText('100', 'private', `/start ${code2}`)).toContain('already linked')
    })

    it('throttles code guessing per chat', async () => {
      const { bot } = mkBot()
      const replies: string[] = []
      for (let i = 0; i < 7; i++) replies.push((await bot.handleText('320', 'private', `/start GUESS00${i}`))!)
      expect(replies.at(-1)).toContain('Too many attempts')
      await redis.del('pulse:tg-attempts:320')
    })

    it('/mute works for ADMIN only; USER and strangers cannot mute and learn nothing', async () => {
      const { bot } = mkBot()
      expect(await bot.handleText('200', 'private', `/mute ${ids.roco} 2h`)).toBe('Not allowed.')
      expect(await bot.handleText('999', 'private', `/mute ${ids.roco} 2h`)).toBeNull()
      expect((await t.pool.query('SELECT 1 FROM mutes')).rowCount).toBe(0)

      const reply = await bot.handleText('100', 'private', `/mute ${ids.roco} 2h`)
      expect(reply).toContain('muted for 2h')
      const m = await t.pool.query('SELECT until, created_by FROM mutes WHERE target_id = $1', [ids.roco])
      expect(Number(m.rows[0].created_by)).toBe(users.admin.id)
      const left = new Date(m.rows[0].until).getTime() - Date.now()
      expect(left).toBeGreaterThan(119 * 60_000)
      expect(left).toBeLessThanOrEqual(120 * 60_000)

      expect(await bot.handleText('100', 'private', '/mutes')).toContain(ROCO_NAME)
      expect(await bot.handleText('100', 'private', `/unmute ${ids.roco}`)).toContain('unmuted')
      expect((await t.pool.query('SELECT 1 FROM mutes')).rowCount).toBe(0)
    })

    it('/mute validates the duration and the target', async () => {
      const { bot } = mkBot()
      expect(await bot.handleText('100', 'private', `/mute ${ids.roco} forever`)).toContain('duration')
      expect(await bot.handleText('100', 'private', `/mute ${ids.roco} 30d`)).toContain('duration')
      expect(await bot.handleText('100', 'private', '/mute nothing-like-this 2h')).toBe('No such target.')
      expect(await bot.handleText('100', 'private', `/mute ${tag} 2h`)).toContain('Ambiguous')
    })

    it('a muted target stops notifications end to end', async () => {
      await reset()
      const { bot } = mkBot()
      await bot.handleText('100', 'private', `/mute ${ids.admin} 1h`)
      const tg = new FakeTelegram()
      await openIncident(t.db, { checkId: adminCheck, openedAt: new Date() })
      await mkNotifier(tg).reconcile()
      expect(tg.sent).toHaveLength(0)
      await t.pool.query('DELETE FROM mutes')
    })
  })

  describe('heartbeats', () => {
    const hbCheck = `${ids.roco}:9:heartbeat`
    const token = `hb_${randomBytes(18).toString('base64url')}`

    beforeAll(async () => {
      await t.pool.query(
        "INSERT INTO checks (id, target_id, kind, config, interval_s, timeout_ms, vantage) VALUES ($1,$2,'heartbeat','{}',60,5000,'{push}')",
        [hbCheck, ids.roco],
      )
      await upsertHeartbeat(t.db, hbCheck, sha256(token), 600)
    })

    it('unknown tokens do nothing; a ping makes the check up; silence opens an incident; a ping closes it', async () => {
      expect(await pingHeartbeat(t.db, sha256('hb_nope'), { ok: true }, new Date())).toBeNull()
      const deps = { db: t.db, store }
      const T0 = Date.parse('2026-11-01T10:00:00Z')
      const at = (min: number) => new Date(T0 + min * 60_000)
      const incidents = async () => (await t.pool.query('SELECT resolved_at FROM incidents WHERE check_id = $1', [hbCheck])).rows

      expect(await pingHeartbeat(t.db, sha256(token), { ok: true }, at(0))).toBe(hbCheck)
      await evaluateHeartbeats(deps, at(1))
      expect((await store.get(hbCheck))!.last.status).toBe('up')

      // silence beyond the 10 min grace: three consecutive down evaluations open exactly one incident
      for (const m of [12, 13, 14]) await evaluateHeartbeats(deps, at(m))
      expect(await incidents()).toHaveLength(1)
      await evaluateHeartbeats(deps, at(15))
      expect(await incidents()).toHaveLength(1)

      // the job pings again: two passes close it
      await pingHeartbeat(t.db, sha256(token), { ok: true }, at(15.5))
      await evaluateHeartbeats(deps, at(16))
      await evaluateHeartbeats(deps, at(17))
      const rows = await incidents()
      expect(rows).toHaveLength(1)
      expect(rows[0].resolved_at).not.toBeNull()
    })

    it('a ping that reports failure counts as down immediately', async () => {
      await t.pool.query('DELETE FROM incidents WHERE check_id = $1', [hbCheck])
      await store.set(hbCheck, { state: { phase: 'up', fails: 0, passes: 0, degradedSince: null, degradedSustained: false, changedAt: 0 }, last: { status: 'up', ts: 1 } })
      const T0 = Date.parse('2026-11-02T10:00:00Z')
      await pingHeartbeat(t.db, sha256(token), { ok: false, message: 'exit 2' }, new Date(T0))
      for (const m of [1, 2, 3]) await evaluateHeartbeats({ db: t.db, store }, new Date(T0 + m * 60_000))
      const rows = (await t.pool.query('SELECT cause FROM incidents WHERE check_id = $1', [hbCheck])).rows
      expect(rows).toHaveLength(1)
      expect(rows[0].cause).toContain('exit 2')
    })
  })

  describe('vantages (second probe)', () => {
    const T0 = Date.parse('2026-11-03T10:00:00Z')
    const at = (i: number) => new Date(T0 + i * 60_000)
    const ctx = { expected: ['core', 'hostvds'], staleAfterMs: 180_000 }
    const incidents = async () => (await t.pool.query('SELECT 1 FROM incidents WHERE check_id = $1', [rocoCheck])).rowCount

    async function fresh() {
      await t.pool.query('DELETE FROM incidents WHERE check_id = $1', [rocoCheck])
      await redis.del(`test:${tag}:state:${rocoCheck}`, `test:${tag}:vantage:${rocoCheck}`)
    }

    it('probe network blocked (only the probe says down) is "regional": degraded, never an incident', async () => {
      await fresh()
      for (let i = 0; i < 8; i++) {
        await store.setVantage(rocoCheck, 'hostvds', { status: 'down', ts: at(i).getTime(), message: 'connect timeout' })
        const { state } = await recordResult({ db: t.db, store }, rocoCheck, { status: 'up', latencyMs: 40 }, at(i), ctx)
        expect(state.phase).toBe('up')
      }
      expect(await incidents()).toBe(0)
      expect((await store.get(rocoCheck))!.last).toMatchObject({ status: 'degraded', message: 'regional: down from hostvds' })
    })

    it('both vantages down for 3 rounds opens one incident; recovery closes it', async () => {
      await fresh()
      for (let i = 0; i < 3; i++) {
        await store.setVantage(rocoCheck, 'hostvds', { status: 'down', ts: at(i).getTime() })
        await recordResult({ db: t.db, store }, rocoCheck, { status: 'down', message: 'HTTP 500' }, at(i), ctx)
      }
      expect(await incidents()).toBe(1)
      for (let i = 3; i < 5; i++) {
        await store.setVantage(rocoCheck, 'hostvds', { status: 'up', ts: at(i).getTime() })
        await recordResult({ db: t.db, store }, rocoCheck, { status: 'up' }, at(i), ctx)
      }
      expect((await t.pool.query('SELECT resolved_at FROM incidents WHERE check_id = $1', [rocoCheck])).rows[0].resolved_at).not.toBeNull()
    })

    it('a stale probe result is ignored, so a dead probe cannot hide a real outage', async () => {
      await fresh()
      await store.setVantage(rocoCheck, 'hostvds', { status: 'up', ts: at(-60).getTime() }) // an hour old
      for (let i = 0; i < 3; i++) await recordResult({ db: t.db, store }, rocoCheck, { status: 'down' }, at(i), ctx)
      expect(await incidents()).toBe(1)
    })

    it('a result from a vantage that is not expected does not vote', async () => {
      await fresh()
      await store.setVantage(rocoCheck, 'rogue', { status: 'up', ts: at(0).getTime() })
      for (let i = 0; i < 3; i++) await recordResult({ db: t.db, store }, rocoCheck, { status: 'down' }, at(i), ctx)
      expect(await incidents()).toBe(1)
    })

    it('state events are reported through onEvent after they are persisted', async () => {
      await fresh()
      const seen: string[] = []
      const deps = { db: t.db, store, onEvent: (_c: string, e: { type: string }) => void seen.push(e.type) }
      for (let i = 0; i < 3; i++) await recordResult(deps, rocoCheck, { status: 'down' }, at(i), { expected: ['core'] })
      expect(seen).toEqual(['open_incident'])
    })
  })
})
