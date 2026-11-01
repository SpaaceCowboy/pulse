// Telegram bot: chat linking (/start <code>) and the ADMIN-only /mute, /unmute, /mutes commands.
// It only ever answers a chat that is linked to an account, except for the /start link attempt itself.
import { createHash } from 'node:crypto'
import {
  clearMute,
  findUserByChatId,
  linkTelegramChat,
  listCheckInfo,
  setMute,
  activeMutes,
  type Db,
} from '@pulse/db'
import type { Redis } from 'ioredis'
import { formatDuration, MAX_MUTE_MS, MIN_MUTE_MS, parseDuration } from './duration'
import { escapeHtml } from './format'
import type { TelegramApi, TgUpdate } from './telegram'

/** Link codes are created by the web profile page; only a hash is stored (Redis, 10 min TTL). */
export const LINK_CODE_KEY = (code: string) =>
  `pulse:tg-link:${createHash('sha256').update(code.trim().toUpperCase()).digest('hex')}`
const ATTEMPTS_KEY = (chatId: string) => `pulse:tg-attempts:${chatId}`
const MAX_ATTEMPTS = 5

export interface BotDeps {
  db: Db
  redis: Redis
  telegram: TelegramApi
  log?: (msg: string) => void
  now?: () => Date
}

export function parseCommand(text: string): { cmd: string; args: string[] } | null {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/is.exec(text.trim())
  if (!m) return null
  return { cmd: m[1]!.toLowerCase(), args: (m[2] ?? '').split(/\s+/).filter(Boolean) }
}

type TargetRef = { id: string; name: string }

/** Exact id or name first, then a unique substring. */
export function resolveTarget(list: TargetRef[], ref: string): TargetRef | TargetRef[] | null {
  const q = ref.toLowerCase()
  const exact = list.filter((t) => t.id === q || t.name.toLowerCase() === q)
  if (exact.length === 1) return exact[0]!
  const partial = list.filter((t) => t.id.includes(q) || t.name.toLowerCase().includes(q))
  if (partial.length === 1) return partial[0]!
  return partial.length > 1 ? partial : null
}

export class Bot {
  constructor(private readonly d: BotDeps) {}

  private get now() {
    return this.d.now?.() ?? new Date()
  }

  /** Returns the reply text (HTML) or null for silence. */
  async handleText(chatId: string, chatType: string, text: string): Promise<string | null> {
    const parsed = parseCommand(text)
    if (!parsed) return null
    const user = await findUserByChatId(this.d.db, chatId)

    if (parsed.cmd === 'start') return this.start(chatId, chatType, parsed.args[0], user)
    if (!user) return null // strangers get no information from any other command
    if (parsed.cmd === 'help') {
      return user.role === 'ADMIN'
        ? 'Commands: /mute &lt;target&gt; &lt;2h&gt; · /unmute &lt;target&gt; · /mutes'
        : 'You will receive alerts for the targets you can see on the dashboard.'
    }
    if (parsed.cmd === 'mute' || parsed.cmd === 'unmute' || parsed.cmd === 'mutes') {
      if (user.role !== 'ADMIN') return 'Not allowed.'
      return this.mute(user.id, parsed.cmd, parsed.args)
    }
    return null
  }

  private async start(chatId: string, chatType: string, code: string | undefined, user: { email: string; role: string } | null) {
    if (chatType !== 'private') return 'Link Pulse from a private chat with the bot.'
    if (!code) {
      return user
        ? `Linked as ${escapeHtml(user.email)} (${user.role}).`
        : 'To link this chat, open Pulse → Profile → Link Telegram and send the code here as <code>/start CODE</code>.'
    }
    const attempts = await this.d.redis.incr(ATTEMPTS_KEY(chatId))
    if (attempts === 1) await this.d.redis.expire(ATTEMPTS_KEY(chatId), 900)
    if (attempts > MAX_ATTEMPTS) return 'Too many attempts. Try again in 15 minutes.'

    const userId = await this.d.redis.getdel(LINK_CODE_KEY(code))
    if (!userId) return 'That code is invalid or expired. Generate a new one in Pulse → Profile.'
    const ok = await linkTelegramChat(this.d.db, Number(userId), chatId)
    if (!ok) return 'This chat is already linked to another account.'
    await this.d.redis.del(ATTEMPTS_KEY(chatId))
    const linked = await findUserByChatId(this.d.db, chatId)
    return `✅ Linked${linked ? ` to ${escapeHtml(linked.email)} (${linked.role})` : ''}. You will get alerts for the targets you can see.`
  }

  private async mute(userId: number, cmd: string, args: string[]): Promise<string> {
    const targets = new Map((await listCheckInfo(this.d.db)).map((c) => [c.targetId, { id: c.targetId, name: c.targetName }]))
    const list = [...targets.values()]

    if (cmd === 'mutes') {
      const active = await activeMutes(this.d.db, this.now)
      if (active.size === 0) return 'No active mutes.'
      return [...active]
        .map(([id, until]) => `${escapeHtml(targets.get(id)?.name ?? id)} · ${formatDuration(until.getTime() - this.now.getTime())} left`)
        .join('\n')
    }
    const ref = args[0]
    if (!ref) return cmd === 'mute' ? 'Usage: /mute &lt;target&gt; &lt;2h&gt;' : 'Usage: /unmute &lt;target&gt;'
    const t = resolveTarget(list, ref)
    if (!t) return 'No such target.'
    if (Array.isArray(t)) return `Ambiguous. Did you mean: ${t.map((x) => escapeHtml(x.id)).join(', ')}?`

    if (cmd === 'unmute') {
      return (await clearMute(this.d.db, t.id)) ? `🔔 ${escapeHtml(t.name)} unmuted.` : `${escapeHtml(t.name)} was not muted.`
    }
    const ms = args[1] ? parseDuration(args[1]) : null
    if (ms == null) {
      return `Give a duration between ${formatDuration(MIN_MUTE_MS)} and ${formatDuration(MAX_MUTE_MS)}, e.g. <code>/mute ${escapeHtml(t.id)} 2h</code>.`
    }
    await setMute(this.d.db, t.id, new Date(this.now.getTime() + ms), userId)
    return `🔕 ${escapeHtml(t.name)} muted for ${formatDuration(ms)}. Incidents are still recorded.`
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    const m = u.message
    if (!m?.text) return
    const chatId = String(m.chat.id)
    try {
      const reply = await this.handleText(chatId, m.chat.type, m.text)
      if (reply) await this.d.telegram.sendMessage(chatId, reply)
    } catch (err) {
      this.d.log?.(`bot update ${u.update_id} failed: ${(err as Error).message}`)
    }
  }

  /** Long-poll loop. Exactly one worker may run this (Telegram allows one getUpdates consumer). */
  async run(signal: AbortSignal): Promise<void> {
    try {
      await this.d.telegram.deleteWebhook()
    } catch (err) {
      this.d.log?.(`deleteWebhook failed: ${(err as Error).message}`)
    }
    let offset = 0
    let backoff = 1000
    while (!signal.aborted) {
      try {
        const updates = await this.d.telegram.getUpdates(offset, 25, signal)
        backoff = 1000
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1)
          await this.handleUpdate(u)
        }
      } catch (err) {
        if (signal.aborted) return
        this.d.log?.(`getUpdates failed: ${(err as Error).message}`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }
}
