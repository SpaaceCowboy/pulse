import { NextResponse } from 'next/server'
import { listIncidents } from '@/server/status'
import { getViewer } from '@/server/viewer'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const viewer = await getViewer()
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 100)
  return NextResponse.json(
    { incidents: await listIncidents(viewer, Number.isFinite(limit) ? limit : 100) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
