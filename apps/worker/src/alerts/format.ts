// Message texts. Telegram gets HTML (parse_mode), email gets the same text with tags stripped.
// Every value that comes from a target, a check message or a user is escaped.
import { formatDuration } from './duration'

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function toPlain(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const link = (url: string) => (url ? `\n<a href="${escapeHtml(url)}">Open Pulse</a>` : '')
const utc = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

export interface IncidentText {
  targetName: string
  checkKind: string
  cause: string | null
  openedAt: Date
  resolvedAt?: Date | null
  url?: string
}

export function incidentOpened(i: IncidentText): string {
  return (
    `🔴 <b>${escapeHtml(i.targetName)}</b> is DOWN\n` +
    `Check: ${escapeHtml(i.checkKind)}\n` +
    (i.cause ? `Cause: ${escapeHtml(clip(i.cause))}\n` : '') +
    `Since: ${utc(i.openedAt)}` +
    link(i.url ?? '')
  )
}

export function incidentResolved(i: IncidentText): string {
  const took = i.resolvedAt ? formatDuration(i.resolvedAt.getTime() - i.openedAt.getTime()) : '?'
  return (
    `✅ <b>${escapeHtml(i.targetName)}</b> recovered after ${took}\n` +
    `Check: ${escapeHtml(i.checkKind)}\n` +
    (i.cause ? `Was: ${escapeHtml(clip(i.cause))}\n` : '') +
    `Opened: ${utc(i.openedAt)}` +
    link(i.url ?? '')
  )
}

/** Targets that went down together on one host share a single message. No IP/host is shown: USER accounts never see hosts. */
export function incidentGroup(items: IncidentText[], url = ''): string {
  const sorted = [...items].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
  const open = sorted.filter((i) => !i.resolvedAt).length
  const head =
    open === sorted.length
      ? `🔴 <b>${sorted.length} targets are DOWN</b> (same host)`
      : open === 0
        ? `✅ <b>${sorted.length} targets recovered</b> (same host)`
        : `🟠 <b>${open} of ${sorted.length} targets still DOWN</b> (same host)`
  const lines = sorted.map((i) =>
    i.resolvedAt
      ? `✅ <b>${escapeHtml(i.targetName)}</b> · ${escapeHtml(i.checkKind)} · recovered after ${formatDuration(i.resolvedAt.getTime() - i.openedAt.getTime())}`
      : `🔴 <b>${escapeHtml(i.targetName)}</b> · ${escapeHtml(i.checkKind)} · since ${utc(i.openedAt)}` +
        (i.cause ? ` · ${escapeHtml(clip(i.cause, 120))}` : ''),
  )
  return [head, ...lines].join('\n') + link(url)
}

/** The check left targets.yaml while its incident was open (see syncTargets). */
export function incidentRemoved(i: IncidentText): string {
  return (
    `⚪ <b>${escapeHtml(i.targetName)}</b> was removed from monitoring while down\n` +
    `Check: ${escapeHtml(i.checkKind)}\n` +
    (i.cause ? `Was: ${escapeHtml(clip(i.cause))}\n` : '') +
    `Opened: ${utc(i.openedAt)}` +
    link(i.url ?? '')
  )
}

export function degradedSustained(name: string, kind: string, message: string | undefined, url = ''): string {
  return (
    `🟠 <b>${escapeHtml(name)}</b> has been degraded for over 15 min\n` +
    `Check: ${escapeHtml(kind)}` +
    (message ? `\nDetail: ${escapeHtml(clip(message))}` : '') +
    link(url)
  )
}

export const degradedCleared = (name: string, kind: string) =>
  `✅ <b>${escapeHtml(name)}</b> is no longer degraded\nCheck: ${escapeHtml(kind)}`

export interface DigestData {
  date: string
  openIncidents: Array<{ targetName: string; checkKind: string; since: Date }>
  degraded: Array<{ targetName: string; checkKind: string; message?: string }>
  expiries: Array<{ targetName: string; checkKind: string; daysLeft: number }>
  url?: string
}

export function digestText(d: DigestData, now = Date.now()): string {
  const lines = [`☀️ <b>Pulse daily digest</b> · ${escapeHtml(d.date)}`]
  if (d.openIncidents.length === 0 && d.degraded.length === 0) lines.push('', 'All systems operational.')
  if (d.openIncidents.length) {
    lines.push('', `<b>Open incidents (${d.openIncidents.length})</b>`)
    for (const i of d.openIncidents) {
      lines.push(`🔴 ${escapeHtml(i.targetName)} · ${escapeHtml(i.checkKind)} · ${formatDuration(now - i.since.getTime())}`)
    }
  }
  if (d.degraded.length) {
    lines.push('', `<b>Degraded (${d.degraded.length})</b>`)
    for (const g of d.degraded) {
      lines.push(
        `🟠 ${escapeHtml(g.targetName)} · ${escapeHtml(g.checkKind)}${g.message ? ` · ${escapeHtml(clip(g.message, 120))}` : ''}`,
      )
    }
  }
  if (d.expiries.length) {
    lines.push('', '<b>TLS / domain expiry</b>')
    for (const e of d.expiries) {
      const flag = e.daysLeft < 14 ? '🔴' : e.daysLeft < 30 ? '🟠' : '🟢'
      lines.push(`${flag} ${escapeHtml(e.targetName)} · ${escapeHtml(e.checkKind)} · ${e.daysLeft} days`)
    }
  }
  return lines.join('\n') + link(d.url ?? '')
}
