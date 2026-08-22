/**
 * dsh-git-state - host half.
 * Satu route HTTP exact di ctx.webServer:
 *   GET /plugins/dsh-git-state/api/state[?session=<id>] → status git tiap
 *   workspace terdaftar + deteksi worktree yang sedang dikerjakan.
 *
 * Hanya perintah READ-ONLY (rev-parse, status --porcelain, stash list,
 * worktree list, gh pr list) - selalu `git -C <path workspace terdaftar>`.
 * Path TIDAK PERNAH datang dari client; client hanya mengirim id workspace
 * (dan id sesi untuk deteksi aktivitas). Route ini tidak ikut pagar /api
 * (method PRIVILEGED), jadi containment workspaceRegistry adalah satu-satunya
 * pagar antara browser dan proses host (warisan wajib dsh-file-explorer).
 *
 * Deteksi "worktree aktif" (pelajaran 18 Aug 2026 - `git worktree list`
 * TIDAK menandai checkout yang sedang dipakai; blok pertama SELALU checkout
 * utama). Sinyal workdir bash sesi dari DUA sumber:
 *   1. INDEX live: subscribe stream `session/event` → Map<sessionId,
 *      workdirs terakhir> (event tool/code-dispatch-start →
 *      data.arguments.workdir). 0 readSession - semua sesi terpantau
 *      inkremental, bounded (cap sesi × cap workdir);
 *   2. BACKFILL 1× sesi peminta: kalau belum punya entri index (history
 *      sebelum boot), readSession 1× sekali per sesi per boot (dedup
 *      in-flight + tanda backfilled).
 * Tag "dikerjakan sesi lain" = index sesi lain (tanpa readSession).
 * Sinyal proses hidup di worktree tetap dari scan /proc (inUse).
 *
 * Caching: memo TTL 5 dtk + dedup in-flight (per-workspace repo state, scan
 * /proc) supaya poll client (default 30 dtk) tidak membanjiri git maupun
 * saling tumpang tindih membengkakkan beban.
 *
 * Tuning via tab Custom Settings (plugin dsh-custom-settings, namespace
 * 'custom-settings'): gitStatePollMs (interval poll — dibaca browser half)
 * dan gitStateCmdTimeoutMs (timeout perintah git — dibaca host half LAZY
 * per-request dari service cordis 'customSettingsApplied', objek bersama yang
 * di-provide dsh-custom-settings). Live tanpa restart; plugin settings absen
 * atau nilai tidak sah → fallback default + clamp.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'
import { readdir, readlink } from 'node:fs/promises'

export const name = 'git-state-host'
export const inject = ['webServer', 'shell', 'workspaceRegistry', 'sessions']

const API_PREFIX = '/plugins/dsh-git-state/api'
// Timeout perintah git: default 6 dtk; tuning live via tunable
// gitStateCmdTimeoutMs (tab Custom Settings). Clamp ganda di konsumen karena
// ~/.dsh/settings.yaml bisa diedit manual di luar schema.
const DEFAULT_CMD_TIMEOUT_MS = 6000
const CMD_TIMEOUT_MIN_MS = 1000
// Max mengikuti preset terbesar tunable (1 hari) — pilihan pemilik;
// dedup in-flight menahan beban bila ada perintah lama menggantung.
const CMD_TIMEOUT_MAX_MS = 86_400_000
const STDOUT_MAX_BYTES = 256 * 1024
const MAX_FILES = 200
const MAX_STASHES = 30
const MAX_WORKTREES = 20
const MAX_PRS = 20
const MAX_WORKDIR_HITS = 20
const MEMO_TTL_MS = 5000

/* ---------- wire types (cocok dengan browser half) ---------- */
interface ChangeFile { code: string; path: string }
interface Changes {
  staged: number; unstaged: number; untracked: number; conflicted: number
  total: number; files: ChangeFile[]
}
interface StashEntry { ref: string; message: string }
interface WorktreeInfo {
  path: string; branch: string | null; headSha7: string; main: boolean
  changes: Changes; upstream: string | null; ahead: number; behind: number
  inUse: boolean
}
interface PrInfo { number: number; title: string; head: string; url: string }
interface GitState {
  branch: string; detached: boolean; headSha: string
  upstream: string | null; ahead: number; behind: number
  changes: Changes; stashes: StashEntry[]; worktrees: WorktreeInfo[]; prs: PrInfo[] | null
}
interface WorkspaceState {
  id: string; title: string; path: string
  repo: GitState | null; error?: string
  /** workdir bash sesi peminta (paling baru dulu) - client yang mencocokkan ke worktree. */
  sessionWorktrees?: string[]
  /** path worktree → id sesi lain yang riwayat bash-nya menunjuk ke sana. */
  otherSessionWorktrees?: Record<string, string[]>
}

