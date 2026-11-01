import { NextResponse, type NextRequest } from 'next/server'

// /api/push/:token and /api/ingest are machine routes with their own auth (secret token / HMAC signature).
// First gate only (edge runtime, no DB): everything except the login page, the Auth.js endpoints and the
// container healthcheck needs a session cookie, or a Bearer header on status.json. The real decision is
// made per request in server/viewer.ts against the users table.
const PUBLIC = [/^\/login$/, /^\/api\/auth\//, /^\/api\/healthz$/, /^\/robots\.txt$/, /^\/api\/push\/[^/]+$/, /^\/api\/ingest$/]

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next()

  const hasSession = req.cookies.getAll().some((c) => /authjs\.session-token/.test(c.name))
  const hasBearer = /^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '')
  if (hasSession || (hasBearer && pathname === '/api/status.json')) return NextResponse.next()

  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = req.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  return NextResponse.redirect(url)
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
