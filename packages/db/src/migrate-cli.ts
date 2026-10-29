import pg from 'pg'
import { migrateDown, migrateUp, migrationStatus } from './migrate'

const [cmd = 'status', arg] = process.argv.slice(2)
const url = process.env.DATABASE_URL
if (!url) throw new Error('missing env DATABASE_URL')

const pool = new pg.Pool({ connectionString: url })
try {
  if (cmd === 'up') {
    console.log('applied:', (await migrateUp(pool)).join(', ') || '(nothing pending)')
  } else if (cmd === 'down') {
    console.log('reverted:', (await migrateDown(pool, arg ? Number(arg) : 1)).join(', ') || '(nothing applied)')
  } else if (cmd === 'status') {
    for (const m of await migrationStatus(pool)) console.log(`${m.applied ? '[x]' : '[ ]'} ${m.name}`)
  } else {
    console.error('usage: migrate up | down [steps] | status')
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
