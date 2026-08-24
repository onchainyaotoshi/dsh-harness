/**
 * dsh-file-explorer — host half.
 * Register 3 route HTTP exact di ctx.webServer:
 *   GET /plugins/dsh-file-explorer/api/workspaces  → daftar workspace terdaftar
 *   GET /plugins/dsh-file-explorer/api/list        → listing satu direktori
 *   GET /plugins/dsh-file-explorer/api/read        → isi satu file teks
 *
 * SECURITY BOUNDARY (jangan dilemahkan): semua akses file wajib berada di
 * dalam root workspace terdaftar (ctx.workspaceRegistry) dan lolos
 * ctx.fs.contains(root, target) — di luar itu 403. Route ini tidak ikut
 * pagar /api (method PRIVILEGED), jadi containment ini satu-satunya pagar
 * antara browser dan filesystem host.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

export const name = 'file-explorer-host'
export const inject = ['webServer', 'fs', 'workspaceRegistry']

/** Batas ukuran file teks yang boleh dibaca panel (byte). */
const MAX_READ_BYTES = 512 * 1024

/** Batas ukuran file biner yang boleh dipreview via /raw (byte). */
const MAX_RAW_BYTES = 8 * 1024 * 1024

const API_PREFIX = '/plugins/dsh-file-explorer/api'

/** Content-Type untuk preview /raw, key dari extname (lowercase). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

interface HttpError { status: number; error: string; detail?: string }

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  // Route dipoll client — jangan biarkan cache browser menyajikan data lama.
  res.setHeader('Cache-Control', 'no-cache')
  res.end(JSON.stringify(body))
}

/**
 * Error dari backend fs adalah FsError dengan `code` (FS_NOT_TEXT dll) —
 * wajib dipetakan, kalau tidak klik file biner jadi 500 "internal-error"
 * (kejadian nyata: klik gambar sebelum pemetaan ini ada).
 */
function sendError(res: ServerResponse, err: unknown): void {
  const e = err as Partial<HttpError>
  if (typeof e?.status === 'number') {
    sendJson(res, e.status, {
      error: typeof e?.error === 'string' ? e.error : 'internal-error',
      detail: typeof e?.detail === 'string' ? e.detail : undefined,
    })
    return
  }
  const code = (err as { code?: string } | null)?.code
  if (code === 'FS_NOT_TEXT') return sendJson(res, 415, { error: 'binary-file' })
  if (code === 'FS_TOO_LARGE') return sendJson(res, 413, { error: 'file-too-large' })
  if (code === 'FS_NOT_FOUND') return sendJson(res, 404, { error: 'not-found' })
  if (code === 'FS_PERMISSION_DENIED' || code === 'FS_SANDBOX_DENIED') {
    return sendJson(res, 403, { error: 'forbidden' })
  }
  sendJson(res, 500, { error: 'internal-error' })
}

interface SessionQueryLike { readSession?(id: string): Promise<unknown> }

type SessionEventLike = { type?: string; data?: { arguments?: { workdir?: string } } }

/**
 * Index WORKDIR bash terbaru per sesi — sinyal "agent sedang bekerja di
 * direktori mana". Beda dari `sessions.list.byId[id].cwd`, yang di-stempel
 * sekali saat sesi dibuat dan TIDAK berubah walau agent `cd` di dalam
 * worktree (kejadian nyata 24 Aug 2026 — sesi "bikin worktree" di camis:
 * cwd sesi tetap root repo, agent kerja via workdir di worktree linked).
 * Dipakai panel untuk mengikuti agent; pola event sama dengan dsh-git-state.
 */
const MAX_WORKDIR_SESSIONS = 64
const latestWorkdir = new Map<string, string>()
const backfilled = new Set<string>()
const backfillInflight = new Map<string, Promise<string | null>>()

function setLatestWorkdir(sessionId: string, wd: string): void {
  if (wd === '') return
  if (!latestWorkdir.has(sessionId) && latestWorkdir.size >= MAX_WORKDIR_SESSIONS) {
    const oldest = latestWorkdir.keys().next().value
    if (oldest !== undefined) latestWorkdir.delete(oldest)
  }
  latestWorkdir.set(sessionId, wd)
}

/**
 * Workdir terbaru satu sesi: index live dulu; kalau belum ada (riwayat
 * sebelum boot), backfill 1× per sesi per boot — scan event TERAKHIR ke
 * depan, ambil `tool/code-dispatch-start` terakhir yang membawa workdir.
 * Modest: 1 readSession sekali; dedup in-flight. Tanpa ini sesi idle
 * (agent sudah selesai) tidak pernah terdorong ke workdir-nya.
 */
async function latestSessionWorkdir(ctx: Context, sessionId: string): Promise<string | null> {
  const hit = latestWorkdir.get(sessionId)
  if (hit !== undefined) return hit
  if (backfilled.has(sessionId)) return null
  const existing = backfillInflight.get(sessionId)
  if (existing) return existing
  const p = (async () => {
    let found: string | null = null
    try {
      const sq = (ctx as unknown as { get<T>(key: string): T | undefined })
        .get<SessionQueryLike>('sessionQuery')
      const snap = (await sq?.readSession?.(sessionId)) as { events?: unknown[] } | undefined
      const events = snap?.events
      if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i] as SessionEventLike | null
          if (e?.type !== 'tool/code-dispatch-start') continue
          const wd = e.data?.arguments?.workdir
          if (typeof wd === 'string' && wd !== '') { found = wd; break }
        }
      }
    } catch { /* degradasi halus: tanpa riwayat, panel tetap perilaku cwd */ }
    backfilled.add(sessionId)
    if (found !== null) latestWorkdir.set(sessionId, found)
    backfillInflight.delete(sessionId)
    return found
  })()
  backfillInflight.set(sessionId, p)
  return p
}

