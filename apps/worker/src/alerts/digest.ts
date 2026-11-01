// Daily 09:00 Asia/Tehran digest: open incidents, degraded items, TLS/domain expiries, scoped per user.
import { scopeTargets } from '@pulse/core'
import { listAlertIncidents, listCheckInfo, listUsers, type Db } from '@pulse/db'
import type { StateStore } from '../state-store'
import { digestText, type DigestData } from './format'
import type { Notifier } from './notifier'

export const DIGEST_CRON = '0 9 * * *'
export const DIGEST_TZ = 'Asia/Tehran'
const PASSIVE = new Set(['heartbeat', 'agent', 'queue'])
const MAX_EXPIRIES = 12

export function digestDate(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: DIGEST_TZ, dateStyle: 'medium' }).format(now)
}

export async function buildDigests(
  deps: { db: Db; store: StateStore; publicUrl: string },
  now: Date,
): Promise<Array<{ userId: number; text: string }>> {
  const [checks, users, open] = await Promise.all([
    listCheckInfo(deps.db),
    listUsers(deps.db),
    listAlertIncidents(deps.db, now, 0),
  ])
  const states = new Map(await Promise.all(checks.map(async (c) => [c.checkId, await deps.store.get(c.checkId)] as const)))

  const out: Array<{ userId: number; text: string }> = []
  for (const user of users) {
    if (!user.telegramChatId) continue
    const visible = new Set(scopeTargets(user, checks).map((c) => c.checkId))
    const data: DigestData = {
      date: digestDate(now),
      url: deps.publicUrl,
      openIncidents: open
        .filter((i) => visible.has(i.checkId))
        .map((i) => ({ targetName: i.targetName, checkKind: i.checkKind, since: i.openedAt })),
      degraded: [],
      expiries: [],
    }
    for (const c of checks) {
      if (!visible.has(c.checkId)) continue
      const s = states.get(c.checkId)
      if (!s) continue
      if (!PASSIVE.has(c.kind) && s.last.status === 'degraded') {
        data.degraded.push({ targetName: c.targetName, checkKind: c.kind, message: s.last.message })
      }
      if ((c.kind === 'tls' || c.kind === 'domain') && typeof s.last.daysLeft === 'number') {
        data.expiries.push({ targetName: c.targetName, checkKind: c.kind, daysLeft: s.last.daysLeft })
      }
    }
    data.expiries.sort((a, b) => a.daysLeft - b.daysLeft)
    data.expiries.length = Math.min(data.expiries.length, MAX_EXPIRIES)
    out.push({ userId: user.id, text: digestText(data, now.getTime()) })
  }
  return out
}

export async function sendDigests(
  deps: { db: Db; store: StateStore; publicUrl: string; notifier: Notifier; log?: (m: string) => void },
  now = new Date(),
): Promise<number> {
  const users = new Map((await listUsers(deps.db)).map((u) => [u.id, u]))
  let sent = 0
  for (const d of await buildDigests(deps, now)) {
    const user = users.get(d.userId)!
    if (await deps.notifier.deliver(user, d.text, `[Pulse] Daily digest ${digestDate(now)}`)) sent++
  }
  deps.log?.(`digest: sent ${sent}`)
  return sent
}
