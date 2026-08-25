/**
 * dsh-file-explorer — browser half.
 * Dua entry slot:
 *   conversation.session.header.utilities → tombol TOGGLE panel di kanan atas
 *                                            header sesi (di samping tombol
 *                                            "session log"), order 1 supaya
 *                                            render setelah occupant default
 *                                            (order 0). Scope sesi: tombol
 *                                            tidak muncul di layar hero.
 *                                            Klik = buka bila tertutup,
 *                                            tutup bila terbuka (cek DOM).
 *   details              → KOLOM KANAN LAYOUT beneran (bukan overlay):
 *                          panel file memakan layout, chat terdorong, lebar
 *                          bisa di-drag (clamp 300–520px, default 360px),
 *                          dibuka/ditutup lewat ctx.layout.openDetails()/
 *                          closeDetails(). Seat ini menggantikan (shadow)
 *                          panel "tool details" bawaan — keputusan pemilik.
 *
 * Data lewat route HTTP host half (same-origin fetch), BUKAN RPC /api —
 * jadi plugin ini mandiri dari allowlist apiproxy. Keamanan di sisi host
 * (containment workspace).
 *
 * Styling: WAJIB token --dsw-* (theme-aware light/dark) + pola shell
 * (row radius 8px, icon-button 28px bulat, hover
 * --dsw-alias-interactive-bg-hover, header panel = pola DetailsPanel
 * bawaan). Hover/focus tidak bisa dinyatakan di inline style → satu
 * <style> scoped di-inject lewat ctx.effect (dibuang saat plugin unload).
 *
 * Workspace aktif: ctx.sessions.list (SnapshotStore, bentuk SessionListState)
 * → list.current + byId[id].cwd (path canonical) → dicocokkan ke
 * workspace.path di sisi client. Tanpa endpoint host baru; override manual
 * bertahan sampai sesi aktif berganti.
 *
 * TODO(verify): bentuk persis ComposedProps slot (PropsRuntime dll) dicek
 * ulang saat runtime 0.1.0-rc.6 — sementara props komponen diketik longgar.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'

export const name = 'file-explorer'
export const inject = ['slots', 'sessions', 'layout']

const API = '/plugins/dsh-file-explorer/api'

/* ---------- wire types (cocok dengan host half) ---------- */
interface WorkspaceInfo { id: string; title: string; path: string }
interface FsEntry { name: string; type: 'file' | 'directory' | 'other'; size?: number; path: string }
interface ListResponse { path: string; entries: FsEntry[] }
interface ReadResponse { path: string; text: string }
interface ApiError { error?: string; detail?: string }
/** State viewer: teks ATAU preview gambar ATAU catatan (mis. file biner). */
interface ViewerState { path: string; text?: string; imageUrl?: string; note?: string }

/** Mirror batas /raw di host: gambar lebih besar dilewati dengan catatan. */
const MAX_RAW_BYTES = 8 * 1024 * 1024
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = (await res.json().catch(() => null)) as (T & ApiError) | null
  if (!res.ok) {
    const msg = body?.error ? body.error + (body.detail ? ' (' + body.detail + ')' : '') : 'HTTP ' + res.status
    throw new Error(msg)
  }
  return body as T
}

