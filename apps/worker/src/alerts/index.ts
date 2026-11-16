// Wiring for everything alert-related. With ALERTS_ENABLED unset/false nothing here starts: no Telegram polling,
// no email, no digest, no watchdog. Incidents are still recorded by the state machine either way.
import type { StateEvent, Target } from '@pulse/core'
import type { Db } from '@pulse/db'
import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import type { StateStore } from '../state-store'
import { Bot } from './bot'
import type { AlertsConfig } from './config'
import { DIGEST_CRON, DIGEST_TZ, sendDigests } from './digest'
import { createMailer } from './mailer'
import { Notifier } from './notifier'
import { TelegramClient } from './telegram'
import { startWatchdog } from './watchdog'

export const ALERTS_QUEUE = 'pulse-alerts'
export const RECONCILE_INTERVAL_MS = 30_000

/** targets.yaml `host` by target id; targets without one are never grouped. */
export function hostResolver(targets: Target[]) {
  const hosts = new Map(targets.flatMap((t) => (t.host ? [[t.id, t.host] as const] : [])))
  return (targetId: string) => hosts.get(targetId)
}

export function maintenanceChecker(targets: Target[]) {
  const windows = new Map(
    targets.map((t) => [t.id, t.maintenance.map((m) => [Date.parse(m.start), Date.parse(m.end)] as const)]),
  )
  return (targetId: string, now: Date) =>
    (windows.get(targetId) ?? []).some(([s, e]) => s <= now.getTime() && now.getTime() < e)
}

export interface AlertsDeps {
  cfg: AlertsConfig
  db: Db
  redis: Redis
  /** BullMQ needs its own connection with maxRetriesPerRequest: null */
  connection: Redis
  store: StateStore
  targets: Target[]
  healthy: () => Promise<boolean>
  lastResultAt: () => number | null
  log?: (m: string) => void
}

export async function startAlerts(d: AlertsDeps) {
  const log = d.log ?? console.log
  if (!d.cfg.enabled) {
    log('alerts: disabled (ALERTS_ENABLED is not true)')
    return { onEvent: (_c: string, _e: StateEvent) => {}, close: async () => {} }
  }
  if (!d.cfg.telegramToken) throw new Error('ALERTS_ENABLED=true requires TELEGRAM_BOT_TOKEN')

  const telegram = new TelegramClient(d.cfg.telegramToken, d.cfg.telegramApiBase)
  const mailer = createMailer(d.cfg.smtp)
  const notifier = new Notifier({
    db: d.db,
    redis: d.redis,
    store: d.store,
    telegram,
    mailer,
    publicUrl: d.cfg.publicUrl,
    inMaintenance: maintenanceChecker(d.targets),
    hostOf: hostResolver(d.targets),
    log,
  })

  const tick = () =>
    notifier.reconcile().then(
      (r) => r.sent + r.resolved > 0 && log(`alerts: sent ${r.sent}, resolved ${r.resolved}`),
      (err) => log(`alerts: reconcile failed: ${(err as Error).message}`),
    )
  const timer = setInterval(() => void tick(), Number(process.env.ALERTS_RECONCILE_MS) || RECONCILE_INTERVAL_MS)
  setTimeout(() => void tick(), 3000)

  const abort = new AbortController()
  const bot = new Bot({ db: d.db, redis: d.redis, telegram, log })
  const botLoop = bot.run(abort.signal)

  const queue = new Queue(ALERTS_QUEUE, { connection: d.connection })
  await queue.upsertJobScheduler(
    'digest',
    { pattern: DIGEST_CRON, tz: DIGEST_TZ },
    { name: 'digest', opts: { removeOnComplete: true, removeOnFail: 20 } },
  )
  const worker = new Worker(
    ALERTS_QUEUE,
    async (job) => {
      if (job.name === 'digest') {
        await sendDigests({ db: d.db, store: d.store, publicUrl: d.cfg.publicUrl, notifier, log })
      }
    },
    { connection: d.connection, concurrency: 1 },
  )
  worker.on('error', (err) => console.error('alerts worker error:', err.message))
  worker.on('failed', (job, err) => console.error(`alerts job ${job?.name} failed:`, err.message))
  queue.on('error', (err) => console.error('alerts queue error:', err.message))

  const watchdog = d.cfg.watchdogUrl
    ? startWatchdog({ url: d.cfg.watchdogUrl, healthy: d.healthy, lastResultAt: d.lastResultAt, log })
    : null
  log(`alerts: enabled (email fallback ${mailer ? 'on' : 'off'}, watchdog ${watchdog ? 'on' : 'off'})`)

  return {
    onEvent: (checkId: string, e: StateEvent) => void notifier.onStateEvent(checkId, e).catch((err) => log(`alerts: ${(err as Error).message}`)),
    close: async () => {
      clearInterval(timer)
      watchdog?.close()
      abort.abort()
      await botLoop.catch(() => {})
      await worker.close()
      await queue.close()
    },
  }
}
