import { createPublicKey, verify } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'

const run = promisify(execFile)

/** Validate Access application tokens against a fixed issuer and audience. */
export function createAccessVerifier({ issuer, audience, fetchKeys = fetch, now = Date.now }) {
  const origin = new URL(issuer)
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.cloudflareaccess.com') ||
      origin.origin !== issuer || origin.username || origin.password || !audience) {
    throw new Error('Invalid Cloudflare Access issuer/audience configuration')
  }
  let keys = new Map()
  let refreshedAt = -Infinity
  let pending
  async function refresh() {
    if (!pending) pending = (async () => {
      const response = await fetchKeys(`${issuer}/cdn-cgi/access/certs`, {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      })
      if (!response.ok) throw new Error('Access public keys unavailable')
      const body = await response.json()
      const next = new Map()
      for (const key of body.keys ?? []) {
        if (key.kty === 'RSA' && typeof key.kid === 'string' &&
            (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig')) {
          next.set(key.kid, createPublicKey({ key, format: 'jwk' }))
        }
      }
      if (!next.size) throw new Error('Access public keys unavailable')
      keys = next
      refreshedAt = now()
    })().finally(() => { pending = undefined })
    return pending
  }
  return async (token) => {
    try {
      if (typeof token !== 'string' || token.length > 16384) return false
      const parts = token.split('.')
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return false
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'))
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'))
      const seconds = now() / 1000
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined ||
          claims.iss !== issuer || claims.type !== 'app' ||
          !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience) ||
          !Number.isSafeInteger(claims.exp) || claims.exp <= seconds ||
          (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) ||
          (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > seconds))) return false
      if (now() - refreshedAt >= 300000 || (!keys.has(header.kid) && now() - refreshedAt >= 30000)) await refresh()
      const key = keys.get(header.kid)
      return !!key && claims.exp > now() / 1000 &&
        verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
    } catch {
      // Never put JWTs, claims, or request headers in diagnostics.
      return false
    }
  }
}

/** Read only the launch URL belonging to the currently running system service. */
export async function loadDshToken() {
  const { stdout: rawPid } = await run('systemctl', ['show', 'dsh.service', '-p', 'MainPID', '--value'], { timeout: 5000 })
  const pid = rawPid.trim()
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('DSH service unavailable')
  const { stdout } = await run('journalctl', [
    '-u', 'dsh.service', `_PID=${pid}`, '--no-pager', '-o', 'cat', '-n', '20',
    '--grep', 'http://127\\.0\\.0\\.1:3080/\\?token=',
  ], { timeout: 5000, maxBuffer: 1024 * 1024 })
  const matches = [...stdout.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g)]
  const token = matches.at(-1)?.[1]
  if (!token) throw new Error('DSH launch URL unavailable')
  return token
}

/** Exchange the launch token locally; keep the resulting cookie in proxy memory. */
export function createDshSession({ port = 3080, loadToken = loadDshToken, now = Date.now } = {}) {
  let cookie
  let expiresAt = 0
  let pending
  return async () => {
    if (cookie && now() < expiresAt) return cookie
    if (!pending) pending = (async () => {
      const token = await loadToken()
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid DSH launch token')
      const result = await new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path: `/?token=${token}` }, response => {
          const value = response.headers['set-cookie']?.find(c => /^dsh-auth-[A-Za-z0-9_-]+=/.test(c))
          response.resume()
          if (response.statusCode !== 303 || !value) return reject(new Error('DSH authentication unavailable'))
          const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(value)?.[1])
          if (!Number.isSafeInteger(maxAge) || maxAge < 2) return reject(new Error('Invalid DSH cookie lifetime'))
          resolve({ cookie: value.split(';')[0], lifetime: Math.min(300000, (maxAge - 1) * 1000) })
        })
        request.setTimeout(5000, () => request.destroy(new Error('DSH authentication timeout')))
        request.on('error', reject)
      })
      cookie = result.cookie
      expiresAt = now() + result.lifetime
      return cookie
    })().finally(() => { pending = undefined })
    return pending
  }
}
