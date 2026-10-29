import { z } from 'zod'

// Per-kind check config (the `config:` block of a check in targets.yaml).
// timeout_ms / interval_s / vantage live on the check itself, not here.
// Checker.run() receives the PARSED config (defaults applied).

export const httpConfigSchema = z
  .object({
    url: z.string().url(),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    expect_status: z.union([z.number().int(), z.array(z.number().int()).min(1)]).default(200),
    keyword: z.string().optional(), // body must contain this
    max_redirects: z.number().int().min(0).max(3).default(3),
    latency_degraded_ms: z.number().int().positive().default(2000),
  })
  .strict()
export type HttpConfig = z.infer<typeof httpConfigSchema>

export const jsonAssertionSchema = z
  .object({
    path: z.string(), // JSONPath, e.g. $.checks.db.status
    equals: z.unknown().optional(),
    exists: z.boolean().optional(),
  })
  .strict()

export const jsonConfigSchema = httpConfigSchema
  .extend({
    // default: $.status == "ok"
    assertions: z.array(jsonAssertionSchema).default([{ path: '$.status', equals: 'ok' }]),
    // header carrying the shared /health token; value read from this env var at run time
    token_header: z.string().optional(),
    token_env: z.string().optional(),
  })
  .strict()
export type JsonConfig = z.infer<typeof jsonConfigSchema>

export const tlsConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(443),
    servername: z.string().optional(), // SNI / hostname to verify, defaults to host
    warn_days: z.number().int().positive().default(14),
  })
  .strict()
export type TlsConfig = z.infer<typeof tlsConfigSchema>

export const domainConfigSchema = z
  .object({
    domain: z.string().min(1),
    warn_days: z.number().int().positive().default(30),
  })
  .strict()
export type DomainConfig = z.infer<typeof domainConfigSchema>

export const dnsConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']),
    expect: z.array(z.string()).optional(), // all must be present among the records
    contains: z.string().optional(), // some record must contain this substring
  })
  .strict()
export type DnsConfig = z.infer<typeof dnsConfigSchema>

export const tcpConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    slow_ms: z.number().int().positive().default(1000),
  })
  .strict()
export type TcpConfig = z.infer<typeof tcpConfigSchema>

export const smtpConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false), // implicit TLS (port 465)
    require_starttls: z.boolean().default(true),
  })
  .strict()
export type SmtpConfig = z.infer<typeof smtpConfigSchema>

/** Active (polled) kinds that have a strict config schema. */
export const activeConfigSchemas = {
  http: httpConfigSchema,
  json: jsonConfigSchema,
  tls: tlsConfigSchema,
  domain: domainConfigSchema,
  dns: dnsConfigSchema,
  tcp: tcpConfigSchema,
  smtp: smtpConfigSchema,
} as const
export type ActiveKind = keyof typeof activeConfigSchemas

/** Default polling interval per PLAN.md "Check types" table. */
export const DEFAULT_INTERVAL_S: Record<ActiveKind, number> = {
  http: 60,
  json: 60,
  tls: 6 * 3600,
  domain: 24 * 3600,
  dns: 15 * 60,
  tcp: 60,
  smtp: 5 * 60,
}
