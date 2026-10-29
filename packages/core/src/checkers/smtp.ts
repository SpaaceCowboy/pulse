import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Checker, CheckResult } from '../types'
import type { SmtpConfig } from './config'
import { errMessage, nowMs, timeoutResult } from './util'

const MAX_BUFFER = 8 * 1024

/** Complete reply (final line `NNN text`) found in buffer, or null if still partial. */
function parseReply(buf: string): { code: string; lines: string[] } | null {
  const parts = buf.split(/\r?\n/)
  const lines: string[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    const line = parts[i]!
    lines.push(line)
    if (/^\d{3}( |$)/.test(line)) return { code: line.slice(0, 3), lines }
    if (!/^\d{3}-/.test(line)) return { code: line.slice(0, 3), lines } // malformed: treat as final
  }
  return null
}

export const smtpChecker: Checker<SmtpConfig> = {
  kind: 'smtp',
  run(cfg, signal) {
    const startedAt = nowMs()
    return new Promise<CheckResult>((resolve) => {
      let socket: Socket | undefined
      let done = false
      let phase: 'banner' | 'ehlo' = 'banner'
      let buf = ''
      let banner = ''

      const finish = (r: CheckResult) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        try {
          socket?.destroy()
        } catch {
          /* ignore */
        }
        resolve({ ...r, latencyMs: r.latencyMs ?? Math.round(nowMs() - startedAt) })
      }
      const down = (message: string, meta?: Record<string, unknown>) =>
        finish({ status: 'down', message, ...(meta ? { meta } : {}) })
      const onAbort = () => finish(timeoutResult(startedAt))

      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })

      const onData = (chunk: Buffer) => {
        buf += chunk.toString('latin1')
        if (buf.length > MAX_BUFFER) return down('response too large')
        const reply = parseReply(buf)
        if (!reply) return
        buf = ''
        if (phase === 'banner') {
          banner = reply.lines.join('\n').slice(0, 200)
          if (reply.code !== '220') return down(`bad banner: ${banner.slice(0, 80)}`, { banner })
          phase = 'ehlo'
          socket!.write('EHLO pulse.monitor\r\n')
          return
        }
        if (reply.code !== '250') {
          return down(`EHLO rejected: ${reply.lines[reply.lines.length - 1]}`.slice(0, 120), { banner })
        }
        const extensions = reply.lines
          .slice(1)
          .map((l) => l.slice(4).trim())
          .filter(Boolean)
        const starttls = extensions.some((e) => e.toUpperCase() === 'STARTTLS')
        try {
          socket!.write('QUIT\r\n')
        } catch {
          /* ignore */
        }
        const meta = { banner, starttls, extensions }
        if (starttls || !cfg.require_starttls || cfg.secure) finish({ status: 'up', meta })
        else finish({ status: 'degraded', message: 'no STARTTLS', meta })
      }

      try {
        socket = cfg.secure
          ? tlsConnect({ host: cfg.host, port: cfg.port, rejectUnauthorized: false, servername: cfg.host })
          : netConnect({ host: cfg.host, port: cfg.port })
        socket.on('data', onData)
        socket.on('error', (err) => down(errMessage(err)))
        socket.on('close', () => down('connection closed'))
      } catch (err) {
        down(errMessage(err))
      }
    })
  },
}
