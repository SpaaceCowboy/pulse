import { NextResponse } from 'next/server'
import { getSnapshot } from '@/server/status'
import { getViewerFromRequest } from '@/server/viewer'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const viewer = await getViewerFromRequest(req)
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json(await getSnapshot(viewer), {
    headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
  })
}
