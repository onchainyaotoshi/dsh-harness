// Isolated: generated RSA keys, mocked JWKS, and ephemeral loopback HTTP servers.
// No DSH service, user credentials, cloud endpoints, Ginee, or Odoo are accessed.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { createAccessVerifier, createDshSession } from '../deploy/access-auth.mjs'
import { createProxy } from '../deploy/loopback-proxy.mjs'

const issuer = 'https://test-team.cloudflareaccess.com'
const audience = 'fixture-audience'
const hostname = 'test.example'
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
const start = 1900000000000
function jwt(claims = {}, header = {}, key = privateKey) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ iss: issuer, aud: [audience], type: 'app', exp: start / 1000 + 600, iat: start / 1000, ...claims })}`
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`
}
function verifier(options = {}) {
  return createAccessVerifier({ issuer, audience, now: () => start,
    fetchKeys: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }), ...options })
}
async function listen(server, t) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return server.address().port
}
async function request(port, path = '/', headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
async function upgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(['GET /api/remote.mux HTTP/1.1', 'Connection: Upgrade', 'Upgrade: websocket',
        ...Object.entries({ host: hostname, ...headers }).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n'))
    })
    socket.setTimeout(5000, () => socket.destroy(new Error('test timeout')))
    socket.once('error', reject)
    socket.once('data', data => { socket.destroy(); resolve(data.toString()) })
  })
}

test('Access verifier requires signature, exact issuer/app audience, app type, and current lifetime', async () => {
  const verify = verifier()
  assert.equal(await verify(jwt()), true)
  const invalid = [undefined, '', 'broken.jwt.token', jwt({ aud: ['another-app'] }), jwt({ iss: 'https://other.cloudflareaccess.com' }),
    jwt({ type: 'meta' }), jwt({ exp: start / 1000 }), jwt({ exp: '9999999999' }), jwt({ nbf: start / 1000 + 1 }),
    jwt({ iat: start / 1000 + 1 }), jwt({}, { alg: 'none' }), jwt({}, { alg: 'HS256' }), jwt({}, { kid: 'unknown' }),
    jwt({}, { crit: ['b64'] }), jwt().slice(0, -10) + 'AAAAAAAAAA']
  for (const token of invalid) assert.equal(await verify(token), false)
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 })
  assert.equal(await verify(jwt({}, {}, foreign.privateKey)), false)
  assert.throws(() => verifier({ issuer: 'http://test-team.cloudflareaccess.com' }))
  assert.throws(() => verifier({ issuer: 'https://cloudflareaccess.com.evil.example' }))
})

test('JWKS is cached, refreshed for rotation, and fails closed on expiry or network failure', async () => {
  let time = start, calls = 0, available = true
  const verify = verifier({ now: () => time, fetchKeys: async () => {
    calls++
    if (!available) throw new Error('offline')
    return { ok: true, json: async () => ({ keys: [jwk] }) }
  } })
  assert.deepEqual(await Promise.all([verify(jwt()), verify(jwt())]), [true, true])
  assert.equal(calls, 1)
  assert.equal(await verify(jwt({}, { kid: 'unknown' })), false)
  assert.equal(calls, 1)
  time += 31000
  assert.equal(await verify(jwt({}, { kid: 'unknown' })), false)
  assert.equal(calls, 2)
  time += 300000
  available = false
  assert.equal(await verify(jwt()), false)
  assert.equal(calls, 3)
})

