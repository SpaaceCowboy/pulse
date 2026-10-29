import type { Checker } from '../types'
import type { ActiveKind } from './config'
import { dnsChecker } from './dns'
import { domainChecker } from './domain'
import { httpChecker } from './http'
import { jsonChecker } from './json'
import { smtpChecker } from './smtp'
import { tcpChecker } from './tcp'
import { tlsChecker } from './tls'

export * from './config'
export * from './util'
export { httpChecker, httpRequest } from './http'
export { jsonChecker } from './json'
export { tlsChecker } from './tls'
export { domainChecker, createDomainChecker } from './domain'
export { dnsChecker, createDnsChecker } from './dns'
export { tcpChecker, createTcpChecker } from './tcp'
export { smtpChecker } from './smtp'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const checkers: Record<ActiveKind, Checker<any>> = {
  http: httpChecker,
  json: jsonChecker,
  tls: tlsChecker,
  domain: domainChecker,
  dns: dnsChecker,
  tcp: tcpChecker,
  smtp: smtpChecker,
}
