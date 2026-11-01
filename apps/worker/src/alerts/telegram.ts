// Minimal Telegram Bot API client (fetch only). Long polling, so no inbound port or webhook is needed.
export class TelegramError extends Error {
  constructor(
    message: string,
    /** a retry cannot help (bad chat, bot blocked, message gone) */
    readonly permanent: boolean,
    readonly retryAfterS?: number,
  ) {
    super(message)
  }
}

export interface TgUpdate {
  update_id: number
  message?: { chat: { id: number; type: string }; text?: string }
}

export interface TelegramApi {
  sendMessage(chatId: string, html: string): Promise<number>
  editMessage(chatId: string, messageId: number, html: string): Promise<void>
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>
  deleteWebhook(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class TelegramClient implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly base = 'https://api.telegram.org',
    private readonly attempts = 3,
    private readonly backoffMs = 500,
  ) {}

  private async call<T>(method: string, body: unknown, timeoutMs = 10_000, outer?: AbortSignal): Promise<T> {
    let last: unknown
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'PulseMonitor/1.0' },
          body: JSON.stringify(body),
          signal,
        })
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          result?: T
          description?: string
          parameters?: { retry_after?: number }
        }
        if (res.ok && json.ok) return json.result as T
        // 429 and 5xx are worth retrying; any other 4xx (chat not found, bot blocked, bad request) is not
        const transient = res.status === 429 || res.status >= 500
        throw new TelegramError(`${method}: ${res.status} ${json.description ?? ''}`.trim(), !transient, json.parameters?.retry_after)
      } catch (err) {
        if (outer?.aborted) throw err
        last = err
        if (err instanceof TelegramError && err.permanent) throw err
        if (attempt < this.attempts) {
          const wait =
            err instanceof TelegramError && err.retryAfterS ? Math.min(err.retryAfterS, 10) * 1000 : this.backoffMs * attempt
          await sleep(wait)
        }
      }
    }
    throw last instanceof TelegramError ? last : new TelegramError(`${method}: ${String(last)}`, false)
  }

  async sendMessage(chatId: string, html: string): Promise<number> {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    return r.message_id
  }

  async editMessage(chatId: string, messageId: number, html: string): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      })
    } catch (err) {
      if (err instanceof TelegramError && /not modified/i.test(err.message)) return
      throw err
    }
  }

  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutS, allowed_updates: ['message'] },
      (timeoutS + 10) * 1000,
      signal,
    )
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', {})
  }
}
