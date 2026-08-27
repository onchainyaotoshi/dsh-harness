// Proxy loopback untuk dsh.
//
// Masalah yang dipecahkan: fence /api milik dsh mengunci bidang konfigurasi
// (settings.*, credentials.*, agentPreset.*, llm.discoverModels) ke loopback --
// `--trusted-host` sengaja diabaikan di sana. Lewat cloudflared, header Host
// berisi nama domain, jadi Settings, Agent presets, Permission, bahkan
// penyimpanan tema semuanya 403.
//
// Proxy ini duduk di antara cloudflared dan dsh, dan menulis ulang Host (plus
// Origin, supaya pagar Origin tetap konsisten) menjadi authority loopback.
// Dari sudut pandang dsh, permintaan datang sebagai loopback same-origin.
//
// Yang TIDAK diubah: header `sec-fetch-*`. Pagar cross-site dsh tetap hidup --
// `sec-fetch-site: cross-site` tetap ditolak.
//
// Konsekuensi keamanan: setelah ini, Cloudflare Access adalah SATU-SATUNYA
// yang melindungi bidang konfigurasi (API key, directory picker, dan
// llm.discoverModels yang membuat host nge-fetch URL pilihan pemanggil).
// Jangan pernah lepas policy Access dari hostname ini.

import http from 'node:http'
import net from 'node:net'

const LISTEN_HOST = '127.0.0.1'
const LISTEN_PORT = 3081
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = 3080

/** Authority yang dilihat dsh; harus loopback agar method istimewa lolos. */
const TARGET_AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`

/**
 * Salin header masuk dengan Host -- dan Origin bila ada -- ditulis ulang ke
 * authority loopback. Origin hanya ditulis ulang, tidak ditambahkan: permintaan
 * tanpa Origin memang sah menurut fence.
 */
function rewriteHeaders(headers) {
  const out = { ...headers }
  out.host = TARGET_AUTHORITY
  if (out.origin !== undefined) out.origin = `http://${TARGET_AUTHORITY}`
  return out
}

/** Log satu baris per permintaan /api dan setiap upgrade; DSH_PROXY_LOG=1 menyalakannya. */
const LOG = process.env.DSH_PROXY_LOG === '1'

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: rewriteHeaders(req.headers),
    },
    (upstreamRes) => {
      if (LOG && req.url?.startsWith('/api')) {
        console.log(`${req.method} ${req.url} -> ${upstreamRes.statusCode}`)
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      // pipe tanpa buffering: SSE dan respons streaming harus lewat apa adanya.
      upstreamRes.pipe(res)
    },
  )

  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`proxy: upstream error: ${error.message}`)
  })

  req.pipe(upstream)
})

// dsh memakai WebSocket untuk channel event; tanpa penanganan upgrade, sesi mati.
server.on('upgrade', (req, clientSocket, head) => {
  if (LOG) console.log(`UPGRADE ${req.url}`)
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headers = rewriteHeaders(req.headers)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const v of value) lines.push(`${name}: ${v}`)
      else if (value !== undefined) lines.push(`${name}: ${value}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  const drop = () => {
    upstream.destroy()
    clientSocket.destroy()
  }
  upstream.on('error', drop)
  clientSocket.on('error', drop)
})

// Nagle mematikan responsivitas stream token-per-token.
server.on('connection', (socket) => socket.setNoDelay(true))

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`dsh loopback proxy: http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_AUTHORITY}`)
})
