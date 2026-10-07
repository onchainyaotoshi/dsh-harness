/**
 * dsh-session-archive - browser half.
 * Section Settings "Archived Sessions" (slot settings.section, order 16 =
 * setelah Plugins): daftar sesi terarsip per workspace + tombol Unarchive
 * DENGAN dialog konfirmasi (keputusan user). Busy-state per baris, error
 * inline; tanpa polling — update via frame host/archived-sessions-changed.
 *
 * Data dari ctx.workspaces.list (archivedSessionIds + items[].sessionIds) dan
 * ctx.sessions.list (judul — byId TIDAK difilter arsip, terverifikasi rc.6).
 * Unarchive via route HTTP host half (pola fetch dsh-git-state).
 */
import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'

export const name = 'session-archive'
export const inject = ['workspaces', 'sessions', 'slots']

const API = '/plugins/dsh-session-archive/api/unarchive'
const MAX_PER_GROUP = 10 // cap tampilan per workspace; sisanya "+N lainnya"

/* ---------- face layanan (loose — kebenaran runtime ada di dsh) ---------- */
interface WorkspaceViewLike { workspaceId: string; title: string; sessionIds: readonly string[] }
interface WorkspacesSnapshot {
  items: readonly WorkspaceViewLike[]
  archivedSessionIds: readonly string[]
  phase?: string
}
interface WsFace {
  list: { subscribe(cb: () => void): () => void; getSnapshot(): WorkspacesSnapshot }
  refresh(): Promise<unknown>
}
interface SessionsFace {
  list: {
    subscribe(cb: () => void): () => void
    getSnapshot(): { byId?: Record<string, { title?: string }> }
  }
}

const CSS = `
.dshsa-root{display:flex;flex-direction:column;gap:12px}
.dshsa-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.dshsa-empty{border:1px dashed var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);text-align:center;border-radius:8px;padding:16px;font-size:13px}
.dshsa-group{display:flex;flex-direction:column;gap:6px}
.dshsa-group-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px}
.dshsa-count{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:0 8px;font-size:11px;line-height:16px}
.dshsa-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1)}
.dshsa-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dshsa-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsa-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dshsa-btn{box-sizing:border-box;height:28px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent;border-radius:14px;padding:0 12px;font-size:12px;line-height:18px;white-space:nowrap}
.dshsa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshsa-btn:disabled{opacity:.4;cursor:default}
.dshsa-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshsa-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshsa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000}
.dshsa-dialog{width:min(420px,calc(100vw - 32px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
.dshsa-dialog-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:24px}
.dshsa-dialog-body{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dshsa-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dshsa-more{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:2px 12px}
`

