/**
 * dsh-custom-settings — host half.
 *
 * Kerangka "custom patch/setting dsh": tiap tunable di TUNABLES otomatis punya
 * (1) field di namespace settings `custom-settings` (persisten di
 * ~/.dsh/settings.yaml via dsh-settings-file), (2) apply saat boot + live
 * re-apply saat nilai berubah (tanpa restart), (3) deskriptor di
 * GET /api/tunables untuk render form browser.
 *
 * Route:
 *   GET  /plugins/dsh-custom-settings/api/tunables  → deskriptor form (render client)
 *   GET  /plugins/dsh-custom-settings/api/status    → nilai ter-apply + versi terpasang
 *   GET  /plugins/dsh-custom-settings/api/version   → versi npm terbaru (jaringan)
 *   POST /plugins/dsh-custom-settings/api/upgrade   → npm install -g + restart otomatis
 *
 * KEAMANAN (jangan dilemahkan): POST /api/upgrade adalah route MUTASI (beda
 * dari route GET lain di monorepo) — mengeksekusi npm install -g dan
 * `sudo -n systemctl restart dsh`. Aman di deployment single-user di balik
 * Cloudflare Access + keputusan user via dialog konfirmasi di UI. Route ini
 * TIDAK boleh di-expose publik.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { TUNABLES, type CustomSettingsApplied } from './tunables'

export const name = 'custom-settings-host'
export const inject = ['settings', 'webServer']

const API_PREFIX = '/plugins/dsh-custom-settings/api'
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'
const REGISTRY_TIMEOUT_MS = 8000
const NPM_INSTALL_TIMEOUT_MS = 180_000
const RESTART_DELAY_SECONDS = 3
const RESTART_FAILED_MARKER = join(tmpdir(), 'dsh-upgrade-restart-failed')

/** Namespace settings yang dimiliki plugin ini. */
const NS = 'custom-settings'

/* ---------------- face layanan (loose — kebenaran runtime ada di dsh) ---------------- */

interface SettingsScope {
  get(): Record<string, unknown>
  watch(callback: () => void): () => void
}
interface SettingsFace {
  register(ns: string, schema: unknown, options?: unknown): SettingsScope
  /** Path-addressed edit tanpa revision fence (dibaca fresh dari dokumen). */
  mutate(ns: string, ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>, expectedRevision?: number): Promise<unknown>
  /** Resolved value satu namespace (sudah di-resolve schema: default terisi). */
  get?(ns: string): Record<string, unknown> | undefined
}
interface WebServerRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}
interface WebServerFace {
  register(route: WebServerRoute): unknown
}
/** Face cordis untuk menyatakan service bernama (objek bersama lintas plugin). */
interface ProvideFace {
  // void: disposables service milik fiber provider — framework cordis
  // membersihkannya saat plugin reload/dispose (kepemilikan lifetime fiber).
  provide(name: string, value: unknown): void
}

interface HttpError {
  status: number
  error: string
  detail?: string
}

/* ---------------- helper kecil ---------------- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, err: unknown): void {
  const e = err as Partial<HttpError>
  if (typeof e?.status === 'number' && typeof e?.error === 'string') {
    sendJson(res, e.status, { error: e.error, detail: e.detail })
    return
  }
  sendJson(res, 500, { error: 'internal-error' })
}

/** Baca body JSON kecil; reject saat parses gagal atau melebihi kapasitas. */
function readBodyJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: string | Buffer) => {
      body += String(chunk)
      if (body.length > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(body === '' ? {} : JSON.parse(body) as unknown)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** Versi dsh terpasang: derivasi layout npm-global dari process.execPath (deterministik di deployment ini), fallback createRequire. */
function readInstalledVersion(): string | null {
  try {
    const pkgPath = join(
      dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json',
    )
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version
    }
  } catch {
    /* lanjut fallback */
  }
  try {
    const req = createRequire(process.argv[1] ?? import.meta.url)
    const pkg = req('@deepseek-ai/dsh/package.json') as { version?: string }
    if (typeof pkg?.version === 'string' && pkg.version) return pkg.version
  } catch {
    /* return null */
  }
  return null
}

/** Versi terbaru di npm registry (dist-tag latest). Null bila tak terjangkau. */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: string }
    return typeof body.version === 'string' && body.version ? body.version : null
  } catch {
    return null
  }
}

/** Mini semver compare (core numerik + prerelease segmen). Tanpa dependensi. */
function compareVersions(a: string, b: string): number {
  const clean = (s: string) => s.trim().replace(/^v/i, '')
  const [coreA, preA = ''] = clean(a).split('-', 2)
  const [coreB, preB = ''] = clean(b).split('-', 2)
  const core = compareSegments(coreA, coreB)
  if (core !== 0) return core
  if (preA === preB) return 0
  if (preA === '') return 1 // release > prerelease
  if (preB === '') return -1
  return compareSegments(preA, preB)
}

