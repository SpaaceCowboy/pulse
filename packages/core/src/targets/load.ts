import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { targetsFileSchema, type TargetsFile } from './schema'

export function parseTargets(yamlText: string): TargetsFile {
  return targetsFileSchema.parse(parse(yamlText))
}

export function loadTargets(path: string): TargetsFile {
  return parseTargets(readFileSync(path, 'utf8'))
}
