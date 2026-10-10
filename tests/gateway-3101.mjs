// Minimal caddy-mirror gateway for Vox-Shift sandbox tests (round-13 replica).
// :3101 → :3100 (Next app) by default; ?XTransformPort=3003 → :3003 (translator).
// Handles HTTP + WebSocket upgrades (socket.io). NODE (not bun) is required —
// bun's http server does not emit the 'upgrade' event reliably here.
import http from 'http'

const PORT = 3101
const APP = 'http://127.0.0.1:3100'
const SERVICES = { 3003: 'http://127.0.0.1:3003', 3004: 'http://127.0.0.1:3004' }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const port = u.searchParams.get('XTransformPort')
  const target = port && SERVICES[port] ? SERVICES[port] : APP
  // Strip the transform param before proxying (caddy behaves the same).
  u.searchParams.delete('XTransformPort')
  const proxyReq = http.request(
    `${target}${u.pathname}${u.search}`,
    { method: req.method, headers: { ...req.headers, host: new URL(target).host } },
    (pr) => {
      res.writeHead(pr.statusCode ?? 502, pr.headers)
      pr.pipe(res)
    }
  )
  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(e) }))
  })
  req.pipe(proxyReq)
})

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x')
  const port = u.searchParams.get('XTransformPort')
  const target = port && SERVICES[port] ? SERVICES[port] : APP
  const targetUrl = new URL(`${target}${req.url}`)
  const prox = http.request({
    host: targetUrl.hostname,
    port: targetUrl.port || 80,
    method: req.method,
    path: targetUrl.pathname + targetUrl.search,
    headers: req.headers,
  })
  prox.on('upgrade', (pres, psocket, phead) => {
    const lines = []
    lines.push(`HTTP/1.1 101 Switching Protocols`)
    for (const [k, v] of Object.entries(pres.headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (phead?.length) socket.write(phead)
    psocket.pipe(socket)
    socket.pipe(psocket)
    psocket.on('error', () => socket.destroy())
    socket.on('error', () => psocket.destroy())
  })
  prox.on('error', () => socket.destroy())
  prox.end(head)
})

server.listen(PORT, () => console.log(`[gateway] :${PORT} → app :3100 · translator :3003 · rest :3004`))
