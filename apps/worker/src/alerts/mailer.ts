import nodemailer from 'nodemailer'
import type { SmtpConfig } from './config'

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>
}

/** SMTP fallback channel: used only when a Telegram delivery fails (docs/PLAN.md "Channels"). */
export function createMailer(cfg: SmtpConfig | undefined): Mailer | null {
  if (!cfg) return null
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from: cfg.from, to, subject, text })
    },
  }
}
