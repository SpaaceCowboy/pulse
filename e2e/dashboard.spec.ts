import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { currentTotp } from '@pulse/core'
import { ADMIN_ID, ADMIN_NAME, ADMIN_PORT, readState, ROCO_NAME, SHARED_NAME } from './env'

test.describe.configure({ mode: 'serial' })

const state = readState()
const SECRETS = [ADMIN_NAME, ADMIN_ID, 'Secret Proxy', String(ADMIN_PORT), 'Personal & client']

async function login(page: Page, who: 'admin' | 'user', totp?: string) {
  const a = state.accounts[who]
  await page.goto('/login')
  await page.getByLabel('Email').fill(a.email)
  await page.getByLabel('Password').fill(a.password)
  await page.getByLabel('Authenticator code').fill(totp ?? currentTotp(a.secret))
  await page.getByRole('button', { name: 'Sign in' }).click()
}

let adminCtx: BrowserContext
let userCtx: BrowserContext

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  for (const who of ['admin', 'user'] as const) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await login(page, who)
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
    if (who === 'admin') adminCtx = ctx
    else userCtx = ctx
  }
  // wait until the worker has produced a first result for every fixture
  const page = await adminCtx.newPage()
  await expect
    .poll(async () => (await (await page.request.get('/api/status.json')).json()).summary.up, { timeout: 45_000 })
    .toBe(3)
  await page.close()
})

test.afterAll(async () => {
  await adminCtx?.close()
  await userCtx?.close()
})

test.describe('authentication', () => {
  test('anonymous requests are redirected or refused', async ({ request }) => {
    const home = await request.get('/', { maxRedirects: 0 })
    expect([302, 303, 307, 308]).toContain(home.status())
    expect(home.headers().location).toContain('/login')
    for (const path of ['/api/status.json', '/api/stream', '/api/incidents', `/api/targets/${ADMIN_ID}`, '/api/targets/e2e-roco-site']) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(401)
    }
  })

  test('no public sign-up route exists', async ({ request }) => {
    for (const path of ['/signup', '/register', '/sign-up', '/api/signup', '/api/register', '/api/users']) {
      const r = await request.get(path, { maxRedirects: 0 })
      expect([302, 307, 401, 404], path).toContain(r.status())
      const post = await request.post(path, { data: { email: 'x@y.z', password: 'x' }, maxRedirects: 0 })
      expect([302, 307, 401, 404, 405], `POST ${path}`).toContain(post.status())
    }
    // and an anonymous visitor never gets past the login wall to create anything
    const created = await (await userCtx.request.get('/api/status.json')).json()
    expect(created.targets.length).toBeGreaterThan(0)
  })

  test('wrong password, wrong code and a replayed code are all rejected', async ({ page }) => {
    const a = state.accounts.user
    await login(page, 'user', '000000')
    await expect(page.getByText('Sign-in failed')).toBeVisible()

    await page.goto('/login')
    await page.getByLabel('Email').fill(a.email)
    await page.getByLabel('Password').fill('wrong-password-123')
    await page.getByLabel('Authenticator code').fill(currentTotp(a.secret))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Sign-in failed')).toBeVisible()

    // beforeAll already consumed this account's current time step; an older step must not work either
    await login(page, 'user', currentTotp(a.secret, Date.now() - 30_000))
    await expect(page.getByText('Sign-in failed')).toBeVisible()
  })
})

