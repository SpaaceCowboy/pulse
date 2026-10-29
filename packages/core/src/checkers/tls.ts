import { connect, checkServerIdentity, type TLSSocket } from 'node:tls'
import type { CheckResult, Checker } from '../types'
import type { TlsConfig } from './config'
import { daysUntil, errMessage, isAbort, nowMs, timeoutResult } from './util'

export const tlsChecker: Checker<TlsConfig> = {
  kind: 'tls',
  run(cfg, signal) {
    const startedAt = nowMs()
    const servername = cfg.servername ?? cfg.host

    return new Promise<CheckResult>((resolve) => {
      let socket: TLSSocket | undefined
      let done = false
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
      const onAbort = () => finish(timeoutResult(startedAt))

      if (signal.aborted) return finish(timeoutResult(startedAt))
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        socket = connect({ host: cfg.host, port: cfg.port, servername, rejectUnauthorized: false })
      } catch (err) {
        return finish({ status: 'down', message: errMessage(err) })
      }

      socket.once('error', (err) => {
        finish(
          isAbort(err, signal)
            ? timeoutResult(startedAt)
            : { status: 'down', latencyMs: Math.round(nowMs() - startedAt), message: errMessage(err) },
        )
      })
      socket.once('close', () => finish({ status: 'down', message: 'connection closed' }))

      socket.once('secureConnect', () => {
        try {
          const latencyMs = Math.round(nowMs() - startedAt)
          const s = socket as TLSSocket
          const cert = s.getPeerCertificate()
          if (!cert || !cert.valid_to) return finish({ status: 'down', latencyMs, message: 'no certificate presented' })

          const validTo = new Date(cert.valid_to)
          const daysLeft = daysUntil(validTo)
          const issuerObj = cert.issuer as Record<string, string | string[]> | undefined
          const issuer = issuerObj ? String(issuerObj.O ?? issuerObj.CN ?? '') : ''
          const san = cert.subjectaltname ?? ''
          const meta = {
            validTo: validTo.toISOString(),
            daysLeft,
            issuer,
            san,
            authorized: s.authorized,
          }

          const idErr = checkServerIdentity(servername, cert)
          if (idErr) return finish({ status: 'down', latencyMs, message: 'hostname mismatch', meta })
          if (daysLeft < 0) {
            return finish({ status: 'down', latencyMs, message: `certificate expired ${-daysLeft}d ago`, meta })
          }
          if (daysLeft < cfg.warn_days) {
            return finish({ status: 'degraded', latencyMs, message: `certificate expires in ${daysLeft}d`, meta })
          }
          finish({ status: 'up', latencyMs, meta })
        } catch (err) {
          finish({ status: 'down', message: errMessage(err) })
        }
      })
    })
  },
}
