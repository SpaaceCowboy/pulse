import { NextResponse } from 'next/server'
import { H_NONCE, H_SIGNATURE, H_TIMESTAMP } from '@pulse/core'
import { acceptProbeBatch } from '@/server/ingest'

export const dynamic = 'force-dynamic'

const clientIp = (req: Request) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

/** Probe vantage results. Machine route: authenticated by HMAC signature + timestamp + one-time nonce. */
export async function POST(req: Request) {
  const raw = await req.text()
  const out = await acceptProbeBatch(
    raw,
    { timestamp: req.headers.get(H_TIMESTAMP), nonce: req.headers.get(H_NONCE), signature: req.headers.get(H_SIGNATURE) },
    clientIp(req),
  )
  return NextResponse.json(out.body, { status: out.status, headers: { 'Cache-Control': 'no-store' } })
}
