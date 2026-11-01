// Incident notifications, driven by database state rather than by in-process events: every tick looks at
// open (and recently resolved) incidents and sends what is missing. A crash, a Telegram outage or a restart
// therefore only delays a message. One message per incident and user; the resolve is an edit of that message.
import { canSee, type StateEvent } from '@pulse/core'
import {
  activeMutes,
  insertAlertMessage,
  listAlertIncidents,
  listAlertMessages,
  listCheckInfo,
  listUsers,
  markAlertResolved,
  type AlertIncident,
  type Db,
  type UserRow,
} from '@pulse/db'
import type { Redis } from 'ioredis'
import type { StateStore } from '../state-store'
import { degradedCleared, degradedSustained, incidentOpened, incidentResolved, toPlain } from './format'
import type { Mailer } from './mailer'
import type { TelegramApi } from './telegram'

export interface NotifierDeps {
  db: Db
  redis: Redis
  store: StateStore
  telegram: TelegramApi
  mailer: Mailer | null
  publicUrl: string
  /** targets.yaml `maintenance` windows */
  inMaintenance: (targetId: string, now: Date) => boolean
  log?: (msg: string) => void
  now?: () => Date
}

interface Delivered {
  channel: 'telegram' | 'email'
  chatId: string | null
  messageId: number | null
}

const DEGRADED_MSG_KEY = (checkId: string, userId: number) => `pulse:degraded-msg:${checkId}:${userId}`
const DEGRADED_MSG_TTL_S = 7 * 86_400

export class Notifier {
  private running = false

  constructor(private readonly d: NotifierDeps) {}

  private get now() {
    return this.d.now?.() ?? new Date()
  }
  private log(m: string) {
    this.d.log?.(m)
  }

  /** Telegram first; email only when the Telegram send failed. A user without a linked chat gets nothing. */
  async deliver(user: UserRow, html: string, subject: string): Promise<Delivered | null> {
    if (!user.telegramChatId) return null
    try {
      const messageId = await this.d.telegram.sendMessage(user.telegramChatId, html)
      return { channel: 'telegram', chatId: user.telegramChatId, messageId }
    } catch (err) {
      this.log(`telegram send to user ${user.id} failed: ${(err as Error).message}`)
    }
    return this.emailFallback(user, subject, html)
  }

  private async emailFallback(user: UserRow, subject: string, html: string): Promise<Delivered | null> {
    if (!this.d.mailer) return null
    try {
      await this.d.mailer.send(user.email, subject, toPlain(html))
      this.log(`email fallback sent to user ${user.id}`)
      return { channel: 'email', chatId: null, messageId: null }
    } catch (err) {
      this.log(`email fallback to user ${user.id} failed: ${(err as Error).message}`)
      return null
    }
  }

  /** Single-flight: overlapping ticks (slow Telegram) never double-send. */
  async reconcile(): Promise<{ sent: number; resolved: number }> {
    if (this.running) return { sent: 0, resolved: 0 }
    this.running = true
    try {
      return await this.reconcileOnce()
    } finally {
      this.running = false
    }
  }

  private suppressed(inc: AlertIncident, mutes: Map<string, Date>, now: Date) {
    return mutes.has(inc.targetId) || this.d.inMaintenance(inc.targetId, now)
  }

  private async reconcileOnce() {
    const now = this.now
    const incidents = await listAlertIncidents(this.d.db, now)
    if (incidents.length === 0) return { sent: 0, resolved: 0 }
    const [users, mutes, messages] = await Promise.all([
      listUsers(this.d.db),
      activeMutes(this.d.db, now),
      listAlertMessages(this.d.db, incidents.map((i) => i.id)),
    ])
    const byKey = new Map(messages.map((m) => [`${m.incidentId}:${m.userId}`, m]))
    let sent = 0
    let resolved = 0

    for (const inc of incidents) {
      const text = {
        targetName: inc.targetName,
        checkKind: inc.checkKind,
        cause: inc.cause,
        openedAt: inc.openedAt,
        resolvedAt: inc.resolvedAt,
        url: this.d.publicUrl,
      }
      for (const user of users) {
        // authorization: the same scoping rule as the dashboard, so a USER never hears about an admin target
        if (!canSee(user, inc)) continue
        const row = byKey.get(`${inc.id}:${user.id}`)

        if (!inc.resolvedAt) {
          if (row || this.suppressed(inc, mutes, now)) continue
          const d = await this.deliver(user, incidentOpened(text), `[Pulse] ${inc.targetName} is DOWN`)
          if (!d) continue
          await insertAlertMessage(this.d.db, { incidentId: inc.id, userId: user.id, ...d })
          sent++
          continue
        }

        // resolved: edit the original message in place; never announce a recovery nobody heard the outage of
        if (!row || row.resolvedSentAt) continue
        const html = incidentResolved(text)
        let ok = false
        if (row.channel === 'telegram' && row.chatId && row.messageId != null) {
          try {
            await this.d.telegram.editMessage(row.chatId, row.messageId, html)
            ok = true
          } catch (err) {
            this.log(`telegram edit for incident ${inc.id} failed: ${(err as Error).message}`)
            ok = (await this.emailFallback(user, `[Pulse] ${inc.targetName} recovered`, html)) !== null
          }
        } else {
          ok = (await this.emailFallback(user, `[Pulse] ${inc.targetName} recovered`, html)) !== null
        }
        if (ok) {
          await markAlertResolved(this.d.db, inc.id, user.id, now)
          resolved++
        }
      }
    }
    return { sent, resolved }
  }

  /**
   * Degraded for > 15 min (state machine event). Not tied to an incident, so the message id lives in Redis.
   * A "regional" split (one vantage down) is deliberately silent: PLAN says no page, the digest lists it.
   */
  async onStateEvent(checkId: string, e: StateEvent): Promise<void> {
    if (e.type !== 'degraded_sustained' && e.type !== 'degraded_cleared') return
    const now = this.now
    const info = (await listCheckInfo(this.d.db)).find((c) => c.checkId === checkId)
    if (!info) return
    const last = (await this.d.store.get(checkId))?.last
    if (e.type === 'degraded_sustained' && last?.message?.startsWith('regional:')) return
    if (this.d.inMaintenance(info.targetId, now) || (await activeMutes(this.d.db, now)).has(info.targetId)) return

    for (const user of await listUsers(this.d.db)) {
      if (!canSee(user, { audience: info.audience }) || !user.telegramChatId) continue
      const key = DEGRADED_MSG_KEY(checkId, user.id)
      try {
        if (e.type === 'degraded_sustained') {
          const id = await this.d.telegram.sendMessage(
            user.telegramChatId,
            degradedSustained(info.targetName, info.kind, last?.message, this.d.publicUrl),
          )
          await this.d.redis.set(key, String(id), 'EX', DEGRADED_MSG_TTL_S)
        } else {
          const id = Number(await this.d.redis.get(key))
          if (!id) continue
          await this.d.telegram.editMessage(user.telegramChatId, id, degradedCleared(info.targetName, info.kind))
          await this.d.redis.del(key)
        }
      } catch (err) {
        this.log(`degraded notice for user ${user.id} failed: ${(err as Error).message}`)
      }
    }
  }
}
