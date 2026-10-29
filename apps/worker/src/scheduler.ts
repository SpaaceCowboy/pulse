import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Target } from '@pulse/core'
import { listChecks, runCheck, type CheckRef } from './run-check'

export const QUEUE_NAME = 'pulse-checks'
export const CONCURRENCY = 10
export const JITTER = 0.1

/** interval +/- 10 %, deterministic given `rand` (injectable for tests). */
export function jitteredIntervalMs(intervalS: number, rand: () => number = Math.random): number {
  const base = intervalS * 1000
  return Math.round(base * (1 - JITTER + 2 * JITTER * rand()))
}

export interface SchedulerOptions {
  connection: Redis
  targets: Target[]
  onResult?: (ref: CheckRef, result: Awaited<ReturnType<typeof runCheck>>) => void | Promise<void>
  concurrency?: number
}

/**
 * One queue, repeatable job per active check, concurrency 10.
 * BullMQ repeat has a fixed `every`, so jitter is applied per check once at registration
 * (spreads checks out instead of firing them all on the same tick) and the job id is stable
 * so a restart replaces rather than duplicates schedules.
 */
export async function startScheduler(opts: SchedulerOptions) {
  const refs = new Map(listChecks(opts.targets).map((r) => [r.id, r]))
  const queue = new Queue(QUEUE_NAME, { connection: opts.connection })

  // drop schedules for checks that no longer exist in targets.yaml
  for (const rep of await queue.getJobSchedulers()) {
    if (!refs.has(rep.key)) await queue.removeJobScheduler(rep.key)
  }
  for (const ref of refs.values()) {
    await queue.upsertJobScheduler(
      ref.id,
      { every: jitteredIntervalMs(ref.intervalS) },
      { name: ref.check.kind, data: { checkId: ref.id }, opts: { removeOnComplete: true, removeOnFail: 50 } },
    )
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const ref = refs.get((job.data as { checkId: string }).checkId)
      if (!ref) return
      const result = await runCheck(ref)
      try {
        await opts.onResult?.(ref, result)
      } catch (err) {
        console.error(`onResult failed for ${ref.id}:`, err)
      }
    },
    { connection: opts.connection, concurrency: opts.concurrency ?? CONCURRENCY },
  )

  // an unhandled 'error' event on an EventEmitter would crash the process (e.g. Redis blips)
  worker.on('error', (err) => console.error('scheduler worker error:', err.message))
  queue.on('error', (err) => console.error('scheduler queue error:', err.message))

  return {
    checks: refs.size,
    close: async () => {
      await worker.close()
      await queue.close()
    },
  }
}
