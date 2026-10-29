// pnpm lighthouse: mobile Lighthouse (default emulation + throttling) on /login and the logged-in dashboard
// against the isolated e2e stack. Fails below 90 in any category. Needs a prior `pnpm --filter @pulse/web build`
// (PULSE_NO_STANDALONE=1 on Windows) and the dev Postgres/Redis services.
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { launch } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import { currentTotp } from '@pulse/core'
import { PORT, readState } from './env'
import { down, up } from './stack.mts'

process.env.PULSE_NO_STANDALONE = '1'
const THRESHOLD = 90
const base = `http://127.0.0.1:${PORT}`
let failed = false

try {
  await up()
  const s = readState()
  const a = s.accounts.admin

  // real session cookie, obtained through the login form
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()
  await page.goto(`${base}/login`)
  await page.getByLabel('Email').fill(a.email)
  await page.getByLabel('Password').fill(a.password)
  await page.getByLabel('Authenticator code').fill(currentTotp(a.secret))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('navigation', { name: 'Primary' }).waitFor()
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  await browser.close()
  await new Promise((r) => setTimeout(r, 15_000)) // let the worker produce a few results

  const chrome = await launch({ chromeFlags: ['--headless=new', '--no-sandbox'] })
  const reports: Record<string, unknown> = {}
  try {
    for (const [name, path, headers] of [
      ['login', '/login', undefined],
      ['dashboard', '/', { Cookie: cookie }],
      ['incidents', '/incidents', { Cookie: cookie }],
    ] as const) {
      const run = await lighthouse(`${base}${path}`, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        extraHeaders: headers,
        // no 'seo': the app is deliberately noindex (docs/PLAN.md: not publicly indexed), which Lighthouse scores as a failure
        onlyCategories: ['performance', 'accessibility', 'best-practices'],
      })
      const lhr = run!.lhr
      reports[name] = lhr
      const scores = Object.fromEntries(Object.entries(lhr.categories).map(([k, v]) => [k, Math.round((v.score ?? 0) * 100)]))
      const final = new URL(lhr.finalDisplayedUrl).pathname
      console.log(`${name.padEnd(10)} ${final.padEnd(11)}`, scores)
      if (final !== path) {
        console.error(`  !! ${name}: landed on ${final}, not ${path} (auth cookie not accepted?)`)
        failed = true
      }
      for (const [k, sc] of Object.entries(scores)) {
        if (sc < THRESHOLD) {
          failed = true
          console.error(`  !! ${name}: ${k} ${sc} < ${THRESHOLD}`)
          for (const audit of Object.values(lhr.audits)) {
            if (audit.score !== null && audit.score < 0.9 && lhr.categories[k]!.auditRefs.some((r) => r.id === audit.id))
              console.error(`     - ${audit.id}: ${audit.title}`)
          }
        }
      }
    }
  } finally {
    await chrome.kill()
  }
  writeFileSync('lighthouse-report.json', JSON.stringify(reports, null, 1))
} finally {
  await down()
}
process.exit(failed ? 1 : 0)
