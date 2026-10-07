/**
 * dsh-git-state - browser half.
 * Slot `conversation.input.dock` (kind list, scope session): strip status git
 * satu baris di atas composer (order -10 → baris paling atas dock, di atas
 * todo/goal/queue). Klik strip → ekspansi panel detail (file berubah, stash,
 * worktree, PR). Data dari route HTTP host half (same-origin fetch), BUKAN
 * RPC /api - mandiri dari allowlist apiproxy (pola dsh-file-explorer).
 *
 * Workspace aktif dicocokkan dari ctx.sessions.list (cwd canonical ↔
 * workspace.path); override manual lewat tab workspace bertahan sampai sesi
 * berganti. Poll otomatis default 30 dtk — interval bisa diatur live dari tab
 * Custom Settings (dsh-custom-settings, namespace 'custom-settings', field
 * gitStatePollMs) via configForms.bind; plugin absen → fallback default.
 * Tombol refresh manual tetap.
 *
 * Styling: WAJIB token --dsw-* (theme-aware) + pola shell repo (row radius 8px
 * + hover --dsw-alias-interactive-bg-hover, ikon 16px feather-style SVG
 * currentColor, TANPA emoji). Satu <style> scoped via ctx.effect.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'

export const name = 'git-state'
// configForms: sumber tunable gitStatePollMs (namespace custom-settings).
// WAJIB dideklarasi di sini — loader client menolak akses properti ctx yang
// tidak ada di inject ("cannot get property ... without inject").
export const inject = ['slots', 'sessions', 'configForms']

const API = '/plugins/dsh-git-state/api/state'
// Interval poll: field gitStatePollMs di namespace 'custom-settings' (tab
// Custom Settings), LIVE mengikuti perubahan nilai (subscribe scope → interval
// dibuat ulang). Fallback default saat plugin settings absen/field kosong.
// Clamp GANDA di konsumen (schema sudah min/max) karena profil DSH aktif
// bisa diedit manual di luar UI.
const DEFAULT_POLL_MS = 30_000
const POLL_MIN_MS = 10_000
const POLL_MAX_MS = 86_400_000

/* ---------- face configForms (loose — pola dsh-custom-settings) ---------- */
interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value?: Record<string, number>
}
interface ScopeLike {
  getSnapshot(): ScopeSnapshot
  subscribe(cb: () => void): () => void
}
interface SettingsScopeFace {
  get(entryId: string): ScopeLike
}
const EMPTY_SNAPSHOT: ScopeSnapshot = { status: 'unavailable' }
/** Scope fallback konstan: hook TIDAK boleh kondisional. */
const NO_SCOPE: ScopeLike = { getSnapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => {} }

