// Fake Telegram Bot API + watchdog endpoint for the alerts e2e suite (port 4110).
//   POST /bot<token>/sendMessage | editMessageText | getUpdates | deleteWebhook   (what the worker calls)
//   GET  /watchdog                                                               (external monitor stand-in)
//   GET  /__log      -> { sent, edits, watchdog }
//   POST /__inject   {chatId, text}  queue an incoming message for the bot's next getUpdates
import { createServer } from 'node:http'

const sent = []
const edits = []
let watchdog = 0
let nextId = 5000
let nextUpdate = 1
let pending = []

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const readBody = (req) =>
  new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => resolve(d ? JSON.parse(d) : {}))
  })

createServer(async (req, res) => {
  const url = req.url ?? ''
  if (url === '/watchdog') {
    watchdog++
    return void res.end('OK')
  }
  if (url === '/__log') return json(res, { sent, edits, watchdog })
  if (url === '/__inject' && req.method === 'POST') {
    const b = await readBody(req)
    pending.push({ update_id: nextUpdate++, message: { chat: { id: Number(b.chatId), type: 'private' }, text: b.text } })
    return json(res, { ok: true })
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(url)
  if (!m) return json(res, { ok: false }, 404)
  const body = await readBody(req)
  switch (m[1]) {
    case 'sendMessage': {
      const id = ++nextId
      sent.push({ id, chatId: String(body.chat_id), text: body.text })
      return json(res, { ok: true, result: { message_id: id } })
    }
    case 'editMessageText':
      edits.push({ id: body.message_id, chatId: String(body.chat_id), text: body.text })
      return json(res, { ok: true, result: true })
    case 'getUpdates': {
      const offset = body.offset ?? 0
      pending = pending.filter((u) => u.update_id >= offset)
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 500))
      const out = pending
      return json(res, { ok: true, result: out })
    }
    default:
      return json(res, { ok: true, result: true })
  }
}).listen(4110, '127.0.0.1', () => console.log('fake telegram ready'))
