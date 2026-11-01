// Phase 4 storage: alert bookkeeping, mutes, heartbeats, Telegram chat linking.
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Db } from './store'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// ---- incidents to notify about ----

export interface AlertIncident {
  id: number
  checkId: string
  openedAt: Date
  resolvedAt: Date | null
  cause: string | null
  targetId: string
  targetName: string
  audience: 'roco' | 'admin'
  checkKind: string
}

/** Open incidents plus those resolved within `resolvedWithinH` hours (so a pending resolve edit is never lost). */
export async function listAlertIncidents(db: Db, now: Date, resolvedWithinH = 24): Promise<AlertIncident[]> {
  const since = new Date(now.getTime() - resolvedWithinH * 3_600_000).toISOString()
  const res = await db.execute<{
    id: number
    check_id: string
    opened_at: Date
    resolved_at: Date | null
    cause: string | null
    target_id: string
    target_name: string
    audience: 'roco' | 'admin'
    kind: string
  }>(sql`
    SELECT i.id, i.check_id, i.opened_at, i.resolved_at, i.cause,
           t.id AS target_id, t.name AS target_name, t.audience::text AS audience, c.kind
    FROM incidents i
    JOIN checks c ON c.id = i.check_id
    JOIN targets t ON t.id = c.target_id
    WHERE i.resolved_at IS NULL OR i.resolved_at >= ${since}::timestamptz
    ORDER BY i.id`)
  return res.rows.map((r) => ({
    id: Number(r.id),
    checkId: r.check_id,
    openedAt: new Date(r.opened_at),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    cause: r.cause,
    targetId: r.target_id,
    targetName: r.target_name,
    audience: r.audience,
    checkKind: r.kind,
  }))
}

export interface AlertMessageRow {
  incidentId: number
  userId: number
  channel: 'telegram' | 'email'
  chatId: string | null
  messageId: number | null
  resolvedSentAt: Date | null
}

export async function listAlertMessages(db: Db, incidentIds: number[]): Promise<AlertMessageRow[]> {
  if (incidentIds.length === 0) return []
  const res = await db.execute<{
    incident_id: number
    user_id: number
    channel: 'telegram' | 'email'
    chat_id: string | null
    message_id: number | null
    resolved_sent_at: Date | null
  }>(sql`SELECT incident_id, user_id, channel, chat_id, message_id, resolved_sent_at FROM alert_messages
         WHERE incident_id = ANY(${sql.raw(`ARRAY[${incidentIds.map(Number).join(',')}]::bigint[]`)})`)
  return res.rows.map((r) => ({
    incidentId: Number(r.incident_id),
    userId: Number(r.user_id),
    channel: r.channel,
    chatId: r.chat_id,
    messageId: r.message_id == null ? null : Number(r.message_id),
    resolvedSentAt: r.resolved_sent_at ? new Date(r.resolved_sent_at) : null,
  }))
}

export async function insertAlertMessage(
  db: Db,
  m: { incidentId: number; userId: number; channel: 'telegram' | 'email'; chatId?: string | null; messageId?: number | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO alert_messages (incident_id, user_id, channel, chat_id, message_id)
    VALUES (${m.incidentId}, ${m.userId}, ${m.channel}, ${m.chatId ?? null}, ${m.messageId ?? null})
    ON CONFLICT (incident_id, user_id) DO NOTHING`)
}

export async function markAlertResolved(db: Db, incidentId: number, userId: number, at: Date): Promise<void> {
  await db.execute(sql`UPDATE alert_messages SET resolved_sent_at = ${at.toISOString()}::timestamptz
                       WHERE incident_id = ${incidentId} AND user_id = ${userId}`)
}

// ---- mutes ----

export async function setMute(db: Db, targetId: string, until: Date, userId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO mutes (target_id, until, created_by) VALUES (${targetId}, ${until.toISOString()}::timestamptz, ${userId})
    ON CONFLICT (target_id) DO UPDATE SET until = EXCLUDED.until, created_by = EXCLUDED.created_by, created_at = now()`)
}

export async function clearMute(db: Db, targetId: string): Promise<boolean> {
  const res = await db.execute(sql`DELETE FROM mutes WHERE target_id = ${targetId}`)
  return (res.rowCount ?? 0) > 0
}

/** target id -> mute end, for mutes still in force at `now`. */
export async function activeMutes(db: Db, now: Date): Promise<Map<string, Date>> {
  const res = await db.execute<{ target_id: string; until: Date }>(
    sql`SELECT target_id, until FROM mutes WHERE until > ${now.toISOString()}::timestamptz`,
  )
  return new Map(res.rows.map((r) => [r.target_id, new Date(r.until)]))
}

