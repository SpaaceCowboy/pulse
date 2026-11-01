// Three tiny HTTP fixtures (4101 roco, 4102 admin, 4103 shared infra) plus a control port (4100):
// POST /stop/<port> closes that fixture so its check starts failing; POST /start/<port> brings it back.
import { createServer } from 'node:http'

const servers = new Map()
const open = (port) => {
  const s = createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1')
  servers.set(port, s)
}
for (const port of [4101, 4102, 4103]) open(port)

createServer((req, res) => {
  const m = /^\/(stop|start)\/(\d+)$/.exec(req.url ?? '')
  const port = m ? Number(m[2]) : 0
  if (req.method === 'POST' && m?.[1] === 'stop' && servers.has(port)) {
    const s = servers.get(port)
    servers.delete(port)
    s.closeAllConnections?.()
    s.close(() => res.end('stopped'))
  } else if (req.method === 'POST' && m?.[1] === 'start' && [4101, 4102, 4103].includes(port) && !servers.has(port)) {
    open(port)
    res.end('started')
  } else {
    res.statusCode = 404
    res.end()
  }
}).listen(4100, '127.0.0.1', () => console.log('fixtures ready'))
