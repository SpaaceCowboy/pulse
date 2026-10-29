// User management. There is no sign-up route: this CLI is the only way accounts are created.
//   pnpm user create <email> --role ADMIN|USER [--password-stdin]
//   pnpm user token <email> | reset-totp <email> | set-role <email> <ROLE> | passwd <email> | delete <email> | list
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { generateApiToken, generateTotpSecret, hashPassword, totpUri } from '@pulse/core'
import { createDb } from './client'
import { createUser, deleteUser, findUserByEmail, listUsers, updateUser } from './users'

const MIN_PASSWORD = 12

async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    let data = ''
    for await (const chunk of process.stdin) data += chunk
    return data.replace(/\r?\n$/, '')
  }
  const muted = new Writable({ write: (_c, _e, cb) => cb() })
  process.stderr.write('Password: ')
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
  const pw = await new Promise<string>((resolve) => rl.question('', resolve))
  rl.close()
  process.stderr.write('\n')
  return pw
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const [cmd, email, extra] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'))
const url = process.env.DATABASE_URL
if (!url) fail('missing env DATABASE_URL')
const { db, pool } = createDb(url)

try {
  if (cmd === 'list') {
    for (const u of await listUsers(db)) console.log(`${u.email}\t${u.role}\ttoken:${u.apiTokenHash ? 'yes' : 'no'}`)
  } else if (!email) {
    fail('usage: user create|token|reset-totp|set-role|passwd|delete <email> ... | user list')
  } else if (cmd === 'create') {
    const ri = process.argv.indexOf('--role')
    const role = ri >= 0 ? process.argv[ri + 1] : undefined
    if (role !== 'ADMIN' && role !== 'USER') fail('--role ADMIN|USER is required')
    if (await findUserByEmail(db, email)) fail(`user ${email} already exists`)
    const password = await readPassword(flags.includes('--password-stdin'))
    if (password.length < MIN_PASSWORD) fail(`password must be at least ${MIN_PASSWORD} characters`)
    const totpSecret = generateTotpSecret()
    const user = await createUser(db, { email, passwordHash: await hashPassword(password), totpSecret, role })
    console.log(`created ${user.email} (${user.role})`)
    console.log(`TOTP secret (shown once): ${totpSecret}`)
    console.log(`otpauth URI: ${totpUri(totpSecret, user.email)}`)
  } else if (cmd === 'token') {
    const { token, hash } = generateApiToken()
    if (!(await updateUser(db, email, { apiTokenHash: hash }))) fail(`no such user ${email}`)
    console.log(`API token for ${email} (shown once, replaces any previous token):\n${token}`)
  } else if (cmd === 'reset-totp') {
    const totpSecret = generateTotpSecret()
    if (!(await updateUser(db, email, { totpSecret, totpLastStep: null }))) fail(`no such user ${email}`)
    console.log(`TOTP secret (shown once): ${totpSecret}\notpauth URI: ${totpUri(totpSecret, email)}`)
  } else if (cmd === 'set-role') {
    if (extra !== 'ADMIN' && extra !== 'USER') fail('usage: user set-role <email> ADMIN|USER')
    if (!(await updateUser(db, email, { role: extra }))) fail(`no such user ${email}`)
    console.log(`${email} is now ${extra}`)
  } else if (cmd === 'passwd') {
    const password = await readPassword(flags.includes('--password-stdin'))
    if (password.length < MIN_PASSWORD) fail(`password must be at least ${MIN_PASSWORD} characters`)
    if (!(await updateUser(db, email, { passwordHash: await hashPassword(password) }))) fail(`no such user ${email}`)
    console.log('password updated')
  } else if (cmd === 'delete') {
    if (!(await deleteUser(db, email))) fail(`no such user ${email}`)
    console.log(`deleted ${email}`)
  } else {
    fail(`unknown command ${cmd}`)
  }
} finally {
  await pool.end()
}