function parentOf(path: string): string {
  if (path === '/') return '/'
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

/* ---------- preferensi buka/tutup panel (persisten per browser) ---------- */
/**
 * Seat `details` ber-scope SESI → komponen panel remount setiap pindah sesi.
 * Tanpa ingatan persisten, auto-open di mount selalu menimpa keputusan
 * pengguna yang sengaja menutup panel (keluhan nyata 25 Aug 2026). Pref ini
 * HANYA ditulis oleh aksi sadar pengguna: tombol close panel → 'closed',
 * tombol Files di header → 'open'. Tanpa pref (browser baru) → auto-open,
 * paritas dengan perilaku lama.
 */
const PANEL_PREF_KEY = 'dsh-file-explorer.details'
type PanelPref = 'open' | 'closed'
function readPanelPref(): PanelPref | null {
  try {
    const v = window.localStorage.getItem(PANEL_PREF_KEY)
    return v === 'open' || v === 'closed' ? v : null
  } catch { return null }
}
function writePanelPref(pref: PanelPref): void {
  try { window.localStorage.setItem(PANEL_PREF_KEY, pref) } catch { /* private mode dkk: abaikan */ }
}

/** Cocokkan cwd canonical sesi ke workspace terdaftar (exact, lalu case-insensitive). */
function matchWorkspace(workspaces: WorkspaceInfo[], cwdPath: string): WorkspaceInfo | undefined {
  const exact = workspaces.find((w) => w.path === cwdPath)
  if (exact) return exact
  const lower = cwdPath.toLowerCase()
  return workspaces.find((w) => w.path.toLowerCase() === lower)
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

/* ---------- icons (feather-style inline SVG, warna ikut currentColor) ---------- */
function Icon({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span className="dshfe-icon" style={color !== undefined ? { color } : undefined}>
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </span>
  )
}
const FolderIcon = ({ color }: { color?: string }) => <Icon color={color}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Icon>
const FileIcon = ({ color }: { color?: string }) => <Icon color={color}><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></Icon>
const UpIcon = ({ color }: { color?: string }) => <Icon color={color}><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></Icon>
const DownIcon = ({ color }: { color?: string }) => <Icon color={color}><polyline points="6 9 12 15 18 9" /></Icon>
const CloseIcon = ({ color }: { color?: string }) => <Icon color={color}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Icon>

/* ---------- stylesheet scoped (hover/focus tidak bisa inline style) ---------- */
const PANEL_CSS = `
.dshfe-panel{width:100%;height:100%;display:flex;flex-direction:column;min-width:0;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family);font-size:14px;line-height:22px}
.dshfe-header{flex:none;display:flex;align-items:center;gap:8px;padding:14px 12px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshfe-title{flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:14px;font-weight:500;line-height:20px}
.dshfe-select-wrap{position:relative;flex:1;min-width:0;display:flex;align-items:center}
.dshfe-select{flex:1;min-width:0;height:32px;padding:0 24px 0 8px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:var(--dsw-font-xs-13);cursor:pointer;-webkit-appearance:none;appearance:none}
.dshfe-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshfe-select-caret{position:absolute;right:6px;pointer-events:none}
.dshfe-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshfe-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfe-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshfe-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
  color:var(--dsw-alias-label-tertiary)}
.dshfe-crumbs{flex:none;display:flex;align-items:center;gap:4px;padding:6px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshfe-crumbs-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.dshfe-tree{flex:1;min-height:0;overflow-y:auto;padding:4px}
.dshfe-row{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px;border-radius:8px;
  cursor:pointer;font:var(--dsw-font-xs-13);user-select:none}
.dshfe-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfe-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshfe-row-size{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.dshfe-note{padding:8px 12px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary)}
.dshfe-error{padding:8px 12px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-error-primary)}
.dshfe-viewer{flex:none;height:45%;display:flex;flex-direction:column;min-height:0;
  border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block)}
.dshfe-viewer-head{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;
  background:var(--dsw-alias-markdown-code-block-banner)}
.dshfe-viewer-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.dshfe-viewer-pre{flex:1;min-height:0;margin:0;overflow:auto;padding:8px 12px;
  font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-primary);
  white-space:pre;tab-size:2}
.dshfe-viewer-imgwrap{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;
  justify-content:center;padding:12px}
.dshfe-viewer-img{max-width:100%;height:auto;border-radius:8px}
.dshfe-toggle-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;
  width:32px;height:32px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshfe-toggle-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfe-toggle-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
`

/* ---------- panel (kolom details layout, bukan overlay) ---------- */
function FileExplorerPanel(props: { sessions?: ISessions; closeDetails?: () => void; openDetails?: () => void }): React.ReactElement {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<ViewerState | null>(null)
  // Override manual bertahan sampai sesi aktif berganti; bukan state render.
  const manualRef = useRef(false)
  const lastSessionRef = useRef<string | undefined>(undefined)

  // Auto-open saat scope sesi materialisasi — TAPI hormati pref pengguna:
  // yang pernah sengaja menutup panel (pref 'closed') TIDAK dibuka paksa
  // lagi tiap pindah sesi. Seat ini remount per sesi, jadi guard ini wajib.
  useEffect(() => {
    if (readPanelPref() === 'closed') return
    props.openDetails?.()
  }, [props.openDetails])

  // Sesi aktif + cwd canonical-nya (SnapshotStore kompatibel useSyncExternalStore).
  const list = props.sessions?.list ?? NO_LIST
  const listSnapshot = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const currentId = listSnapshot.current
  const currentCwd = currentId === undefined ? undefined : listSnapshot.byId?.[currentId]?.cwd

  useEffect(() => {
    getJson<WorkspaceInfo[]>(API + '/workspaces')
      .then((ws) => setWorkspaces(ws))
      .catch((err: Error) => setError(err.message))
  }, [])

  const pick = useCallback((ws: WorkspaceInfo) => {
    setWorkspaceId(ws.id)
    setCwd(ws.path)
    setViewing(null)
  }, [])

  // Auto-select: workspace tempat sesi aktif berada. Tanpa sesi (hero) →
  // workspace pertama. Override manual dipertahankan sampai sesi berganti.
  useEffect(() => {
    if (workspaces.length === 0) return
    if (currentId !== lastSessionRef.current) {
      lastSessionRef.current = currentId
      manualRef.current = false
      const target = currentCwd !== undefined ? matchWorkspace(workspaces, currentCwd) : undefined
      if (target) { pick(target); return }
      if (currentId === undefined) { pick(workspaces[0]); return }
    }
    if (manualRef.current) return
    if (workspaceId === '') pick(workspaces[0])
  }, [workspaces, currentId, currentCwd, pick])

  const load = useCallback(async (ws: string, path: string) => {
    try {
      setError(null)
      const data = await getJson<ListResponse>("" + API + '/list?workspace=' + encodeURIComponent(ws) + '&path=' + encodeURIComponent(path))
      setEntries(data.entries)
      setCwd(data.path)
    } catch (err) {
      setEntries([])
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    if (workspaceId && cwd) void load(workspaceId, cwd)
  }, [workspaceId, load])

  const openFile = useCallback(async (path: string, size?: number) => {
    try {
      setError(null)
      const name = path.split('/').pop() ?? ''
      // Gambar → preview via /raw (host apply containment yang sama).
      if (IMAGE_EXT.test(name)) {
        if (size !== undefined && size > MAX_RAW_BYTES) {
          setViewing({ path, note: 'Gambar terlalu besar untuk dipratinjau.' })
          return
        }
        setViewing({
          path,
          imageUrl: API + '/raw?workspace=' + encodeURIComponent(workspaceId) + '&path=' + encodeURIComponent(path),
        })
        return
      }
      const data = await getJson<ReadResponse>("" + API + '/read?workspace=' + encodeURIComponent(workspaceId) + '&path=' + encodeURIComponent(path))
      setViewing({ path, text: data.text })
    } catch (err) {
      const message = (err as Error).message
      if (message.startsWith('binary-file')) {
        setViewing({ path, note: 'File biner — tidak bisa ditampilkan sebagai teks.' })
      } else {
        setError(message)
      }
    }
  }, [workspaceId])

  const dirs = (entries ?? []).filter((e) => e.type === 'directory')
  const files = (entries ?? []).filter((e) => e.type !== 'directory')

  return (
    <div className="dshfe-panel">
      <div className="dshfe-header">
        <span className="dshfe-title">Files</span>
        <span className="dshfe-select-wrap">
          <select
            className="dshfe-select"
            value={workspaceId}
            onChange={(e) => {
              const ws = workspaces.find((w) => w.id === e.target.value)
              if (!ws) return
              manualRef.current = true
              pick(ws)
            }}
            title={workspaces.find((w) => w.id === workspaceId)?.path ?? ''}
          >
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
          </select>
          <span className="dshfe-select-caret"><DownIcon /></span>
        </span>
        <button className="dshfe-iconbtn" title="Close panel"
          onClick={() => props.closeDetails?.()}>
          <CloseIcon color="inherit" />
        </button>
      </div>
      <div className="dshfe-crumbs">
        <button className="dshfe-iconbtn" title="Parent folder"
          onClick={() => { setViewing(null); void load(workspaceId, parentOf(cwd)) }}>
          <UpIcon color="inherit" />
        </button>
        <span className="dshfe-crumbs-path" title={cwd}>{cwd}</span>
      </div>
      <div className="dshfe-tree">
        {error && <div className="dshfe-error">{error}</div>}
        {entries === null && !error && <div className="dshfe-note">Loading…</div>}
        {dirs.map((e) => (
          <div key={e.path} className="dshfe-row" title={e.path}
            onClick={() => { setViewing(null); void load(workspaceId, e.path) }}>
            <FolderIcon />
            <span className="dshfe-row-name">{e.name}</span>
          </div>
        ))}
        {files.map((e) => (
          <div key={e.path} className="dshfe-row" title={e.path}
            onClick={() => void openFile(e.path, e.size)}>
            <FileIcon />
            <span className="dshfe-row-name">{e.name}</span>
            {typeof e.size === 'number' && <span className="dshfe-row-size">{e.size}</span>}
          </div>
        ))}
        {entries !== null && entries.length === 0 && !error && <div className="dshfe-note">(empty)</div>}
      </div>
      {viewing && (
        <div className="dshfe-viewer">
          <div className="dshfe-viewer-head">
            <FileIcon />
            <span className="dshfe-viewer-path" title={viewing.path}>{viewing.path}</span>
            <button className="dshfe-iconbtn" title="Close file" onClick={() => setViewing(null)}>
              <CloseIcon color="inherit" />
            </button>
          </div>
          {viewing.imageUrl !== undefined ? (
            <div className="dshfe-viewer-imgwrap">
              <img className="dshfe-viewer-img" src={viewing.imageUrl} alt={viewing.path} />
            </div>
          ) : viewing.note !== undefined ? (
            <div className="dshfe-note">{viewing.note}</div>
          ) : (
            <pre className="dshfe-viewer-pre">{viewing.text}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- tombol di header sesi (kanan atas, di samping session log) ---------- */
/**
 * TOGGLE: klik pertama buka panel, klik berikutnya menutup. Sumber kebenaran
 * status = geometri DOM, BUKAN state mirror: konten seat `details` tetap
 * ter-mount walau kolom diciutkan (grid 0px — AppFrame selalu merender slot,
 * diverifikasi di bundle dsh-client-ui-layout 0.1.1-rc.1), jadi
 * `.dshfe-panel`.clientWidth > 0 = panel benar-benar terlihat. Mirror state
 * sendiri pasti desinkron karena ui-layout mem-close details OTOMATIS tiap
 * pindah sesi (useLayoutEffect AppFrame) di luar kendali plugin ini.
 */
function FilesHeaderAction(props: { openDetails?: () => void; closeDetails?: () => void }): React.ReactElement {
  const onClick = () => {
    const el = document.querySelector('.dshfe-panel')
    const isOpen = el !== null && el.clientWidth > 0
    if (isOpen) props.closeDetails?.()
    else props.openDetails?.()
  }
  return (
    <button className="dshfe-toggle-btn" title="File explorer" aria-label="File explorer"
      onClick={onClick}>
      <FolderIcon color="inherit" />
    </button>
  )
}

/* ---------- registrasi ---------- */
export function apply(ctx: Context): void {
  const sessions = (ctx as unknown as { sessions?: ISessions }).sessions
  const layout = (ctx as unknown as {
    layout?: { openDetails(): void; closeDetails(): void }
  }).layout

  // layout actions bisa belum "wired" sebelum root entry mount — jangan
  // biarkan error itu membunuh render panel. Buka/tutup VIA PLUGIN ini
  // (tombol Files / tombol X) = keputusan sadar pengguna → catat pref di
  // SATU tempat supaya tidak ada jalur yang lupa menulis (kejadian nyata
  // 25 Aug 2026: toggle menutup panel tapi pref tak tertulis → pindah sesi
  // langsung auto-open lagi). Auto-close AppFrame saat pindah sesi TIDAK
  // lewat sini → pref tidak tersentuh, by design.
  const openPanel = () => {
    writePanelPref('open')
    try { layout?.openDetails() } catch { /* belum wired */ }
  }
  const closePanel = () => {
    writePanelPref('closed')
    try { layout?.closeDetails() } catch { /* belum wired */ }
  }

  // Stylesheet scoped + disposable: hover/focus butuh pseudo-class yang
  // tidak bisa dinyatakan di inline style; dibuang saat plugin unload.
  ctx.effect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-dsh-file-explorer', '')
    el.textContent = PANEL_CSS
    document.head.appendChild(el)
    return () => { el.remove() }
  })

  // WAJIB lewat slots.inject: register langsung di apply bisa race dengan
  // deklarasi slot oleh ui-layout/ui-conversation (error: slot is not
  // declared). Pattern resmi = ctx.slots.inject(slotName, () =>
  // ctx.slots.register(...)) — callback dijalankan begitu slot-nya
  // terdeklarasi.
  const slots = ctx as unknown as {
    slots: {
      inject(slotName: string, callback: () => void): void
      register(spec: unknown, component: unknown): void
    }
  }
  // Seat "details" (kolom kanan layout): menggantikan panel tool-details
  // bawaan — kolom beneran yang memakan layout (keputusan pemilik repo).
  // Slot single TIDAK boleh register di priority yang sama dengan occupant
  // (default 0 → throw "already has a registration at priority 0"); shadow
  // wajib priority LEBIH RENDAH (lowest renders) → -1.
  slots.slots.inject('details', () => slots.slots.register(
    { name: 'details', priority: -1, inject: () => ({ sessions, closeDetails: closePanel, openDetails: openPanel }) },
    FileExplorerPanel,
  ))
  // Slot ber-kind 'list' WAJIB options.id (identitas entry di ledger list).
  // order 1: occupant bawaan "session-log-download" pakai order default 0,
  // render ascending → tombol Files tampil di sebelah KANAN tombol session log.
  slots.slots.inject('conversation.session.header.utilities', () => slots.slots.register(
    { name: 'conversation.session.header.utilities', id: 'file-explorer-toggle', order: 1, inject: () => ({ openDetails: openPanel, closeDetails: closePanel }) },
    FilesHeaderAction,
  ))
}
