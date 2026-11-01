import { NextResponse } from 'next/server'
import { acceptPush } from '@/server/ingest'

export const dynamic = 'force-dynamic'

const clientIp = (req: Request) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

/**
 * Heartbeat ping: `POST /api/push/:token`. Machine route, authenticated by the secret token in the URL.
 * Failure report: `?status=fail` (or JSON `{ "status": "fail", "message": "..." }`).
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const url = new URL(req.url)
  let status = url.searchParams.get('status')
  let message = url.searchParams.get('message') ?? undefined
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const body = (await req.json().catch(() => null)) as { status?: unknown; message?: unknown } | null
    if (typeof body?.status === 'string') status = body.status
    if (typeof body?.message === 'string') message = body.message
  }
  const out = await acceptPush(token, { ok: status !== 'fail', message }, clientIp(req))
  return NextResponse.json(out.body, { status: out.status, headers: { 'Cache-Control': 'no-store' } })
}