/** Format ringkas utk label panel: 30 dtk / 5 mnt / 2 jam / 1 hari. */
function fmtInterval(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)} hari`
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} jam`
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} jam`
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} mnt`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} mnt`
  return `${Math.round(ms / 1000)} dtk`
}

/* ---------- wire types (cocok dengan host half) ---------- */
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
  /** workdir bash sesi peminta (paling baru dulu). */
  sessionWorktrees?: string[]
  /** path worktree → id sesi lain yang sedang mengerjakannya. */
  otherSessionWorktrees?: Record<string, string[]>
}

/* ---------- fallback stabil kalau service sessions absen ---------- */
const EMPTY_LIST: SessionListState = {
  ids: [], byId: {}, current: undefined, phase: 'ready',
  subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}
const NO_LIST: ISessions['list'] = {
  getSnapshot: () => EMPTY_LIST,
  subscribe: () => () => {},
}

/** Cocokkan cwd canonical sesi ke workspace (exact, lalu case-insensitive). */
function matchWorkspace(workspaces: WorkspaceState[], cwdPath: string): WorkspaceState | undefined {
  const exact = workspaces.find((w) => w.path === cwdPath)
  if (exact) return exact
  const lower = cwdPath.toLowerCase()
  return workspaces.find((w) => w.path.toLowerCase() === lower)
}

function insideDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + '/')
}

/**
 * Pilih worktree yang sedang dikerjakan (prioritas):
 * 1. workdir terbaru riwayat bash sesi tab ini di dalam worktree,
 * 2. cwd sesi di dalam worktree,
 * 3. worktree linked yang ada proses hidupnya (dev server dll),
 * 4. checkout utama.
 */
function pickActiveWt(repo: GitState, sessionWts: string[] | undefined, cwd: string | undefined): WorktreeInfo | null {
  const deepest = [...repo.worktrees].sort((a, b) => b.path.length - a.path.length)
  if (sessionWts !== undefined) {
    for (const wd of sessionWts) {
      const hit = deepest.find((w) => insideDir(wd, w.path))
      if (hit) return hit
    }
  }
  if (cwd !== undefined) {
    const hit = deepest.find((w) => insideDir(cwd, w.path))
    if (hit) return hit
  }
  const linkedInUse = deepest.find((w) => !w.main && w.inUse)
  if (linkedInUse) return linkedInUse
  return repo.worktrees.find((w) => w.main) ?? null
}

/* ---------- icons (feather-style inline SVG, warna ikut currentColor) ---------- */
function Icon({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span className="dshgs-icon" style={color !== undefined ? { color } : undefined}>
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </span>
  )
}
const GitIcon = ({ color }: { color?: string }) => <Icon color={color}><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></Icon>
const BranchIcon = ({ color }: { color?: string }) => <Icon color={color}><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></Icon>
const UpIcon = ({ color }: { color?: string }) => <Icon color={color}><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></Icon>
const DownIcon = ({ color }: { color?: string }) => <Icon color={color}><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></Icon>
const DiffIcon = ({ color }: { color?: string }) => <Icon color={color}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Icon>
const StashIcon = ({ color }: { color?: string }) => <Icon color={color}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></Icon>
const WtIcon = ({ color }: { color?: string }) => <Icon color={color}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></Icon>
const PrIcon = ({ color }: { color?: string }) => <Icon color={color}><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></Icon>
const CheckIcon = ({ color }: { color?: string }) => <Icon color={color}><polyline points="20 6 9 17 4 12" /></Icon>
const RefreshIcon = ({ color }: { color?: string }) => <Icon color={color}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></Icon>
const ChevronUpIcon = ({ color }: { color?: string }) => <Icon color={color}><polyline points="18 15 12 9 6 15" /></Icon>
const ChevronDownIcon = ({ color }: { color?: string }) => <Icon color={color}><polyline points="6 9 12 15 18 9" /></Icon>
const AlertIcon = ({ color }: { color?: string }) => <Icon color={color}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></Icon>

/* ---------- stylesheet scoped (hover/focus tidak bisa inline style) ---------- */
const PANEL_CSS = `
.dshgs-root{box-sizing:border-box;
  width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px));
  max-width:calc(var(--dsh-composer-card-max-width, 780px) - 4 * var(--dsh-composer-dock-inset, 8px));
  margin:0 auto}
.dshgs-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:36px;padding:5px 12px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family);font-size:13px;line-height:20px}
.dshgs-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;
  border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:default;font:var(--dsw-font-xs-13);white-space:nowrap}
.dshgs-chip b{font-weight:600;color:var(--dsw-alias-label-primary)}
.dshgs-chip.warn{color:var(--dsw-alias-state-warn-primary)}
.dshgs-chip.ok{color:var(--dsw-alias-state-success-primary)}
.dshgs-chip.err{color:var(--dsw-alias-state-error-primary)}
.dshgs-chip.muted{color:var(--dsw-alias-label-tertiary)}
.dshgs-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1)}
.dshgs-spacer{flex:1}
.dshgs-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshgs-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshgs-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshgs-iconbtn.spinning svg{animation:dshgs-spin 1s linear infinite}
@keyframes dshgs-spin{to{transform:rotate(360deg)}}
.dshgs-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
.dshgs-panel{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  background:var(--dsw-specific-tip);box-shadow:var(--dsw-shadow-lv3);
  max-height:360px;overflow-y:auto}
.dshgs-panel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;
  background:var(--dsw-specific-tip);z-index:2}
