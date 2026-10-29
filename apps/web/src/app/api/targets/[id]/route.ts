import { NextResponse } from 'next/server'
import { getTargetDetail } from '@/server/status'
import { getViewer } from '@/server/viewer'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer()
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  // 404 both for unknown ids and for targets outside the viewer's scope.
  const detail = await getTargetDetail(viewer, id)
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, no-store' } })
}
