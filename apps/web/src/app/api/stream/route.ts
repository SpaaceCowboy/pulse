import { diffSnapshots } from '@/lib/diff'
import type { Snapshot } from '@/lib/types'
import { getSnapshot } from '@/server/status'
import { getViewer, refreshViewer } from '@/server/viewer'

export const dynamic = 'force-dynamic'

const TICK_MS = 5_000
const MAX_LIFETIME_MS = 60 * 60_000 // EventSource reconnects on its own and re-authenticates

/**
 * Server-sent events: one full `snapshot`, then `diff` events with only changed targets. Each connection
 * builds its own view through getSnapshot(viewer), so an event can only contain what that viewer may see,
 * and the viewer is re-read from the users table every tick (deleted/demoted users are cut off).
 */
export async function GET(req: Request) {
  const first = await getViewer()
  if (!first) return new Response('unauthorized', { status: 401 })

  const enc = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => timer && clearInterval(timer)

  const stream = new ReadableStream({
    async start(controller) {
      let prev: Snapshot | null = null
      let busy = false
      const started = Date.now()
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      const close = () => {
        stop()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      const tick = async () => {
        if (busy) return
        busy = true
        try {
          const viewer = await refreshViewer(first.id)
          if (!viewer || Date.now() - started > MAX_LIFETIME_MS) return close()
          const next = await getSnapshot(viewer)
          if (!prev) send('snapshot', next)
          else {
            const diff = diffSnapshots(prev, next)
            if (diff.upserts.length || diff.removed.length) send('diff', diff)
            else controller.enqueue(enc.encode(': keep-alive\n\n'))
          }
          prev = next
        } catch {
          close()
        } finally {
          busy = false
        }
      }

      req.signal.addEventListener('abort', close)
      controller.enqueue(enc.encode('retry: 3000\n\n'))
      await tick()
      timer = setInterval(tick, TICK_MS)
    },
    cancel: stop,
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
