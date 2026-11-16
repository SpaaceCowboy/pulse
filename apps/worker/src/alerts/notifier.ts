// Incident notifications, driven by database state rather than by in-process events: every tick looks at
// open (and recently resolved) incidents and sends what is missing. A crash, a Telegram outage or a restart
// therefore only delays a message. One message per incident and user; the resolve is an edit of that message.
// Incidents on targets that share a `host` (targets.yaml) are announced together: they share one Telegram message
// (rows with the same chat_id + message_id), which is re-rendered as members open and resolve.
import { canSee, type StateEvent } from '@pulse/core'
import {
  activeMutes,
  insertAlertMessage,
  listAlertIncidents,
  listAlertMessages,
  listCheckInfo,
  listRemovedAlertMessages,
  listUsers,
  markAlertResolved,
  type AlertIncident,
  type Db,
  type UserRow,
} from '@pulse/db'
import type { Redis } from 'ioredis'
import type { StateStore } from '../state-store'
import {
  degradedCleared,
  degradedSustained,
  incidentGroup,
  incidentOpened,
  incidentRemoved,
  incidentResolved,
  toPlain,
  type IncidentText,
} from './format'
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
  /** targets.yaml `host`: incidents on targets with the same host go out as one message. Undefined = never grouped. */
  hostOf?: (targetId: string) => string | undefined
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

  private textOf(inc: AlertIncident): IncidentText {
    return {
      targetName: inc.targetName,
      checkKind: inc.checkKind,
      cause: inc.cause,
      openedAt: inc.openedAt,
      resolvedAt: inc.resolvedAt,
      url: this.d.publicUrl,
    }
  }

  private async reconcileOnce() {
    const now = this.now
    let resolved = await this.reconcileRemoved(now)
    const incidents = await listAlertIncidents(this.d.db, now)
    if (incidents.length === 0) return { sent: 0, resolved }
    const [users, mutes, messages] = await Promise.all([
      listUsers(this.d.db),
      activeMutes(this.d.db, now),
      listAlertMessages(this.d.db, incidents.map((i) => i.id)),
    ])
    const byKey = new Map(messages.map((m) => [`${m.incidentId}:${m.userId}`, m]))
    let sent = 0

    for (const user of users) {
      // authorization: the same scoping rule as the dashboard, so a USER never hears about an admin target.
      // Everything below (grouping included) only ever sees what this user may see.
      const visible = incidents.filter((inc) => canSee(user, inc))
      const rowOf = (inc: AlertIncident) => byKey.get(`${inc.id}:${user.id}`)

      // 1. new outages, grouped by host
      const groups = new Map<string, AlertIncident[]>()
      for (const inc of visible) {
        if (inc.resolvedAt || rowOf(inc) || this.suppressed(inc, mutes, now)) continue
        const host = this.d.hostOf?.(inc.targetId)
        const key = host ? `host:${host}` : `incident:${inc.id}`
        groups.set(key, [...(groups.get(key) ?? []), inc])
      }
      for (const [key, fresh] of groups) {
        const host = key.startsWith('host:') ? key.slice(5) : undefined
        const live = host ? this.liveGroupMessage(visible, rowOf, host) : undefined
        if (live) {
          // another target on this host is already announced: add to that message instead of paging again
          const members = visible.filter((i) => rowOf(i)?.chatId === live.chatId && rowOf(i)?.messageId === live.messageId)
          try {
            await this.d.telegram.editMessage(live.chatId, live.messageId, incidentGroup([...members, ...fresh].map((i) => this.textOf(i)), this.d.publicUrl))
            for (const inc of fresh) await this.record(inc, user, { channel: 'telegram', ...live })
            sent += fresh.length
            continue
          } catch (err) {
            this.log(`telegram group edit for user ${user.id} failed: ${(err as Error).message}`) // fall through: send separately
          }
        }
        const html = fresh.length === 1 ? incidentOpened(this.textOf(fresh[0]!)) : incidentGroup(fresh.map((i) => this.textOf(i)), this.d.publicUrl)
        const subject = fresh.length === 1 ? `[Pulse] ${fresh[0]!.targetName} is DOWN` : `[Pulse] ${fresh.length} targets are DOWN`
        const d = await this.deliver(user, html, subject)
        if (!d) continue
        for (const inc of fresh) await this.record(inc, user, d)
        sent += fresh.length
      }

      // 2. recoveries: edit the original message in place; never announce a recovery nobody heard the outage of
      const edited = new Set<string>()
      for (const inc of visible) {
        const row = rowOf(inc)
        if (!inc.resolvedAt || !row || row.resolvedSentAt) continue
        const shared =
          row.channel === 'telegram' && row.chatId && row.messageId != null
            ? visible.filter((i) => rowOf(i)?.chatId === row.chatId && rowOf(i)?.messageId === row.messageId)
            : [inc]
        const msgKey = `${row.chatId}:${row.messageId}`
        if (shared.length > 1 && edited.has(msgKey)) continue // a sibling's turn already re-rendered and marked it
        const html = shared.length > 1 ? incidentGroup(shared.map((i) => this.textOf(i)), this.d.publicUrl) : incidentResolved(this.textOf(inc))
        const subject = `[Pulse] ${inc.targetName} recovered`
        let ok = false
        if (row.channel === 'telegram' && row.chatId && row.messageId != null) {
          try {
            await this.d.telegram.editMessage(row.chatId, row.messageId, html)
            ok = true
          } catch (err) {
            this.log(`telegram edit for incident ${inc.id} failed: ${(err as Error).message}`)
            ok = (await this.emailFallback(user, subject, html)) !== null
          }
        } else {
          ok = (await this.emailFallback(user, subject, html)) !== null
        }
        if (!ok) continue
        edited.add(msgKey)
        for (const m of shared) {
          const r = rowOf(m)
          if (m.resolvedAt && r && !r.resolvedSentAt) {
            await markAlertResolved(this.d.db, m.id, user.id, now)
            resolved++
          }
        }
      }
    }
    return { sent, resolved }
  }

  /** A Telegram message for this host that still shows at least one open or not-yet-updated incident. */
  private liveGroupMessage(
    visible: AlertIncident[],
    rowOf: (inc: AlertIncident) => { channel: string; chatId: string | null; messageId: number | null; resolvedSentAt: Date | null } | undefined,
    host: string,
  ): { chatId: string; messageId: number } | undefined {
    for (const inc of visible) {
      const r = rowOf(inc)
      if (!r || r.channel !== 'telegram' || !r.chatId || r.messageId == null) continue
      if (this.d.hostOf?.(inc.targetId) !== host) continue
      if (inc.resolvedAt && r.resolvedSentAt) continue // that message already says "recovered"
      return { chatId: r.chatId, messageId: r.messageId }
    }
    return undefined
  }

  private record(inc: AlertIncident, user: UserRow, d: Delivered) {
    return insertAlertMessage(this.d.db, {
      incidentId: inc.id,
      userId: user.id,
      ...d,
      targetName: inc.targetName,
      checkKind: inc.checkKind,
    })
  }

  /**
   * The check left targets.yaml while its incident was open (syncTargets resolves such incidents). The incident no
   * longer joins to a target, so use what the message remembered. A message shared with other targets is left to
   * their re-render; editing it alone would erase them.
   */
  private async reconcileRemoved(now: Date): Promise<number> {
    let n = 0
    for (const r of await listRemovedAlertMessages(this.d.db, now)) {
      if (r.channel === 'telegram' && r.chatId && r.messageId != null && !r.shared) {
        try {
          await this.d.telegram.editMessage(
            r.chatId,
            r.messageId,
            incidentRemoved({
              targetName: r.targetName ?? r.checkId,
              checkKind: r.checkKind ?? 'check',
              cause: r.cause,
              openedAt: r.openedAt,
              resolvedAt: r.resolvedAt,
              url: this.d.publicUrl,
            }),
          )
        } catch (err) {
          this.log(`telegram edit for removed incident ${r.incidentId} failed: ${(err as Error).message}`)
          continue // retried next tick, for up to 24 h
        }
      }
      await markAlertResolved(this.d.db, r.incidentId, r.userId, now)
      n++
    }
    return n
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