.dshgs-panel-title{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600}
.dshgs-ws-tabs{display:flex;gap:4px;flex-wrap:wrap}
.dshgs-ws-tab{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);cursor:pointer}
.dshgs-ws-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgs-ws-tab.active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.dshgs-ws-tab .dshgs-badge{font-size:10px;background:var(--dsw-alias-state-warn-primary);color:#fff;
  border-radius:999px;padding:0 5px;line-height:14px}
.dshgs-panel-meta{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.dshgs-panel-body{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)}
.dshgs-sec{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshgs-sec:last-child{border-bottom:none}
.dshgs-sec+.dshgs-sec{border-left:1px solid var(--dsw-alias-border-l1)}
.dshgs-sec-title{display:flex;align-items:center;gap:6px;padding:0 0 6px;
  font:var(--dsw-font-xxs-12);letter-spacing:.05em;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary)}
.dshgs-sec-title+.dshgs-sec-title{margin-top:12px}
.dshgs-count{font-size:10px;background:var(--dsw-alias-bg-layer-2);border-radius:999px;
  padding:0 6px;color:var(--dsw-alias-label-secondary)}
.dshgs-row{display:flex;align-items:center;gap:8px;min-height:26px;padding:2px 6px;border-radius:6px;
  font:var(--dsw-font-xs-13)}
.dshgs-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgs-code{flex:none;width:20px;text-align:center;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);
  font-size:11px;border-radius:4px;padding:1px 0;color:var(--dsw-alias-state-business-primary);
  background:var(--dsw-alias-bg-layer-2)}
