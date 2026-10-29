import type { Snapshot, StreamDiff, TargetView } from './types'

export function diffSnapshots(prev: Snapshot | null, next: Snapshot): StreamDiff {
  const before = new Map((prev?.targets ?? []).map((t) => [t.id, JSON.stringify(t)]))
  const upserts = next.targets.filter((t) => before.get(t.id) !== JSON.stringify(t))
  const nowIds = new Set(next.targets.map((t) => t.id))
  const removed = [...before.keys()].filter((id) => !nowIds.has(id))
  return { generatedAt: next.generatedAt, summary: next.summary, upserts, removed }
}

const RANK = { down: 0, degraded: 1, unknown: 2, up: 3 } as const

export function sortTargets(list: TargetView[]): TargetView[] {
  return [...list].sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name))
}

export function applyDiff(snapshot: Snapshot, diff: StreamDiff): Snapshot {
  const map = new Map(snapshot.targets.map((t) => [t.id, t]))
  for (const id of diff.removed) map.delete(id)
  for (const t of diff.upserts) map.set(t.id, t)
  return { generatedAt: diff.generatedAt, summary: diff.summary, targets: sortTargets([...map.values()]) }
}
