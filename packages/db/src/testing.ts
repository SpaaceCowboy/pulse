// Integration-test helper: a throwaway database per test file on the server in TEST_DATABASE_URL.
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createDb } from './client'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

export async function createTestDb() {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL not set')
  const name = `pulse_test_${randomBytes(4).toString('hex')}`
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  const { db, pool } = createDb(url.toString())
  return {
    db,
    pool,
    url: url.toString(),
    async drop() {
      await pool.end()
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`)
      await admin.end()
    },
  }
}
