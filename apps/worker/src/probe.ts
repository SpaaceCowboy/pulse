// PROBE_ONLY=1: the second vantage (HostVDS). Stateless: no Postgres, no Redis, no inbound ports. Runs the checks
// whose targets.yaml `vantage` lists this probe and POSTs the results, HMAC-signed, to the core's /api/ingest.
import { createServer } from 'node:http'
import { loadTargets, signIngest, type ProbeBatch } from '@pulse/core'
import { checkVantages, isPlaceholder, listChecks, runCheck, type CheckRef } from './run-check'
import { CONCURRENCY, jitteredIntervalMs } from './scheduler'

const need = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

const vantage = process.env.PROBE_VANTAGE || 'hostvds'
const ingestUrl = need('CORE_INGEST_URL')
const secret = need('HMAC_INGEST_SECRET')
const FLUSH_MS = 2000
const MAX_QUEUE = 1000

const { targets } = loadTargets(process.env.TARGETS_FILE ?? 'targets.yaml')
const refs = listChecks(targets).filter((r) => !isPlaceholder(r) && checkVantages(r).includes(vantage))

type Item = ProbeBatch['results'][number]
let queue: Item[] = []
let lastPostOk: number | null = null
let lastPostError: string | undefined

export async function postBatch(results: Item[]): Promise<void> {
  const body = JSON.stringify({ vantage, results } satisfies ProbeBatch)
  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'PulseProbe/1.0', ...signIngest(secret, body) },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ingest answered ${res.status}`)
}

async function flush() {
  if (queue.length === 0) return
  const batch = queue.splice(0, 200)
  try {
    await postBatch(batch)
    lastPostOk = Date.now()
    lastPostError = undefined
  } catch (err) {
    lastPostError = (err as Error).message
    console.error(`probe: ingest failed: ${lastPostError}`)
    // results older than the core's staleness window are worthless: keep a bounded backlog, newest first
    queue = [...batch, ...queue].slice(-MAX_QUEUE)
  }
}

let running = 0
const waiting: Array<() => void> = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

function schedule(ref: CheckRef) {
  const tick = async () => {
    const r = await limited(() => runCheck(ref))
    console.log(JSON.stringify({ probe: vantage, check: ref.id, status: r.status, latencyMs: r.latencyMs, message: r.message }))
    queue.push({ checkId: ref.id, ts: Date.now(), status: r.status, latencyMs: r.latencyMs, message: r.message?.slice(0, 500) })
    setTimeout(() => void tick(), jitteredIntervalMs(ref.intervalS))
  }
  // spread the first run over one interval so 20 checks do not start in the same second
  setTimeout(() => void tick(), Math.random() * Math.min(ref.intervalS, 30) * 1000)
}

for (const ref of refs) schedule(ref)
setInterval(() => void flush(), FLUSH_MS)
console.log(`probe ${vantage}: ${refs.length} checks -> ${ingestUrl}`)

createServer((req, res) => {
  if (req.url !== '/healthz') return void res.writeHead(404).end()
  // unhealthy when the core has been unreachable for a while: the container shows it
  const stale = lastPostOk !== null ? Date.now() - lastPostOk > 5 * 60_000 : false
  res.writeHead(stale ? 503 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: stale ? 'down' : 'ok', vantage, checks: refs.length, lastPostError }))
}).listen(Number(process.env.PORT ?? 3001))

