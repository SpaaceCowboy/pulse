import { ZodError } from 'zod'
import { loadTargets } from './load'

const path = process.argv[2]
if (!path) {
  console.error('usage: validate-cli <targets.yaml>')
  process.exit(2)
}

try {
  const { targets } = loadTargets(path)
  const roco = targets.filter((t) => t.audience === 'roco').length
  console.log(`ok: ${targets.length} targets (${roco} roco, ${targets.length - roco} admin)`)
} catch (err) {
  if (err instanceof ZodError) {
    for (const issue of err.issues) console.error(`${issue.path.join('.')}: ${issue.message}`)
  } else {
    console.error(err)
  }
  process.exit(1)
}