function ArchivedSessionsSection(props: { workspaces: WsFace; sessions: SessionsFace }): ReactElement {
  const { workspaces, sessions } = props
  const ws = useSyncExternalStore((cb) => workspaces.list.subscribe(cb), () => workspaces.list.getSnapshot())
  const ss = useSyncExternalStore((cb) => sessions.list.subscribe(cb), () => sessions.list.getSnapshot())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)

  const titles = ss.byId ?? {}
  const archivedSet = new Set(ws.archivedSessionIds)

  // Urutan arsip: indeks lebih tinggi = lebih baru diarsip (archivedSessionIds
  // dalam archive order). Sort TERBARU DULUAN per grup; cap top-N per grup.
  const archiveRank = new Map([...ws.archivedSessionIds].map((id, i) => [id, i]))
  const byNewest = (a: string, b: string) => (archiveRank.get(b) ?? -1) - (archiveRank.get(a) ?? -1)

  // Grup per workspace (urutan items); sisanya → "Unassigned" di bawah
  // (sesi tanpa accounting workspace itu sah).
  const groups: { title: string; ids: string[] }[] = []
  const assigned = new Set<string>()
  for (const w of ws.items) {
    const ids = (w.sessionIds ?? []).filter((id) => archivedSet.has(id)).sort(byNewest)
    if (ids.length === 0) continue
    groups.push({ title: w.title || w.workspaceId, ids })
    for (const id of ids) assigned.add(id)
  }
  const unassigned = ws.archivedSessionIds.filter((id) => !assigned.has(id)).sort(byNewest)
  if (unassigned.length > 0) groups.push({ title: 'Unassigned', ids: unassigned })

  async function doUnarchive(sessionId: string): Promise<void> {
    setConfirmId(null)
    setBusyId(sessionId)
    setErrorId(null)
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (!res.ok) {
        setErrorId(sessionId)
        return
      }
      const body = (await res.json()) as { archivedSessionIds?: string[] }
      // Sukses: store ter-update via frame host/archived-sessions-changed.
      // Belt-and-suspenders: kalau set tak berubah (no-op idempoten), refresh.
      if (body.archivedSessionIds?.includes(sessionId)) {
        try { await workspaces.refresh() } catch { /* degradasi halus */ }
      }
    } catch {
      setErrorId(sessionId)
    } finally {
      setBusyId(null)
    }
  }

  if (ws.phase !== undefined && ws.phase !== 'ready') {
    return <div className="dshsa-root"><p className="dshsa-empty">Loading…</p></div>
  }
  if (groups.length === 0) {
    return (
      <div className="dshsa-root">
        <p className="dshsa-intro">Sesi terarsip tidak tampil di daftar sesi; unarchive mengembalikannya ke posisi semula.</p>
        <p className="dshsa-empty">No archived sessions.</p>
      </div>
    )
  }

  return (
    <div className="dshsa-root">
      <p className="dshsa-intro">Sesi terarsip tidak tampil di daftar sesi; unarchive mengembalikannya ke posisi semula.</p>
      {groups.map((g) => (
        <div key={g.title} className="dshsa-group">
          <div className="dshsa-group-head">
            {g.title}
            <span className="dshsa-count">{g.ids.length}</span>
          </div>
          {g.ids.slice(0, MAX_PER_GROUP).map((id) => (
            <div key={id} className="dshsa-row">
              <div className="dshsa-meta">
                <div className="dshsa-title">{titles[id]?.title || id}</div>
                {errorId === id && <div className="dshsa-error">Gagal unarchive — coba lagi.</div>}
              </div>
              <button
                type="button"
                className="dshsa-btn"
                disabled={busyId === id}
                onClick={() => setConfirmId(id)}
              >
                {busyId === id ? 'Unarchiving…' : 'Unarchive'}
              </button>
            </div>
          ))}
          {g.ids.length > MAX_PER_GROUP && (
            <div className="dshsa-more">+ {g.ids.length - MAX_PER_GROUP} lainnya</div>
          )}
        </div>
      ))}
      {confirmId !== null && (
        <div className="dshsa-overlay" role="presentation" onClick={() => setConfirmId(null)}>
          <div
            className="dshsa-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => { e.stopPropagation() }}
          >
            <div className="dshsa-dialog-title">Unarchive session?</div>
            <div className="dshsa-dialog-body">
              “{titles[confirmId]?.title || confirmId}” akan kembali muncul di daftar sesi.
              Aksinya reversibel — bisa di-archive lagi kapan pun.
            </div>
            <div className="dshsa-dialog-actions">
              <button type="button" className="dshsa-btn" onClick={() => setConfirmId(null)}>Cancel</button>
              <button type="button" className="dshsa-btn dshsa-btn-primary" onClick={() => void doUnarchive(confirmId)}>Unarchive</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- registrasi ---------- */
export function apply(ctx: Context): void {
  const workspaces = (ctx as unknown as { workspaces?: WsFace }).workspaces
  const sessions = (ctx as unknown as { sessions?: SessionsFace }).sessions
  if (!workspaces || !sessions) return // degradasi halus: tanpa section

  // Stylesheet scoped + disposable (pola dsh-file-explorer/dsh-git-state).
  ctx.effect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-dsh-session-archive', '')
    el.textContent = CSS
    document.head.appendChild(el)
    return () => { el.remove() }
  })

  // WAJIB lewat slots.inject (anti-race deklarasi slot); slot list wajib options.id.
  const slots = ctx as unknown as {
    slots: {
      inject(slotName: string, callback: () => void): void
      register(spec: unknown, component: unknown): void
    }
  }
  slots.slots.inject('settings.section', () => slots.slots.register(
    {
      name: 'settings.section',
      id: 'archived-sessions',
      order: 25, // paling akhir: general=0, models=10, plugins=15, agent-presets=20 (dsh-client-ui-agent-preset)
      label: () => 'Archived Sessions',
      inject: () => ({ workspaces, sessions }),
    },
    ArchivedSessionsSection,
  ))
}
