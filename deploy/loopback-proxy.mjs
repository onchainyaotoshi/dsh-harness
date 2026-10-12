// Loopback proxy: Host/Origin rewriting plus optional Cloudflare Access SSO.
// Access bridge mode validates the signed application JWT on EVERY HTTP request
// and WebSocket handshake before supplying a server-held DSH session cookie.
// The DSH launch token and cookie never need to reach the user's browser.
import http from 'node:http'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { createAccessVerifier, createDshSession } from './access-auth.mjs'

export function createProxy({ port = 3080, verifyAccess, getDshCookie, hostname, log = false } = {}) {
  const authority = `127.0.0.1:${port}`
  async function headersFor(req) {
    const headers = { ...req.headers, host: authority }
    if (verifyAccess) {
      if (req.headers.host !== hostname || req.headers['sec-fetch-site'] === 'cross-site') return { status: 403 }
      if (req.headers.origin !== undefined && req.headers.origin !== `https://${hostname}`) return { status: 403 }
      if (!await verifyAccess(req.headers['cf-access-jwt-assertion'])) return { status: 403 }
      try {
        const cookie = await getDshCookie()
        // Client-supplied DSH cookies cannot override the server-held session.
        const otherCookies = (headers.cookie ?? '').split(';').filter(c => !c.trim().startsWith('dsh-auth-')).map(c => c.trim()).filter(Boolean)
        headers.cookie = [...otherCookies, cookie].join('; ')
      } catch {
        return { status: 503 }
      }
      delete headers['cf-access-jwt-assertion']
      delete headers['cf-access-authenticated-user-email']
    }
    if (headers.origin !== undefined) headers.origin = `http://${authority}`
    return { headers }
  }
  const deny = (res, status) => {
    res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.end(status === 403 ? 'Cloudflare Access authentication required.\n' : 'DSH authentication temporarily unavailable.\n')
  }
  const server = http.createServer(async (req, res) => {
    const result = await headersFor(req)
    if (result.status) return deny(res, result.status)
    if (verifyAccess && req.method === 'GET') {
      const url = new URL(req.url, 'http://proxy.invalid')
      if (url.pathname === '/' && url.searchParams.has('token')) {
        url.searchParams.delete('token')
        res.writeHead(303, { location: `/${url.search}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        return res.end()
      }
    }
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: result.headers }, upstreamRes => {
      if (log && (req.url?.startsWith('/api') || req.url?.split('?')[0] === '/')) console.log(`${req.method} ${req.url.split('?')[0]} -> ${upstreamRes.statusCode}`)
      const headers = { ...upstreamRes.headers }
      if (verifyAccess && headers['set-cookie']) {
        headers['set-cookie'] = headers['set-cookie'].filter(c => !c.startsWith('dsh-auth-'))
        if (!headers['set-cookie'].length) delete headers['set-cookie']
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('proxy: upstream unavailable\n')
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('upgrade', async (req, clientSocket, head) => {
    clientSocket.pause()
    clientSocket.on('error', () => clientSocket.destroy())
    const result = await headersFor(req)
    if (clientSocket.destroyed) return
    if (result.status) {
      clientSocket.end(`HTTP/1.1 ${result.status} ${result.status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      clientSocket.resume()
      return
    }
    if (log) console.log(`UPGRADE ${req.url?.split('?')[0]}`)
    const upstream = net.connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(result.headers)) {
        if (Array.isArray(value)) for (const v of value) lines.push(`${name}: ${v}`)
        else if (value !== undefined) lines.push(`${name}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
      clientSocket.resume()
    })
    const drop = () => { upstream.destroy(); clientSocket.destroy() }
    upstream.on('error', drop)
    clientSocket.on('error', drop)
    clientSocket.on('close', () => upstream.destroy())
  })
  server.on('connection', socket => socket.setNoDelay(true))
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const issuer = process.env.DSH_ACCESS_ISSUER
  const audience = process.env.DSH_ACCESS_AUD
  const hostname = process.env.DSH_ACCESS_HOSTNAME
  if ([issuer, audience, hostname].some(Boolean) && ![issuer, audience, hostname].every(Boolean)) {
    throw new Error('DSH_ACCESS_ISSUER, DSH_ACCESS_AUD and DSH_ACCESS_HOSTNAME must be set together')
  }
  const server = createProxy({
    verifyAccess: issuer ? createAccessVerifier({ issuer, audience }) : undefined,
    getDshCookie: issuer ? createDshSession() : undefined,
    hostname, log: process.env.DSH_PROXY_LOG === '1',
  })
  server.listen(3081, '127.0.0.1', () => {
    console.log(`dsh loopback proxy: 127.0.0.1:3081 -> 127.0.0.1:3080; ${issuer ? 'Cloudflare Access SSO enabled' : 'manual DSH authentication'}`)
  })
}
