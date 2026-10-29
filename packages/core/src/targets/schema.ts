import { z } from 'zod'
import { activeConfigSchemas, type ActiveKind } from '../checkers/config'

export const CHECK_KINDS = [
  'http',
  'json',
  'tls',
  'domain',
  'dns',
  'tcp',
  'smtp',
  'heartbeat',
  'agent',
  'queue',
] as const

export const checkSchema = z
  .object({
    kind: z.enum(CHECK_KINDS),
    interval_s: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().max(10_000).optional(),
    vantage: z.array(z.string().min(1)).min(1).optional(),
    // kind-specific options (url, host, port, keyword, ...) are validated per checker in Phase 1
    config: z.record(z.unknown()).default({}),
  })
  .strict()
  .superRefine((check, ctx) => {
    // active kinds get strict per-kind validation; passive kinds (heartbeat/agent/queue) stay free-form until Phase 4/5
    const schema = activeConfigSchemas[check.kind as ActiveKind]
    if (!schema) return
    const parsed = schema.safeParse(check.config)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: ['config', ...issue.path] })
    }
  })

export const maintenanceSchema = z
  .object({
    start: z.string().datetime(),
    end: z.string().datetime(),
    reason: z.string().optional(),
  })
  .strict()

export const targetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug'),
    name: z.string().min(1),
    group: z.string().min(1),
    // required on purpose: a target without an audience must never load
    audience: z.enum(['roco', 'admin']),
    tags: z.array(z.string()).default([]),
    env: z.string().default('production'),
    host: z.string().optional(),
    note: z.string().optional(),
    checks: z.array(checkSchema).default([]),
    maintenance: z.array(maintenanceSchema).default([]),
  })
  .strict()

export const targetsFileSchema = z
  .object({
    targets: z.array(targetSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>()
    file.targets.forEach((t, i) => {
      if (seen.has(t.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targets', i, 'id'],
          message: `duplicate target id "${t.id}"`,
        })
      }
      seen.add(t.id)
    })
  })

export type Target = z.infer<typeof targetSchema>
export type TargetsFile = z.infer<typeof targetsFileSchema>
