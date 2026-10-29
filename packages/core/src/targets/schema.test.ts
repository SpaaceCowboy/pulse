import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTargets, parseTargets } from './load'

const base = `
targets:
  - id: a
    name: A
    group: G
    audience: roco
    checks:
      - kind: http
        config: { url: "https://example.com" }
`

describe('targets schema', () => {
  it('accepts a valid target', () => {
    expect(parseTargets(base).targets).toHaveLength(1)
  })

  it('rejects a target without audience', () => {
    expect(() => parseTargets(base.replace('    audience: roco\n', ''))).toThrow(/audience/)
  })

  it('rejects an unknown audience', () => {
    expect(() => parseTargets(base.replace('roco', 'public'))).toThrow()
  })

  it('rejects an unknown check kind', () => {
    expect(() => parseTargets(base.replace('kind: http', 'kind: ping'))).toThrow()
  })

  it('rejects duplicate ids', () => {
    const dup = base + base.replace('targets:\n', '')
    expect(() => parseTargets(dup)).toThrow(/duplicate/)
  })

  it('validates the real targets.yaml', () => {
    const file = loadTargets(resolve(__dirname, '../../../../targets.yaml'))
    expect(file.targets.every((t) => t.audience === 'roco' || t.audience === 'admin')).toBe(true)
  })
})
