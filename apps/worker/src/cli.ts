import { loadTargets } from '@pulse/core'
import { isPlaceholder, listChecks, runCheck, type CheckRef } from './run-check'

// usage: pnpm check [<target-id>|all] [--targets path/to/targets.yaml]
const args = process.argv.slice(2)
const flag = args.indexOf('--targets')
const file = flag >= 0 ? args.splice(flag, 2)[1]! : process.env.TARGETS_FILE ?? 'targets.yaml'
const which = args[0] ?? 'all'

const { targets } = loadTargets(file)
const selected = which === 'all' ? targets : targets.filter((t) => t.id === which)
if (selected.length === 0) {
  console.error(`no such target "${which}". known: ${targets.map((t) => t.id).join(', ')}`)
  process.exit(2)
}

const refs = listChecks(selected)
const CONCURRENCY = 10
const rows: { ref: CheckRef; status: string; ms: string; message: string }[] = []

let next = 0
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, refs.length) }, async () => {
    while (next < refs.length) {
      const ref = refs[next++]!
      const r = await runCheck(ref)
      rows.push({
        ref,
        status: isPlaceholder(ref) ? `${r.status}*` : r.status,
        ms: r.latencyMs === undefined ? '-' : `${r.latencyMs}ms`,
        message: r.message ?? '',
      })
    }
  }),
)

rows.sort((a, b) => a.ref.id.localeCompare(b.ref.id))
const pad = (s: string, n: number) => s.padEnd(n)
const w = Math.max(...rows.map((r) => r.ref.id.length), 5)
console.log(`${pad('CHECK', w)}  ${pad('STATUS', 9)} ${pad('LATENCY', 8)} MESSAGE`)
for (const r of rows) console.log(`${pad(r.ref.id, w)}  ${pad(r.status, 9)} ${pad(r.ms, 8)} ${r.message}`)
if (rows.some((r) => r.status.endsWith('*'))) console.log('\n* placeholder host in targets.yaml (.example) - not a real failure')
const passive = selected.flatMap((t) => t.checks.filter((c) => !['http', 'json', 'tls', 'domain', 'dns', 'tcp', 'smtp'].includes(c.kind)).map((c) => `${t.id}:${c.kind}`))
if (passive.length) console.log(`passive (not polled): ${passive.join(', ')}`)
process.exit(rows.some((r) => r.status === 'down') ? 1 : 0)