.dshgs-code.untracked{color:var(--dsw-alias-label-tertiary)}
.dshgs-code.conflict{color:var(--dsw-alias-state-error-primary)}
.dshgs-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-primary)}
.dshgs-path a{color:inherit;text-decoration:none}
.dshgs-path a:hover{text-decoration:underline}
.dshgs-meta{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.dshgs-tag{flex:none;font:var(--dsw-font-xxxs-11);border:1px solid var(--dsw-alias-border-l1);
  border-radius:999px;padding:0 6px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshgs-tag.cur{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dshgs-dirty{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.dshgs-dirty.clean{background:var(--dsw-alias-state-success-primary);opacity:.45}
.dshgs-note{padding:6px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary)}
.dshgs-note.err{color:var(--dsw-alias-state-error-primary)}
`

/* ---------- komponen utama ---------- */
function GitStateDock(props: { sessionId?: string; sessions?: ISessions; pollScope?: ScopeLike }): React.ReactElement {
  const [data, setData] = useState<WorkspaceState[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const manualRef = useRef(false)
  const lastSessionRef = useRef<string | undefined>(undefined)

  // Sesi aktif + cwd canonical (SnapshotStore kompatibel useSyncExternalStore).
  const list = props.sessions?.list ?? NO_LIST
  const snap = useSyncExternalStore((cb) => list.subscribe(cb), () => list.getSnapshot())
  const currentId = props.sessionId
  const currentCwd = currentId === undefined ? undefined : snap.byId?.[currentId]?.cwd
  const currentIdRef = useRef<string | undefined>(undefined)
  currentIdRef.current = currentId

  // Interval poll dari Custom Settings (live). WAJIB bungkus arrow di
  // useSyncExternalStore: method scope membaca this (pola dsh-custom-settings);
  // referensi mentah melepas this → TypeError saat render.
  const pollScope = props.pollScope ?? NO_SCOPE
  const scopeSnap = useSyncExternalStore(
    (cb) => pollScope.subscribe(cb),
    () => pollScope.getSnapshot(),
  )
  const rawPoll = scopeSnap.value?.gitStatePollMs
  const pollMs = typeof rawPoll === 'number' && Number.isFinite(rawPoll)
    ? Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(rawPoll)))
    : DEFAULT_POLL_MS

  const load = useCallback(async (opts?: { spin?: boolean }) => {
    if (opts?.spin) setBusy(true)
    try {
      const sid = currentIdRef.current
      const res = await fetch(API + (sid !== undefined ? '?session=' + encodeURIComponent(sid) : ''), { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = (await res.json()) as { workspaces: WorkspaceState[] }
      setData(body.workspaces)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (opts?.spin) setBusy(false)
    }
  }, [])

  // Muat saat mount DAN saat sesi berganti (data deteksi worktree aktif
  // bergantung pada id sesi tab ini).
  useEffect(() => { void load() }, [currentId, load])
  useEffect(() => {
    const t = setInterval(() => void load(), pollMs)
    return () => clearInterval(t)
  }, [load, pollMs])

  // Auto-select workspace sesi aktif; override manual bertahan sampai sesi
  // berganti (paritas dsh-file-explorer).
  useEffect(() => {
    if (!data || data.length === 0) return
    if (currentId !== lastSessionRef.current) {
      lastSessionRef.current = currentId
      manualRef.current = false
      const target = currentCwd !== undefined ? matchWorkspace(data, currentCwd) : undefined
      setSelectedId((target ?? data[0]).id)
    }
  }, [data, currentId, currentCwd])

  const selected = data?.find((w) => w.id === selectedId) ?? data?.[0]
  const repo = selected?.repo ?? null
  const wsError = selected?.error ?? null
  const activeWt = repo === null ? null : pickActiveWt(repo, selected?.sessionWorktrees, currentCwd)
  const changes = repo === null ? null : (activeWt !== null ? activeWt.changes : repo.changes)
  const isClean = repo !== null && changes !== null && changes.total === 0 && repo.stashes.length === 0
    && repo.prs !== null && repo.prs.length === 0 && repo.worktrees.length <= 1

  /* ---------- strip ---------- */
  const chips: React.ReactElement[] = []
  if (data === null && error === null) {
    chips.push(<span key="loading" className="dshgs-chip muted">memuat…</span>)
  } else if (error !== null) {
    chips.push(<span key="error" className="dshgs-chip err" title={error}><AlertIcon color="inherit" /> gagal memuat</span>)
  } else if (selected === undefined) {
    chips.push(<span key="none" className="dshgs-chip muted">belum ada workspace</span>)
  } else if (repo === null) {
    chips.push(<span key="norepo" className="dshgs-chip muted" title={wsError ?? 'Direktori ini bukan repository git'}><GitIcon color="inherit" /> bukan repo git</span>)
  } else {
    // Strip ikut CHECKOUT AKTIF: branch/sync/perubahan dari worktree yang
    // sedang dikerjakan (bukan checkout utama) - pelajaran worktree 18 Aug 2026.
    const wt = activeWt
    const branchLabel = wt !== null
      ? (wt.branch !== null ? wt.branch : '(detached) ' + (wt.headSha7 || repo.headSha))
      : (repo.detached ? '(detached) ' + repo.headSha : (repo.branch || repo.headSha || '?'))
    const syncUp = wt !== null ? wt.upstream : repo.upstream
    const syncAhead = wt !== null ? wt.ahead : repo.ahead
    const syncBehind = wt !== null ? wt.behind : repo.behind
    const ch = changes!
    chips.push(<span key="branch" className="dshgs-chip"><BranchIcon color="inherit" /><b>{branchLabel}</b></span>)
    if (syncAhead > 0 || syncBehind > 0) {
      chips.push(
        <span key="sync" className={'dshgs-chip' + (syncBehind > 0 ? ' warn' : '')}>
          {syncAhead > 0 && <><UpIcon color="inherit" /><b>{syncAhead}</b></>}
          {syncBehind > 0 && <><DownIcon color="inherit" /><b>{syncBehind}</b></>}
        </span>,
      )
    }
    if (ch.total > 0) {
      chips.push(<span key="changes" className="dshgs-chip warn"><DiffIcon color="inherit" /><b>{ch.total}</b> berubah</span>)
    }
    if (repo.stashes.length > 0) {
      chips.push(<span key="stash" className="dshgs-chip"><StashIcon color="inherit" /><b>{repo.stashes.length}</b> stash</span>)
    }
    if (repo.worktrees.length > 1) {
      chips.push(<span key="wt" className="dshgs-chip"><WtIcon color="inherit" /><b>{repo.worktrees.length}</b> worktree</span>)
    }
    if (wt !== null && !wt.main) {
      chips.push(<span key="inwt" className="dshgs-chip" title={wt.path}><WtIcon color="inherit" /> di worktree</span>)
    }
    if (repo.prs !== null && repo.prs.length > 0) {
      chips.push(<span key="pr" className="dshgs-chip"><PrIcon color="inherit" /><b>{repo.prs.length}</b> PR open</span>)
    }
    if (isClean) {
      chips.push(<span key="clean" className="dshgs-chip ok"><CheckIcon color="inherit" /> bersih</span>)
    }
  }

  /* ---------- panel ---------- */
  let panelBody: React.ReactElement
  if (selected === undefined) {
    panelBody = <div className="dshgs-sec"><div className="dshgs-note">Belum ada workspace terdaftar.</div></div>
  } else if (error !== null) {
    panelBody = <div className="dshgs-sec"><div className="dshgs-note err">Gagal memuat status git: {error}</div></div>
  } else if (repo === null) {
    panelBody = <div className="dshgs-sec"><div className="dshgs-note">{wsError ?? 'Direktori ini bukan repository git (tanpa .git).'}</div></div>
  } else if (isClean) {
    panelBody = <div className="dshgs-sec"><div className="dshgs-note"><CheckIcon color="inherit" /> Bersih - tidak ada perubahan, stash, PR open, atau worktree lain.</div></div>
  } else {
    const ch = changes!
    const fileRows = ch.files.length === 0
      ? <div className="dshgs-note">Tidak ada file berubah.</div>
      : ch.files.map((f) => {
        const untracked = f.code === '??'
        const conflicted = 'AUD'.includes(f.code[0] ?? '') && 'AUD'.includes(f.code[1] ?? '')
        const cls = 'dshgs-code' + (untracked ? ' untracked' : conflicted ? ' conflict' : '')
        return (
          <div key={f.path} className="dshgs-row" title={f.path}>
            <span className={cls}>{f.code}</span>
            <span className="dshgs-path">{f.path}</span>
          </div>
        )
      })
    const stashRows = repo.stashes.length === 0
      ? <div className="dshgs-note">Tidak ada stash.</div>
      : repo.stashes.map((s) => (
        <div key={s.ref} className="dshgs-row" title={s.message}>
          <span className="dshgs-path">{s.ref}</span>
          <span className="dshgs-meta">{s.message}</span>
        </div>
      ))
    const wtRows = repo.worktrees.map((w) => {
      const isActive = activeWt !== null && w.path === activeWt.path
      const otherUsers = selected?.otherSessionWorktrees?.[w.path]
      return (
        <div key={w.path} className="dshgs-row" title={w.path}>
          <span className={'dshgs-dirty' + (w.changes.total > 0 ? '' : ' clean')} title={w.changes.total > 0 ? 'ada perubahan' : 'bersih'} />
          <span className="dshgs-path">{w.path}</span>
          {w.branch !== null && <span className="dshgs-tag">{w.branch}</span>}
          {w.main && <span className="dshgs-tag">utama</span>}
          {isActive && <span className="dshgs-tag cur">aktif</span>}
          {!w.main && w.inUse && <span className="dshgs-tag">dipakai</span>}
          {otherUsers !== undefined && otherUsers.length > 0 && (
            <span className="dshgs-tag" title={'sesi: ' + otherUsers.join(', ')}>dikerjakan sesi lain</span>
          )}
          {w.changes.total > 0 && <span className="dshgs-meta">{w.changes.total} berubah</span>}
        </div>
      )
    })
    const prRows = repo.prs === null || repo.prs.length === 0
      ? <div className="dshgs-note">{repo.prs === null ? 'gh tidak tersedia / gagal auth.' : 'Tidak ada PR open.'}</div>
      : repo.prs.map((p) => (
        <div key={p.number} className="dshgs-row">
          <span className="dshgs-tag">#{p.number}</span>
          <span className="dshgs-path"><a href={p.url} target="_blank" rel="noopener noreferrer">{p.title}</a></span>
          <span className="dshgs-meta">{p.head}</span>
        </div>
      ))
    panelBody = (
      <>
        <div className="dshgs-sec">
          <div className="dshgs-sec-title"><DiffIcon color="inherit" /> Perubahan <span className="dshgs-count">{ch.total}</span></div>
          {fileRows}
        </div>
        <div className="dshgs-sec">
          <div className="dshgs-sec-title"><StashIcon color="inherit" /> Stash <span className="dshgs-count">{repo.stashes.length}</span></div>
          {stashRows}
          <div className="dshgs-sec-title"><WtIcon color="inherit" /> Worktree <span className="dshgs-count">{repo.worktrees.length}</span></div>
          {wtRows}
          <div className="dshgs-sec-title"><PrIcon color="inherit" /> PR open <span className="dshgs-count">{repo.prs?.length ?? 0}</span></div>
          {prRows}
        </div>
      </>
    )
  }

  const tabs = (data ?? []).map((w) => {
    const count = w.repo?.changes.total ?? 0
    return (
      <button key={w.id}
        className={'dshgs-ws-tab' + (w.id === selected?.id ? ' active' : '')}
        onClick={() => { manualRef.current = true; setSelectedId(w.id) }}>
        {w.title}
        {count > 0 && <span className="dshgs-badge">{count}</span>}
      </button>
    )
  })

  const syncMeta = repo === null ? '' : (() => {
    const up = activeWt !== null ? activeWt.upstream : repo.upstream
    const a = activeWt !== null ? activeWt.ahead : repo.ahead
    const b = activeWt !== null ? activeWt.behind : repo.behind
    return (up !== null ? up + ' · ' : '') + '↑' + a + ' ↓' + b
  })()

  return (
    <div className="dshgs-root">
      <div className="dshgs-strip" onClick={() => setOpen(!open)} title={open ? 'Sembunyikan detail' : 'Lihat detail'}>
        {chips}
        <span className="dshgs-sep" />
        <span className="dshgs-spacer" />
        <button className={'dshgs-iconbtn' + (busy ? ' spinning' : '')} title="Refresh"
          onClick={(e) => { e.stopPropagation(); void load({ spin: true }) }}>
          <RefreshIcon color="inherit" />
        </button>
        <button className="dshgs-iconbtn" title={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDownIcon color="inherit" /> : <ChevronUpIcon color="inherit" />}
        </button>
      </div>
      {open && (
        <div className="dshgs-panel">
          <div className="dshgs-panel-head">
            <span className="dshgs-panel-title"><GitIcon color="inherit" /> Git State</span>
            <span className="dshgs-ws-tabs">{tabs}</span>
            <span className="dshgs-spacer" />
            <span className="dshgs-panel-meta">auto-refresh {fmtInterval(pollMs)}{syncMeta !== '' ? ' · ' + syncMeta : ''}</span>
          </div>
          <div className="dshgs-panel-body">{panelBody}</div>
        </div>
      )}
    </div>
  )
}

/* ---------- registrasi ---------- */
export function apply(ctx: Context): void {
  const ctxAny = ctx as unknown as {
    sessions?: ISessions
    configForms?: SettingsScopeFace
  }
  const sessions = ctxAny.sessions
  // Namespace Custom Settings (dsh-custom-settings): sumber gitStatePollMs.
  // Bind sekali di apply (bukan per render); absen → degrade halus ke default.
  const configForms = ctxAny.configForms
  const pollScope = configForms ? configForms.get('custom-settings') : undefined

  // Stylesheet scoped + disposable (pola dsh-file-explorer).
  ctx.effect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-dsh-git-state', '')
    el.textContent = PANEL_CSS
    document.head.appendChild(el)
    return () => { el.remove() }
  })

  // WAJIB lewat slots.inject (anti-race deklarasi slot); slot list wajib
  // options.id. order -10 → baris paling atas dock, di atas todo/goal/queue.
  const slots = ctx as unknown as {
    slots: {
      inject(slotName: string, callback: () => void): void
      register(spec: unknown, component: unknown): void
    }
  }
  slots.slots.inject('conversation.input.dock', () => slots.slots.register(
    { name: 'conversation.input.dock', id: 'git-state', order: -10, inject: () => ({ sessions, pollScope }) },
    GitStateDock,
  ))
}
