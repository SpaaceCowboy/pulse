// Three tiny HTTP fixtures (4101 roco, 4102 admin, 4103 shared infra) plus a control port (4100):
// POST /stop/<port> closes that fixture so its check starts failing.
import { createServer } from 'node:http'

const servers = new Map()
for (const port of [4101, 4102, 4103]) {
  const s = createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1')
  servers.set(port, s)
}
createServer((req, res) => {
  const m = /^\/stop\/(\d+)$/.exec(req.url ?? '')
  const s = m && servers.get(Number(m[1]))
  if (req.method === 'POST' && s) {
    s.closeAllConnections?.()
    s.close(() => res.end('stopped'))
  } else {
    res.statusCode = 404
    res.end()
  }
}).listen(4100, '127.0.0.1', () => console.log('fixtures ready'))
