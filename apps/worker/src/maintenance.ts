import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { dropOldPartitions, ensurePartitions, rollupRecent, type Db } from '@pulse/db'

export const MAINTENANCE_QUEUE = 'pulse-maintenance'
const HOUR_MS = 3_600_000

/** Partition upkeep (create ahead, drop expired) and the hourly rollup. */
export async function runPartitionJob(db: Db, now = new Date()) {
  const created = await ensurePartitions(db, now, 2)
  const dropped = await dropOldPartitions(db, now, 14)
  return { created, dropped }
}

export async function startMaintenance(opts: { connection: Redis; db: Db; log?: (m: string) => void }) {
  const { db, log = console.log } = opts
  // before the first insert: the month must have a partition
  await runPartitionJob(db)
  await rollupRecent(db, new Date())

  const queue = new Queue(MAINTENANCE_QUEUE, { connection: opts.connection })
  const jobOpts = { removeOnComplete: true, removeOnFail: 20 }
  await queue.upsertJobScheduler('rollup', { every: HOUR_MS }, { name: 'rollup', opts: jobOpts })
  await queue.upsertJobScheduler('partitions', { every: 24 * HOUR_MS }, { name: 'partitions', opts: jobOpts })

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === 'rollup') await rollupRecent(db, new Date())
      else if (job.name === 'partitions') log(`partitions: ${JSON.stringify(await runPartitionJob(db))}`)
    },
    { connection: opts.connection, concurrency: 1 },
  )
  worker.on('error', (err) => console.error('maintenance worker error:', err.message))
  worker.on('failed', (job, err) => console.error(`maintenance job ${job?.name} failed:`, err.message))
  queue.on('error', (err) => console.error('maintenance queue error:', err.message))

  return {
    close: async () => {
      await worker.close()
      await queue.close()
    },
  }
}