/* ---------- util HTTP ---------- */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  sendJson(res, 500, { error: 'internal-error', detail: msg })
}

/* ---------- util shell ---------- */
function quoteShell(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

interface RunOutcome { ok: boolean; text: string; err: string }

/** Timeout efektif dari objek bersama 'customSettingsApplied'; fallback default bila absen/tidak sah. */
function cmdTimeoutMs(ctx: Context): number {
  const shared = (ctx as unknown as { get<T>(key: string): T | undefined })
    .get<{ gitState?: { cmdTimeoutMs?: number } }>('customSettingsApplied')
  const raw = shared?.gitState?.cmdTimeoutMs
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CMD_TIMEOUT_MS
  return Math.min(CMD_TIMEOUT_MAX_MS, Math.max(CMD_TIMEOUT_MIN_MS, Math.round(raw)))
}

async function runCmd(ctx: Context, workdir: string, command: string): Promise<RunOutcome> {
  const req: ShellExecRequest = {
    command,
    workdir,
    timeoutMs: cmdTimeoutMs(ctx),
    stdoutMaxBytes: STDOUT_MAX_BYTES,
  }
  const spec = ctx.shell.resolve(req)
  const result = await ctx.shell.run(spec)
  return {
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
    text: result.stdout.text,
    err: result.stderr.text,
  }
}

function gitCmd(workdir: string, args: string): string {
  return 'git -C ' + quoteShell(workdir) + ' ' + args
}

/* ---------- parser ---------- */
function zeroChanges(): Changes {
  return { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0, files: [] }
}

/** Porcelain v1: `XY PATH` - X kolom index, Y kolom worktree. */
function parseStatus(text: string): Changes {
  const out = zeroChanges()
  for (const line of text.split('\n')) {
    if (line.length < 4) continue
    const x = line[0]
    const y = line[1]
    const rawPath = line.slice(3)
    // Rename: `XY old -> new` - tampilkan tujuan saja.
    const path = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath
    if (x === '?' && y === '?') out.untracked++
    else if ('AUD'.includes(x) && 'AUD'.includes(y)) out.conflicted++
    else {
      if (x !== ' ' && x !== '?') out.staged++
      if (y !== ' ' && y !== '?') out.unstaged++
    }
    if (out.files.length < MAX_FILES) out.files.push({ code: x + y, path })
  }
  out.total = out.staged + out.unstaged + out.untracked + out.conflicted
  return out
}

function parseStashes(text: string): StashEntry[] {
  const out: StashEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('stash@{')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    out.push({ ref: line.slice(0, colon), message: line.slice(colon + 1).trim() })
    if (out.length >= MAX_STASHES) break
  }
  return out
}

/**
 * Porcelain `git worktree list`: blok dipisah baris kosong; blok pertama =
 * checkout UTAMA (selalu, dari mana pun dijalankan - git tidak menandai
 * checkout yang sedang dipakai). `branch refs/heads/x` atau `detached`.
 */