export function apply(ctx: Context): void {
  // Index live workdir sesi — stream event append (0 readSession untuk sesi
  // lain; identik dengan pola dsh-git-state; event lama tanpa workdir
  // otomatis terlewati). Cast: 'session/event' tidak ikut type graph build.
  const on = ctx.on as (name: string, listener: (session: { id?: unknown }, event: SessionEventLike) => void) => () => boolean
  on('session/event', (session, event) => {
    if (event?.type !== 'tool/code-dispatch-start') return
    const wd = event.data?.arguments?.workdir
    if (typeof wd !== 'string') return
    const sid = String(session?.id ?? '')
    if (sid !== '') setLatestWorkdir(sid, wd)
  })

  /**
   * Resolve root workspace + target file dengan containment check.
   * Semua path dari klien harus absolut; klien TIDAK pernah menggabung
   * segmen path sendiri — host menghitung path tiap entry di /list.
   */
  async function resolveInside(workspace: string, filePath: string) {
    const ws = ctx.workspaceRegistry.get(WorkspaceId(workspace))
    if (!ws) {
      throw { status: 404, error: 'workspace-not-found', detail: workspace } as HttpError
    }
    const abs = filePath || ws.path
    const root = await ctx.fs.resolve(ws.path, {})
    const target = await ctx.fs.resolve(abs, {})
    if (!ctx.fs.contains(root, target)) {
      throw { status: 403, error: 'outside-workspace', detail: abs } as HttpError
    }
    return { abs, target }
  }

  // --- workspaces ---
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/workspaces',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      sendJson(res, 200, ctx.workspaceRegistry.list().map((w) => ({
        id: String(w.id),
        title: w.title,
        path: w.path,
      })))
    },
  }))

  // --- active-dir: workdir terakhir sesi (client pakai utk ikuti agent) ---
  // Route murah: lookup map O(1) + backfill 1× per sesi per boot (dedup
  // in-flight). TIDAK menyentuh filesystem/git — aman dipoll.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/active-dir',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('session') ?? ''
        if (sessionId === '') return sendJson(res, 200, { workdir: null })
        const workdir = await latestSessionWorkdir(ctx, sessionId)
        sendJson(res, 200, { workdir })
      } catch (err) {
        sendError(res, err)
      }
    },
  }))

  // --- list ---
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/list',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const workspace = url.searchParams.get('workspace')
        const path = url.searchParams.get('path')
        if (!workspace) throw { status: 400, error: 'missing-workspace' } as HttpError
        const { abs, target } = await resolveInside(workspace, path ?? '')
        const entries = await ctx.fs.listDir(target)
        sendJson(res, 200, {
          path: abs,
          entries: entries.map((e) => ({
            name: e.name,
            type: e.type,
            size: e.size,
            path: join(abs, e.name),
          })),
        })
      } catch (err) {
        sendError(res, err)
      }
    },
  }))

  // --- read ---
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/read',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const workspace = url.searchParams.get('workspace')
        const path = url.searchParams.get('path')
        if (!workspace) throw { status: 400, error: 'missing-workspace' } as HttpError
        if (!path) throw { status: 400, error: 'missing-path' } as HttpError
        const { target } = await resolveInside(workspace, path)
        const info = await ctx.fs.stat(target)
        if (!info) throw { status: 404, error: 'not-found', detail: path } as HttpError
        if (info.type !== 'file') throw { status: 400, error: 'not-a-file', detail: path } as HttpError
        if (info.size !== undefined && info.size > MAX_READ_BYTES) {
          throw { status: 413, error: 'file-too-large', detail: String(info.size) } as HttpError
        }
        const text = await ctx.fs.readText(target)
        sendJson(res, 200, { path, text })
      } catch (err) {
        sendError(res, err)
      }
    },
  }))

  // --- raw (preview file biner kecil, mis. gambar) ---
  // Containment sama persis dengan route lain; Content-Type dari ekstensi.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/raw',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const workspace = url.searchParams.get('workspace')
        const path = url.searchParams.get('path')
        if (!workspace) throw { status: 400, error: 'missing-workspace' } as HttpError
        if (!path) throw { status: 400, error: 'missing-path' } as HttpError
        const { target } = await resolveInside(workspace, path)
        const info = await ctx.fs.stat(target)
        if (!info) throw { status: 404, error: 'not-found', detail: path } as HttpError
        if (info.type !== 'file') throw { status: 400, error: 'not-a-file', detail: path } as HttpError
        if (info.size !== undefined && info.size > MAX_RAW_BYTES) {
          throw { status: 413, error: 'file-too-large', detail: String(info.size) } as HttpError
        }
        const bytes = await ctx.fs.readBytes(target, undefined, MAX_RAW_BYTES)
        res.statusCode = 200
        res.setHeader('Content-Type', MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(bytes)
      } catch (err) {
        sendError(res, err)
      }
    },
  }))
}