// ---- Telegram linking ----

/** false when the chat is already linked to another account (unique index). */
export async function linkTelegramChat(db: Db, userId: number, chatId: string): Promise<boolean> {
  try {
    const res = await db.execute(sql`UPDATE users SET telegram_chat_id = ${chatId} WHERE id = ${userId}`)
    return (res.rowCount ?? 0) === 1
  } catch (err) {
    if ((err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') {
      return false
    }
    throw err
  }
}

export async function unlinkTelegramChat(db: Db, userId: number): Promise<void> {
  await db.execute(sql`UPDATE users SET telegram_chat_id = NULL WHERE id = ${userId}`)
}

export async function findUserByChatId(
  db: Db,
  chatId: string,
): Promise<{ id: number; email: string; role: 'ADMIN' | 'USER' } | null> {
  const res = await db.execute<{ id: number; email: string; role: 'ADMIN' | 'USER' }>(
    sql`SELECT id, email, role::text AS role FROM users WHERE telegram_chat_id = ${chatId} LIMIT 1`,
  )
  const r = res.rows[0]
  return r ? { id: Number(r.id), email: r.email, role: r.role } : null
}

// ---- heartbeats (token column holds the SHA-256 of the push token) ----

export async function upsertHeartbeat(db: Db, checkId: string, tokenHash: string, graceS: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO heartbeats (token, check_id, grace_s) VALUES (${tokenHash}, ${checkId}, ${graceS})
    ON CONFLICT (check_id) DO UPDATE
      SET token = EXCLUDED.token, grace_s = EXCLUDED.grace_s, last_ping_at = NULL,
          last_status = NULL, last_message = NULL, created_at = now()`)
}

/** Records a ping; returns the check id, or null for an unknown token. */
export async function pingHeartbeat(
  db: Db,
  tokenHash: string,
  p: { ok: boolean; message?: string | null },
  now: Date,
): Promise<string | null> {
  const res = await db.execute<{ check_id: string }>(sql`
    UPDATE heartbeats
    SET last_ping_at = ${now.toISOString()}::timestamptz,
        last_status = ${p.ok ? 'ok' : 'fail'},
        last_message = ${p.message?.slice(0, 500) ?? null}
    WHERE token = ${tokenHash} RETURNING check_id`)
  return res.rows[0]?.check_id ?? null
}

export interface HeartbeatRow {
  checkId: string
  graceS: number
  lastPingAt: Date | null
  lastStatus: string | null
  lastMessage: string | null
  createdAt: Date
}

/** Heartbeats whose check still exists in the registry. */
export async function listHeartbeats(db: Db): Promise<HeartbeatRow[]> {
  const res = await db.execute<{
    check_id: string
    grace_s: number
    last_ping_at: Date | null
    last_status: string | null
    last_message: string | null
    created_at: Date
  }>(sql`SELECT h.check_id, h.grace_s, h.last_ping_at, h.last_status, h.last_message, h.created_at
         FROM heartbeats h JOIN checks c ON c.id = h.check_id ORDER BY h.check_id`)
  return res.rows.map((r) => ({
    checkId: r.check_id,
    graceS: Number(r.grace_s),
    lastPingAt: r.last_ping_at ? new Date(r.last_ping_at) : null,
    lastStatus: r.last_status,
    lastMessage: r.last_message,
    createdAt: new Date(r.created_at),
  }))
}

export async function checkExists(db: Db, checkId: string): Promise<{ kind: string; config: unknown } | null> {
  const res = await db.execute<{ kind: string; config: unknown }>(sql`SELECT kind, config FROM checks WHERE id = ${checkId}`)
  return res.rows[0] ?? null
}

// ---- digest / lookup helpers ----

export interface CheckInfo {
  checkId: string
  kind: string
  targetId: string
  targetName: string
  audience: 'roco' | 'admin'
  vantage: string[]
  intervalS: number
}

export async function listCheckInfo(db: Db): Promise<CheckInfo[]> {
  const res = await db.execute<{
    id: string
    kind: string
    target_id: string
    name: string
    audience: 'roco' | 'admin'
    vantage: string[]
    interval_s: number
  }>(sql`SELECT c.id, c.kind, c.target_id, t.name, t.audience::text AS audience, c.vantage, c.interval_s
         FROM checks c JOIN targets t ON t.id = c.target_id ORDER BY t.name, c.id`)
  return res.rows.map((r) => ({
    checkId: r.id,
    kind: r.kind,
    targetId: r.target_id,
    targetName: r.name,
    audience: r.audience,
    vantage: r.vantage,
    intervalS: Number(r.interval_s),
  }))
}