function parseWorktrees(text: string, mainBranch: string): WorktreeInfo[] {
  const blocks: string[][] = []
  let cur: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') { if (cur.length) blocks.push(cur); cur = [] } else cur.push(line)
  }
  if (cur.length) blocks.push(cur)

  const out: WorktreeInfo[] = []
  for (let i = 0; i < blocks.length && out.length < MAX_WORKTREES; i++) {
    const b = blocks[i]
    const wtLine = b.find((l) => l.startsWith('worktree '))
    if (!wtLine) continue
    const headLine = b.find((l) => l.startsWith('HEAD '))
    const branchLine = b.find((l) => l.startsWith('branch '))
    const detached = b.includes('detached')
    const isMain = i === 0
    let branch: string | null
    if (branchLine) branch = branchLine.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (detached) branch = null
    else branch = isMain ? mainBranch : null
    out.push({
      path: wtLine.slice('worktree '.length),
      branch,
      headSha7: headLine ? headLine.slice('HEAD '.length, 'HEAD '.length + 7) : '',
      main: isMain,
      changes: zeroChanges(),
      upstream: null,
      ahead: 0,
      behind: 0,
      inUse: false,
    })
  }
  return out
}

/* ---------- scan /proc (proses hidup di dalam worktree) ---------- */
let procMemo: { at: number; cwds: string[] } | null = null
let procInflight: Promise<string[]> | null = null

async function procCwds(): Promise<string[]> {
  if (procMemo && Date.now() - procMemo.at < MEMO_TTL_MS) return procMemo.cwds
  if (procInflight) return procInflight
  const p = (async () => {
    const cwds: string[] = []
    try {
      const names = await readdir('/proc')
      await Promise.all(
        names
          .filter((n) => /^\d+$/.test(n))
          .map(async (n) => {
            try { cwds.push(await readlink('/proc/' + n + '/cwd')) } catch { /* proses lenyap */ }
          }),
      )
    } catch {
      // Gagal baca /proc: JANGAN memo hasil kosong (bug review #4 - poison 5 dtk).
      // Kembalikan kosong sekali saja; request berikutnya mencoba lagi.
      procInflight = null
      return []
    }
    procMemo = { at: Date.now(), cwds }
    procInflight = null
    return cwds
  })()
  procInflight = p
  return p
}

function insideDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + '/')
}

/* ---------- index workdir sesi (stream live + backfill) ---------- */
interface SessionQueryLike { readSession?(id: string): Promise<unknown> }

/**
 * Index workdir bash per sesi, diisi INKREMENTAL dari stream live
 * `session/event` (0 readSession utk sesi lain) + backfill 1× readSession
 * sesi peminta saat belum punya entri (history sebelum boot). Bounded.
 */
const MAX_INDEX_SESSIONS = 64
const workdirIndex = new Map<string, string[]>()
const backfilled = new Set<string>()
const workdirInflight = new Map<string, Promise<string[]>>()

function pushWorkdir(sessionId: string, wd: string): void {
  if (wd === '') return
  const list = workdirIndex.get(sessionId)
  if (list) {
    workdirIndex.set(sessionId, [wd, ...list.filter((d) => d !== wd)].slice(0, MAX_WORKDIR_HITS))
  } else {
    if (workdirIndex.size >= MAX_INDEX_SESSIONS) {
      const oldest = workdirIndex.keys().next().value
      if (oldest !== undefined) workdirIndex.delete(oldest)
    }
    workdirIndex.set(sessionId, [wd])
  }
}

/** Workdir bash satu sesi, paling baru dulu. Index dulu; backfill 1× kalau belum ada entri. */
async function sessionWorkdirs(ctx: Context, sessionId: string): Promise<string[]> {
  if (sessionId === '') return []
  const hit = workdirIndex.get(sessionId)
  if (hit) return hit
  if (backfilled.has(sessionId)) return []
  const existing = workdirInflight.get(sessionId)
  if (existing) return existing
  const p = (async () => {
    let workdirs: string[] = []
    try {
      const sq = ctx.get('sessionQuery') as SessionQueryLike | undefined
      const snap = (await sq?.readSession?.(sessionId)) as { events?: unknown[] } | undefined
      const events = snap?.events
      if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0 && workdirs.length < MAX_WORKDIR_HITS; i--) {
          const e = events[i] as { type?: string; data?: { arguments?: { workdir?: string } } } | null
          if (e?.type !== 'tool/code-dispatch-start') continue
          const wd = e.data?.arguments?.workdir
          if (typeof wd === 'string' && wd !== '' && !workdirs.includes(wd)) workdirs.push(wd)
        }
      }
    } catch { /* degradasi halus: tanpa riwayat sesi */ }
    backfilled.add(sessionId)
    if (workdirs.length > 0) workdirIndex.set(sessionId, workdirs)
    workdirInflight.delete(sessionId)
    return workdirs
  })()
  workdirInflight.set(sessionId, p)
  return p
}

