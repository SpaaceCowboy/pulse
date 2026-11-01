// Everything alert-related sits behind ALERTS_ENABLED (docs/PLAN.md "Rollback: ALERTS_ENABLED=false").
export interface SmtpConfig {
  host: string
  port: number
  user?: string
  password?: string
  from: string
}

export interface AlertsConfig {
  enabled: boolean
  telegramToken?: string
  /** override for tests (fake Bot API) */
  telegramApiBase: string
  /** base URL of the dashboard, used for links in messages */
  publicUrl: string
  smtp?: SmtpConfig
  watchdogUrl?: string
}

export function alertsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AlertsConfig {
  const smtp: SmtpConfig | undefined = env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT ?? 587),
        user: env.SMTP_USER || undefined,
        password: env.SMTP_PASSWORD || undefined,
        from: env.SMTP_FROM || env.SMTP_USER || 'pulse@localhost',
      }
    : undefined
  return {
    enabled: env.ALERTS_ENABLED === 'true',
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    smtp,
    watchdogUrl: env.WATCHDOG_URL || undefined,
  }
}