test('proxy bridges Access into DSH for clean URL, POST, and WebSocket without exposing DSH secrets', async t => {
  let bootstraps = 0, forwarded = 0, upgrades = 0, time = start, tokenLoads = 0
  const token = 'A'.repeat(43)
  const cookie = 'dsh-auth-test=aaa'
  const backend = http.createServer((req, res) => {
    if (req.url === `/?token=${token}`) {
      bootstraps++
      res.writeHead(303, { location: './', 'set-cookie': `${cookie}; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict` })
      return res.end()
    }
    forwarded++
    assert.match(req.headers.cookie, new RegExp(cookie.replaceAll('.', '\\.')))
    assert.equal(req.headers.cookie.includes('spoofed'), false)
    assert.equal(req.headers['cf-access-jwt-assertion'], undefined)
    assert.equal(req.headers['cf-access-authenticated-user-email'], undefined)
    assert.equal(req.headers['sec-fetch-site'], 'same-origin')
    if (req.headers.origin) assert.equal(req.headers.origin, `http://127.0.0.1:${backend.address().port}`)
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      res.setHeader('set-cookie', [`${cookie}; Path=/`, 'theme=dark; Path=/'])
      res.end(req.method === 'POST' ? body : 'fixture HTML')
    })
  })
  backend.on('upgrade', (req, socket) => {
    upgrades++
    assert.match(req.headers.cookie, /dsh-auth-test=/)
    assert.equal(req.headers['cf-access-jwt-assertion'], undefined)
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const backendPort = await listen(backend, t)
  const getCookie = createDshSession({ port: backendPort, now: () => time, loadToken: async () => { tokenLoads++; return token } })
  const proxyPort = await listen(createProxy({ port: backendPort, verifyAccess: verifier(), getDshCookie: getCookie, hostname }), t)
  const headers = { host: hostname, 'cf-access-jwt-assertion': jwt(), 'sec-fetch-site': 'same-origin', origin: `https://${hostname}`,
    cookie: 'theme=dark; dsh-auth-test=spoofed', 'cf-access-authenticated-user-email': 'fixture@example.invalid' }
  const responses = await Promise.all([request(proxyPort, '/', headers), request(proxyPort, '/?session=fixture', headers)])
  for (const res of responses) {
    assert.equal(res.status, 200)
    assert.equal(res.body, 'fixture HTML')
    assert.deepEqual(res.headers['set-cookie'], ['theme=dark; Path=/'])
    assert.equal(res.headers.location, undefined)
  }
  assert.equal(bootstraps, 1)
  assert.equal(tokenLoads, 1)
  const post = await request(proxyPort, '/api/fixture', headers, 'POST', 'fixture-payload')
  assert.equal(post.status, 200)
  assert.equal(post.body, 'fixture-payload')
  const clean = await request(proxyPort, '/?token=old&session=fixture', headers)
  assert.equal(clean.status, 303)
  assert.equal(clean.headers.location, '/?session=fixture')
  assert.match(await upgrade(proxyPort, headers), /^HTTP\/1.1 101/)
  assert.equal(upgrades, 1)
  assert.equal(forwarded, 3)
  time += 300001
  assert.equal((await request(proxyPort, '/', headers)).status, 200)
  assert.equal(bootstraps, 2)
})

test('OTP return navigation reaches the index with a valid Access JWT and preserves fetch metadata', async t => {
  let forwarded = 0
  const backend = http.createServer((req, res) => {
    forwarded++
    assert.equal(req.url, '/?session=fixture')
    assert.equal(req.headers['sec-fetch-site'], 'cross-site')
    assert.equal(req.headers.cookie, 'dsh-auth-fixture=value')
    res.end('fixture HTML')
  })
  const port = await listen(backend, t)
  const proxyPort = await listen(createProxy({ port, verifyAccess: verifier(), hostname,
    getDshCookie: async () => 'dsh-auth-fixture=value' }), t)
  const navigation = { host: hostname, 'cf-access-jwt-assertion': jwt(),
    'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  const response = await request(proxyPort, '/?session=fixture', navigation)
  assert.equal(response.status, 200)
  assert.equal(response.body, 'fixture HTML')
  for (const headers of [{ ...navigation, 'cf-access-jwt-assertion': undefined },
    { ...navigation, 'cf-access-jwt-assertion': 'forged' }, { ...navigation, origin: 'https://evil.example' }]) {
    // Node's HTTP client rejects undefined header values, so omit missing JWTs.
    const supplied = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined))
    assert.equal((await request(proxyPort, '/?session=fixture', supplied)).status, 403)
  }
  assert.equal(forwarded, 1)
})