/* ---------- kolektor per workspace ---------- */
async function collectRepo(ctx: Context, id: string, title: string, path: string): Promise<WorkspaceState> {
  const base = { id, title, path }
  try {
    const probe = await runCmd(ctx, path, gitCmd(path, 'rev-parse --is-inside-work-tree'))
    if (!probe.ok) {
      const notRepo = /not a git repository/i.test(probe.err)
      return { ...base, repo: null, ...(notRepo ? {} : { error: probe.err.trim() || 'git probe gagal' }) }
    }

    const br = await runCmd(ctx, path, gitCmd(path, 'rev-parse --abbrev-ref HEAD'))
    const detached = br.ok && br.text.trim() === 'HEAD'
    const branch = detached || !br.ok ? '' : br.text.trim()
    const shaRes = await runCmd(ctx, path, gitCmd(path, 'rev-parse --short HEAD'))
    const headSha = shaRes.ok ? shaRes.text.trim() : ''

    let upstream: string | null = null
    let ahead = 0
    let behind = 0
    const up = await runCmd(ctx, path, gitCmd(path, "rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'"))
    if (up.ok && up.text.trim() !== '') {
      upstream = up.text.trim()
      const cnt = await runCmd(ctx, path, gitCmd(path, 'rev-list --left-right --count ' + quoteShell(upstream) + '...HEAD'))
      if (cnt.ok) {
        // kiri = komit hanya di upstream (behind), kanan = hanya di HEAD (ahead)
        const [l, r] = cnt.text.trim().split(/\s+/).map(Number)
        behind = Number.isFinite(l) ? l : 0
        ahead = Number.isFinite(r) ? r : 0
      }
    }

    const st = await runCmd(ctx, path, gitCmd(path, 'status --porcelain=v1'))
    const changes = st.ok ? parseStatus(st.text) : zeroChanges()

    const stl = await runCmd(ctx, path, gitCmd(path, 'stash list'))
    const stashes = parseStashes(stl.ok ? stl.text : '')

    const wt = await runCmd(ctx, path, gitCmd(path, 'worktree list --porcelain'))
    const worktrees = wt.ok ? parseWorktrees(wt.text, branch) : []
    const mainWt = worktrees.find((w) => w.main)
    if (mainWt) {
      mainWt.changes = changes
      mainWt.upstream = upstream
      mainWt.ahead = ahead
      mainWt.behind = behind
    }

    // Per worktree linked: status lengkap + upstream/ahead/behind (paralel, cap).
    await Promise.all(
      worktrees
        .filter((w) => !w.main)
        .map(async (w) => {
          const s = await runCmd(ctx, w.path, gitCmd(w.path, 'status --porcelain=v1'))
          w.changes = s.ok ? parseStatus(s.text) : zeroChanges()
          const wu = await runCmd(ctx, w.path, gitCmd(w.path, "rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'"))
          if (wu.ok && wu.text.trim() !== '') {
            w.upstream = wu.text.trim()
            const wc = await runCmd(ctx, w.path, gitCmd(w.path, 'rev-list --left-right --count ' + quoteShell(w.upstream) + '...HEAD'))
            if (wc.ok) {
              const [l, r] = wc.text.trim().split(/\s+/).map(Number)
              w.behind = Number.isFinite(l) ? l : 0
              w.ahead = Number.isFinite(r) ? r : 0
            }
          }
        }),
    )

    // Proses hidup (dev server, editor, dll) di dalam worktree.
    const cwds = await procCwds()
    for (const w of worktrees) {
      w.inUse = cwds.some((c) => insideDir(c, w.path))
    }

    // PR open via gh (best-effort; absen/tanpa auth → null, chip disembunyikan).
    let prs: PrInfo[] | null = null
    const pr = await runCmd(ctx, path, 'gh pr list --state open --json number,title,headRefName,url --limit 100')
    if (pr.ok) {
      try {
        const arr = JSON.parse(pr.text) as Array<{ number: number; title: string; headRefName: string; url: string }>
        prs = arr.slice(0, MAX_PRS).map((p) => ({ number: p.number, title: p.title, head: p.headRefName, url: p.url }))
      } catch { prs = null }
    }

    return {
      ...base,
      repo: {
        branch, detached, headSha, upstream, ahead, behind,
        changes, stashes, worktrees, prs,
      },
    }
  } catch (err) {
    return { ...base, repo: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/* ---------- memo (TTL) + dedup in-flight ---------- */
const memo = new Map<string, { at: number; value: WorkspaceState }>()
const repoInflight = new Map<string, Promise<WorkspaceState>>()

async function repoStateFor(ctx: Context, id: string, title: string, path: string): Promise<WorkspaceState> {
  const hit = memo.get(path)
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value
  const existing = repoInflight.get(path)
  if (existing) return existing
  const p = collectRepo(ctx, id, title, path)
    .then((value) => { memo.set(path, { at: Date.now(), value }); repoInflight.delete(path); return value })
    .catch((err) => { repoInflight.delete(path); throw err })
  repoInflight.set(path, p)
  return p
}

/* ---------- registrasi ---------- */
type SessionEventLike = { type?: string; data?: { arguments?: { workdir?: string } } }

export function apply(ctx: Context): void {
  // Stream live append sesi → index workdir inkremental (0 readSession utk
  // sesi lain). Cast: event 'session/event' tidak ikut type graph build
  // plugin ini; runtime-nya sah (pola sama dengan plugin first-party dsh).
  const on = ctx.on as (name: string, listener: (session: { id?: unknown }, event: SessionEventLike) => void) => () => boolean
  on('session/event', (session, event) => {
    if (event?.type !== 'tool/code-dispatch-start') return
    const wd = event.data?.arguments?.workdir
    if (typeof wd !== 'string') return
    const sid = String(session?.id ?? '')
    if (sid !== '') pushWorkdir(sid, wd)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PREFIX + '/state',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('session') ?? ''
        // Sesi peminta: index live + backfill 1× (history pra-boot).
        const ownWorkdirs = await sessionWorkdirs(ctx, sessionId)
        // Sesi lain: cukup dari index — tanpa readSession sama sekali.
        // Sesi terarsip dikecualikan: dsh-session TIDAK memfilter sessions.list
        // untuk archive set (terverifikasi rc.6). No-op aman bila dsh kelak
        // memfilternya sendiri. Index TIDAK di-prune — gate ada di sini.
        const archivedIds = new Set(ctx.workspaceRegistry.archivedSessionIds as readonly string[])
        const otherBySession = new Map<string, string[]>()
        for (const s of ctx.sessions.list()) {
          const sid = String(s.id)
          if (sid === sessionId || archivedIds.has(sid)) continue
          const wds = workdirIndex.get(sid)
          if (wds && wds.length > 0) otherBySession.set(sid, wds)
        }

        const workspaces = ctx.workspaceRegistry.list()
        const states = await Promise.all(workspaces.map((w) => repoStateFor(ctx, String(w.id), w.title, w.path)))

        // Jangan memutasi objek memo (race antar request) - hasil akhir dibangun ulang.
        const finalStates = states.map((st) => {
          if (!st.repo) return st
          const other: Record<string, string[]> = {}
          for (const w of st.repo.worktrees) {
            const users: string[] = []
            for (const [sid, wds] of otherBySession) {
              if (wds.some((d) => insideDir(d, w.path))) users.push(sid)
            }
            if (users.length > 0) other[w.path] = users
          }
          return { ...st, sessionWorktrees: ownWorkdirs, otherSessionWorktrees: other }
        })

        sendJson(res, 200, { workspaces: finalStates })
      } catch (err) {
        sendError(res, err)
      }
    },
  }))
}