function compareSegments(a: string, b: string): number {
  const A = a.split('.')
  const B = b.split('.')
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? '0'
    const y = B[i] ?? '0'
    const xn = /^\d+$/.test(x) ? Number(x) : NaN
    const yn = /^\d+$/.test(y) ? Number(y) : NaN
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) {
      if (xn !== yn) return xn < yn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Path npm-cli di layout npm-global (dipanggil lewat process.execPath — tanpa PATH dependency). */
function npmCliPath(): string | null {
  const p = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(p) ? p : null
}

/** Jalankan `npm install -g @deepseek-ai/dsh@latest`; resolve {output} / reject {output, message}. */
function runNpmInstall(npmCli: string): Promise<{ output: string }> {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = execFile(
      process.execPath,
      [npmCli, 'install', '-g', '@deepseek-ai/dsh@latest'],
      { timeout: NPM_INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        output = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
        if (err) {
          reject(Object.assign(err, { output }))
        } else {
          resolve({ output })
        }
      },
    )
    child.on('error', (err) => reject(Object.assign(err, { output })))
  })
}

/** Jadwalkan restart dsh secara detached (respons sudah terkirim lebih dulu). */
function scheduleRestart(): void {
  try {
    const child = spawn('bash', [
      '-c',
      `sleep ${RESTART_DELAY_SECONDS}; sudo -n systemctl restart dsh 2>>"${RESTART_FAILED_MARKER}.err"; if [ $? -ne 0 ]; then echo failed > "${RESTART_FAILED_MARKER}"; fi`,
    ], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    /* restart gagal terjadwal — terlihat di journal; marker tidak ditulis */
  }
}

/* ---------------- plugin ---------------- */

export function apply(ctx: Context): void {
  const settings = (ctx as unknown as { settings: SettingsFace }).settings
  const webServer = (ctx as unknown as { webServer: WebServerFace }).webServer

  /* ---- objek bersama lintas-plugin (dibaca lazy oleh host half plugin lain) ---- */
  // Service cordis 'customSettingsApplied': konsumen (dsh-git-state host)
  // membaca via ctx.get per-request — aman untuk urutan boot dua arah, dan
  // perubahan nilai live karena apply() tunable memutasi objek IN-PLACE.
  const appliedShared: CustomSettingsApplied = { gitState: {} }
  const provide = (ctx as unknown as ProvideFace).provide.bind(ctx)
  ctx.effect(() => provide('customSettingsApplied', appliedShared))

  /* ---- namespace settings + apply live (boot & setiap perubahan) ---- */
  const fields: Record<string, unknown> = {}
  for (const t of TUNABLES) {
    fields[t.id] = z.number().min(t.min).max(t.max).default(t.default)
  }
  const scope = settings.register(NS, z.object(fields))

  // Seed objek bersama dari resolved namespace, BUKAN dari defaultOf:
  // seeding berbasis urutan apply pernah terobservasi tertinggal saat boot
  // (pelajaran 25 Aug 2026 — status 6000 setelah restart padahal dokumen
  // berisi 300000, sampai perubahan nilai pertama memicu re-apply).
  const resolvedNow = (scope.get() as Record<string, unknown> | undefined)?.['gitStateCmdTimeoutMs']
  if (typeof resolvedNow === 'number' && Number.isFinite(resolvedNow)) {
    appliedShared.gitState!.cmdTimeoutMs = Math.round(resolvedNow)
  }

  const applyAll = (): void => {
    const value = scope.get()
    for (const t of TUNABLES) {
      const n = (value as Record<string, unknown> | undefined)?.[t.id]
      if (typeof n === 'number' && Number.isFinite(n)) {
        try {
          t.apply(ctx, n)
        } catch {
          /* jangan gagalkan boot/observer karena satu tunable */
        }
      }
    }
  }
  applyAll()
  ctx.effect(() => scope.watch(applyAll))

  /* ---- helper status ---- */
  // Nilai ter-apply per tunable: baca dari konsumennya masing-masing —
  // default dari codeRuntime.config, atau readApplied kustom (mis. objek
  // bersama lintas-plugin). Tunable tanpa nilai ter-apply (mis. konsumen
  // browser) sekadar tidak ada di map.
  const appliedValues = (): Record<string, number> => {
    const runtime = (ctx as unknown as { get<T>(key: string): T | undefined })
      .get<{ config?: Record<string, unknown> }>('codeRuntime')
    const out: Record<string, number> = {}
    for (const t of TUNABLES) {
      let n: number | undefined
      if (typeof t.readApplied === 'function') {
        try { n = t.readApplied(ctx) } catch { n = undefined }
      } else if (runtime?.config) {
        const v = runtime.config[t.configKey ?? t.id]
        if (typeof v === 'number') n = v
      }
      if (typeof n === 'number' && Number.isFinite(n)) out[t.id] = n
    }
    return out
  }

  /* ---- GET /api/tunables ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/tunables',
    handler: (_req, res) => {
      sendJson(res, 200, TUNABLES.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        tooltip: t.tooltip,
        min: t.min,
        max: t.max,
        default: t.default,
        unit: t.unit,
        presets: t.presets,
        restart: t.restart === true,
        consumer: t.consumer === 'browser' ? 'browser' : 'host',
      })))
    },
  }))

  /* ---- POST /api/save (path tulis SATU-SATUNYA dari browser) ---- */
  // Mengapa tidak pakai settingsScope.set dari dsh-client-ui-settings 0.1.1:
  // kontroler client meng-SWALLOW respons non-ok (settings-conflict dengan
  // revision basi dari tab lain, settings-rejected) lalu resolve biasa —
  // UI menampilkan "Tersimpan" padahal nilai tidak pernah ditulis (kejadian
  // nyata 25 Aug 2026, kehilangan gitStateCmdTimeoutMs). Route ini menulis
  // TANPA revision fence (mutate di-drive dari dokumen fresh server-side),
  // nilai per-field — tidak menimpa field lain — dan mengembalikan hasil
  // nyata + nilai ter-apply terbaru.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/save',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = (await readBodyJson(req)) as { id?: unknown; value?: unknown; reset?: unknown }
        const id = typeof body?.id === 'string' ? body.id : ''
        const tunable = TUNABLES.find((t) => t.id === id)
        if (!tunable) {
          sendJson(res, 400, { ok: false, error: 'unknown-tunable', detail: id })
          return
        }
        if (body?.reset === true) {
          await settings.mutate(NS, [{ op: 'unset', path: [id] }])
          sendJson(res, 200, { ok: true, applied: appliedValues() })
          return
        }
        const raw = Number(body?.value)
        if (!Number.isFinite(raw)) {
          sendJson(res, 400, { ok: false, error: 'invalid-value', detail: String(body?.value) })
          return
        }
        const value = Math.min(tunable.max, Math.max(tunable.min, Math.round(raw)))
        await settings.mutate(NS, [{ op: 'set', path: [id], value }])
        sendJson(res, 200, { ok: true, applied: appliedValues() })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendJson(res, 400, { ok: false, error: 'save-failed', detail: msg })
      }
    },
  }))

  /* ---- GET /api/status ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/status',
    handler: (_req, res) => {
      sendJson(res, 200, {
        applied: appliedValues(),
        installedVersion: readInstalledVersion(),
        lastRestartFailed: existsSync(RESTART_FAILED_MARKER),
      })
    },
  }))

  /* ---- GET /api/version ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/version',
    handler: async (_req, res) => {
      const installed = readInstalledVersion()
      const latest = await fetchLatestVersion()
      if (!latest) {
        sendJson(res, 200, { ok: false, installed, reason: 'registry-unreachable' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        installed,
        latest,
        upToDate: installed !== null && compareVersions(latest, installed) <= 0,
        checkedAt: new Date().toISOString(),
      })
    },
  }))

  /* ---- POST /api/upgrade ---- */
  let upgrading = false
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/upgrade',
    handler: async (_req, res) => {
      if (upgrading) {
        sendJson(res, 409, { error: 'upgrade-in-progress' })
        return
      }
      const installed = readInstalledVersion()
      const latest = await fetchLatestVersion()
      if (!latest) {
        sendJson(res, 409, { error: 'registry-unreachable' })
        return
      }
      if (installed !== null && compareVersions(latest, installed) <= 0) {
        sendJson(res, 409, { error: 'already-up-to-date' })
        return
      }
      const npmCli = npmCliPath()
      if (!npmCli) {
        sendJson(res, 409, { error: 'npm-not-found' })
        return
      }

      upgrading = true
      try {
        try {
          unlinkSync(RESTART_FAILED_MARKER)
        } catch {
          /* marker memang belum ada */
        }
        await runNpmInstall(npmCli)
        sendJson(res, 200, { ok: true, from: installed, to: latest })
        scheduleRestart()
      } catch (err) {
        const e = err as { output?: string; message?: string }
        sendJson(res, 200, {
          ok: false,
          reason: 'npm-install-failed',
          outputTail: (e.output ?? e.message ?? '').slice(-2000),
        })
      } finally {
        upgrading = false
      }
    },
  }))
}