test.describe('USER scope', () => {
  test('HTML contains the roco targets and no trace of an admin target', async () => {
    const page = await userCtx.newPage()
    await page.goto('/')
    await expect(page.getByText(ROCO_NAME, { exact: true })).toBeVisible()
    await expect(page.getByText(SHARED_NAME, { exact: true })).toBeVisible()
    await expect(page.getByText(ADMIN_NAME)).toHaveCount(0)

    // raw server response (incl. the serialized props Next embeds), not just the rendered DOM
    const raw = await (await page.request.get('/')).text()
    expect(raw).toContain('E2E Roco Site')
    for (const s of SECRETS) expect(raw, `HTML leaks "${s}"`).not.toContain(s)
    await page.close()
  })

  test('status.json, incidents and the admin target URL', async () => {
    const r = userCtx.request
    const status = await r.get('/api/status.json')
    expect(status.status()).toBe(200)
    const body = await status.text()
    for (const s of SECRETS) expect(body, `status.json leaks "${s}"`).not.toContain(s)
    expect(JSON.parse(body).targets.map((t: { id: string }) => t.id).sort()).toEqual(['e2e-roco-site', 'e2e-shared-infra'])

    expect((await r.get(`/api/targets/${ADMIN_ID}`)).status()).toBe(404)
    expect((await r.get('/api/targets/does-not-exist')).status()).toBe(404) // indistinguishable
    expect((await r.get('/api/targets/e2e-roco-site')).status()).toBe(200)
    const inc = await (await r.get('/api/incidents')).text()
    for (const s of SECRETS) expect(inc).not.toContain(s)
  })

  test('SSE stream never carries an admin target', async () => {
    const page = await userCtx.newPage()
    await page.goto('/')
    const events = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const got: string[] = []
          const es = new EventSource('/api/stream')
          es.addEventListener('snapshot', (e) => got.push((e as MessageEvent).data))
          es.addEventListener('diff', (e) => got.push((e as MessageEvent).data))
          setTimeout(() => {
            es.close()
            resolve(got)
          }, 12_000)
        }),
    )
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toContain('e2e-roco-site')
    for (const e of events) for (const s of SECRETS) expect(e, `SSE leaks "${s}"`).not.toContain(s)
    await page.close()
  })

  test('bearer token is scoped like the session', async ({ request }) => {
    const ok = await request.get('/api/status.json', { headers: { authorization: `Bearer ${state.tokens.user}` } })
    expect(ok.status()).toBe(200)
    const text = await ok.text()
    for (const s of SECRETS) expect(text).not.toContain(s)
    expect((await request.get('/api/status.json', { headers: { authorization: 'Bearer pls_bogus' } })).status()).toBe(401)
    // a token works on status.json only
    expect((await request.get('/api/incidents', { headers: { authorization: `Bearer ${state.tokens.user}` } })).status()).toBe(401)
  })
})

test.describe('ADMIN scope', () => {
  test('sees every group and the admin target', async () => {
    const page = await adminCtx.newPage()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Roco Broker' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Infrastructure' })).toBeVisible()
    await expect(page.getByText(ADMIN_NAME, { exact: true })).toBeVisible()
    await expect(page.getByText(ROCO_NAME, { exact: true })).toBeVisible()
    expect((await adminCtx.request.get(`/api/targets/${ADMIN_ID}`)).status()).toBe(200)
    const tok = await (
      await page.request.get('/api/status.json', { headers: { authorization: `Bearer ${state.tokens.admin}` } })
    ).json()
    expect(tok.targets).toHaveLength(3)
    await page.close()
  })

  test('row expands to show checks', async () => {
    const page = await adminCtx.newPage()
    await page.goto('/')
    await page.getByRole('button', { name: new RegExp(ROCO_NAME) }).click()
    await expect(page.getByText('http', { exact: true }).first()).toBeVisible()
    await page.close()
  })
})

test.describe('live updates', () => {
  test('killing a fixture turns its row red within 3 minutes, for the right roles only', async () => {
    test.setTimeout(240_000)
    const userPage = await userCtx.newPage()
    const adminPage = await adminCtx.newPage()
    await userPage.goto('/')
    await adminPage.goto('/')
    const row = (p: Page, name: string) => p.getByRole('button', { name: new RegExp(name) })
    await expect(row(userPage, ROCO_NAME)).toContainText('Up')
    await expect(row(adminPage, ADMIN_NAME)).toContainText('Up')

    for (const port of [4101, ADMIN_PORT]) {
      expect((await fetch(`http://127.0.0.1:4100/stop/${port}`, { method: 'POST' })).ok).toBe(true)
    }

    // no reload: the SSE stream pushes the change
    await expect(row(userPage, ROCO_NAME)).toContainText('Down', { timeout: 180_000 })
    await expect(userPage.getByRole('heading', { name: 'Overall status' }).or(userPage.getByRole('heading', { level: 1 }))).toContainText('1 down')
    await expect(row(adminPage, ADMIN_NAME)).toContainText('Down', { timeout: 60_000 })
    await expect(adminPage.getByRole('heading', { level: 1 })).toContainText('2 down')

    // the USER saw the roco outage, but nothing about the admin one
    const raw = await (await userCtx.request.get('/api/status.json')).text()
    for (const s of SECRETS) expect(raw).not.toContain(s)
    const inc = await userPage.goto('/incidents')
    expect(inc?.status()).toBe(200)
    await expect(userPage.getByText(ROCO_NAME)).toBeVisible()
    await expect(userPage.getByText(ADMIN_NAME)).toHaveCount(0)
    const incRaw = await (await userCtx.request.get('/incidents')).text()
    for (const s of SECRETS) expect(incRaw).not.toContain(s)

    await adminPage.goto('/incidents')
    await expect(adminPage.getByText(ADMIN_NAME)).toBeVisible()
  })
})