test('missing/forged Access, hostile origin, wrong host, and unsafe cross-site requests cannot reach DSH', async t => {
  let backendRequests = 0, cookieRequests = 0
  const backend = http.createServer((req, res) => { backendRequests++; res.end('unreachable') })
  const backendPort = await listen(backend, t)
  const proxyPort = await listen(createProxy({ port: backendPort, verifyAccess: verifier(), hostname,
    getDshCookie: async () => { cookieRequests++; return 'dsh-auth-fixture=value' } }), t)
  const valid = { host: hostname, 'cf-access-jwt-assertion': jwt() }
  for (const headers of [{ host: hostname, cookie: 'dsh-auth-fixture=existing' }, { ...valid, 'cf-access-jwt-assertion': 'forged' },
    { ...valid, host: 'other.example' }, { ...valid, origin: 'https://evil.example' }, { ...valid, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request(proxyPort, '/', headers)).status, 403)
    assert.match(await upgrade(proxyPort, headers), /^HTTP\/1.1 403/)
  }
  const navigation = { ...valid, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  for (const [path, headers, method] of [
    ['/', navigation, 'POST'],
    ['/api/fixture', navigation, 'GET'],
    ['/', { ...navigation, 'sec-fetch-mode': 'cors' }, 'GET'],
    ['/', { ...navigation, 'sec-fetch-dest': 'iframe' }, 'GET'],
  ]) assert.equal((await request(proxyPort, path, headers, method)).status, 403)
  assert.match(await upgrade(proxyPort, navigation), /^HTTP\/1.1 403/)
  assert.equal(backendRequests, 0)
  assert.equal(cookieRequests, 0)
})

test('DSH bootstrap failures are recoverable and never expose launch tokens or credentials', async t => {
  let ready = false
  const backend = http.createServer((req, res) => {
    if (!ready) { res.writeHead(401); return res.end('unavailable') }
    res.writeHead(303, { 'set-cookie': 'dsh-auth-fixture=value; Max-Age=60; Path=/' }); res.end()
  })
  const port = await listen(backend, t)
  const getCookie = createDshSession({ port, loadToken: async () => 'A'.repeat(43) })
  await assert.rejects(getCookie(), /authentication unavailable/)
  ready = true
  assert.equal(await getCookie(), 'dsh-auth-fixture=value')
  const proxyPort = await listen(createProxy({ port, verifyAccess: verifier(), hostname,
    getDshCookie: async () => { throw new Error('secret-that-must-not-escape') } }), t)
  const res = await request(proxyPort, '/', { host: hostname, 'cf-access-jwt-assertion': jwt() })
  assert.equal(res.status, 503)
  assert.equal(res.body.includes('secret'), false)
  assert.match(await upgrade(proxyPort, { 'cf-access-jwt-assertion': jwt() }), /^HTTP\/1.1 503/)
})

test('unconfigured proxy retains manual DSH authentication and Origin rewrite', async t => {
  const backend = http.createServer((req, res) => {
    assert.equal(req.headers.origin, `http://127.0.0.1:${backend.address().port}`)
    assert.equal(req.headers.cookie, 'dsh-auth-fixture=manual')
    res.writeHead(401); res.end('fixture DSH auth required')
  })
  const port = await listen(backend, t)
  const proxyPort = await listen(createProxy({ port }), t)
  const res = await request(proxyPort, '/', { origin: 'https://test.example', cookie: 'dsh-auth-fixture=manual' })
  assert.equal(res.status, 401)
})

test('manifest cookie fallback validates the signed application JWT and stays confined to the exact GET', async t => {
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let forwarded = 0
  const backend = http.createServer((req, res) => { forwarded++; res.end('fixture manifest') })
  const port = await listen(backend, t)
  const proxyPort = await listen(createProxy({ port, verifyAccess: verifier(), hostname,
    getDshCookie: async () => 'dsh-auth-fixture=value' }), t)
  const headers = { host: hostname, cookie: `CF_Authorization=${jwt()}`, 'sec-fetch-site': 'same-origin' }
  assert.equal((await request(proxyPort, '/manifest.webmanifest', headers)).status, 200)
  for (const cookie of ['', 'CF_Authorization=forged', `CF_Authorization=${jwt({ aud: ['other-app'] })}`,
    `CF_Authorization=${jwt({ exp: start / 1000 - 1 })}`, `CF_Authorization=${jwt({}, {}, foreign.privateKey)}`,
    `CF_Authorization=${jwt()}; CF_Authorization=${jwt()}`]) {
    assert.equal((await request(proxyPort, '/manifest.webmanifest', { ...headers, cookie })).status, 403)
  }
  for (const [path, supplied, method] of [
    ['/api/fixture', headers, 'GET'],
    ['/manifest.webmanifest', headers, 'POST'],
    ['/manifest.webmanifest', { ...headers, origin: 'https://evil.example' }, 'GET'],
    ['/manifest.webmanifest', { ...headers, 'sec-fetch-site': 'cross-site' }, 'GET'],
    ['/manifest.webmanifest', { ...headers, host: 'evil.example' }, 'GET'],
    ['/manifest.webmanifest', { ...headers, 'cf-access-jwt-assertion': 'forged' }, 'GET'],
  ]) assert.equal((await request(proxyPort, path, supplied, method)).status, 403)
  assert.equal(forwarded, 1)
})
