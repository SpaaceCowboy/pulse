import { connect as netConnect, type Socket } from 'node:net'
import type { Checker, CheckResult } from '../types'
import type { TcpConfig } from './config'
import { errMessage, nowMs, timeoutResult } from './util'

export type ConnectFn = (opts: { host: string; port: number }) => Socket

export function createTcpChecker(connectFn: ConnectFn = netConnect as ConnectFn): Checker<TcpConfig> {
  return {
    kind: 'tcp',
    run(cfg: TcpConfig, signal: AbortSignal): Promise<CheckResult> {
      const startedAt = nowMs()
      const meta = { host: cfg.host, port: cfg.port }
      return new Promise<CheckResult>((resolve) => {
        let socket: Socket | undefined
        let done = false
        const finish = (r: CheckResult) => {
          if (done) return
          done = true
          signal.removeEventListener('abort', onAbort)
          try {
            socket?.destroy()
          } catch {
            // ignore
          }
          resolve(r)
        }
        const onAbort = () => finish({ ...timeoutResult(startedAt), meta })
        if (signal.aborted) return finish({ ...timeoutResult(startedAt), meta })
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          socket = connectFn({ host: cfg.host, port: cfg.port })
          socket.once('connect', () => {
            const latencyMs = Math.round(nowMs() - startedAt)
            finish(
              latencyMs > cfg.slow_ms
                ? { status: 'degraded', latencyMs, message: `slow connect: ${latencyMs}ms > ${cfg.slow_ms}ms`, meta }
                : { status: 'up', latencyMs, meta },
            )
          })
          socket.once('error', (err) =>
            finish({ status: 'down', latencyMs: Math.round(nowMs() - startedAt), message: errMessage(err), meta }),
          )
        } catch (err) {
          finish({ status: 'down', latencyMs: Math.round(nowMs() - startedAt), message: errMessage(err), meta })
        }
      })
    },
  }
}

export const tcpChecker = createTcpChecker()
