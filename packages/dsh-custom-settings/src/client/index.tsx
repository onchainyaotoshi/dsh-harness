/**
 * dsh-custom-settings - browser half.
 * Section Settings "Custom Settings" (slot settings.section, order 26 =
 * PALING AKHIR, setelah "Archived Sessions" order 25):
 *   - form tunable (render otomatis dari GET /api/tunables; nilai dari
 *     settingsScope.bind({namespace:'custom-settings'}); Save via scope.set)
 *   - kartu versi dsh: versi terpasang tampil instan (GET /api/status, lokal),
 *     tombol "Cek versi terbaru" (GET /api/version, npm), tombol Upgrade
 *     dengan dialog konfirmasi (POST /api/upgrade → npm install → restart).
 *
 * Deskripsi inline + tooltip hover per fungsi; badge "berlaku langsung" vs
 * "perlu restart" dari flag `restart` deskriptor tunable.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'

export const name = 'custom-settings'
export const inject = ['settingsScope', 'slots']

const API = '/plugins/dsh-custom-settings/api'
const STATUS_POLL_MS = 2000

/* ---------- face layanan (loose — kebenaran runtime ada di dsh) ---------- */
interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value?: Record<string, number>
  revision?: number
  writable?: boolean
}
interface ScopeLike {
  getSnapshot(): ScopeSnapshot
  subscribe(cb: () => void): () => void
  set(field: string, value: number): Promise<unknown>
  unset(field: string): Promise<unknown>
}
interface SettingsScopeFace {
  bind(spec: { namespace: string }): ScopeLike
}
interface TunablePreset { label: string; value: number }
interface Tunable {
  id: string
  label: string
  description: string
  tooltip: string
  min: number
  max: number
  default: number
  unit?: string
  presets?: TunablePreset[]
  restart?: boolean
  /** 'host' (default) | 'browser' — siapa konsumen nilai (utk teks status). */
  consumer?: string
}
interface StatusResponse {
  applied: Record<string, number> | null
  installedVersion: string | null
  lastRestartFailed?: boolean
}
interface VersionResponse {
  ok?: boolean
  installed?: string | null
  latest?: string | null
  upToDate?: boolean
  checkedAt?: string
  reason?: string
}
interface UpgradeResponse {
  ok?: boolean
  from?: string | null
  to?: string | null
  reason?: string
  outputTail?: string
}

/* ---------- helper format ---------- */
function fmtMs(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} jam`
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} menit`
  return `${ms} ms`
}

const CSS = `
.dscs-root{display:flex;flex-direction:column;gap:14px}
.dscs-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.dscs-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}
.dscs-card-title{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px;margin:0}
.dscs-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}
.dscs-field-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dscs-input{box-sizing:border-box;height:32px;width:180px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;outline:none}
.dscs-input:focus{border-color:var(--dsw-alias-interactive-primary)}
.dscs-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dscs-btn{box-sizing:border-box;height:28px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent;border-radius:14px;padding:0 12px;font-size:12px;line-height:18px;white-space:nowrap}
.dscs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dscs-btn:disabled{opacity:.4;cursor:default}
.dscs-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dscs-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dscs-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dscs-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-hover,var(--dsw-alias-state-error-primary))}
.dscs-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 9px;font-size:11px;line-height:18px;white-space:nowrap}
.dscs-badge-live{border-color:transparent;background:var(--dsw-alias-state-success-soft,transparent);color:var(--dsw-alias-state-success-primary)}
.dscs-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}
.dscs-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
.dscs-tip{position:relative;display:inline-flex;margin-left:2px;color:var(--dsw-alias-label-tertiary);vertical-align:middle;cursor:help}
.dscs-tip svg{width:15px;height:15px;display:block}
.dscs-tip::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + 6px);width:max-content;max-width:300px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;font-weight:400;box-shadow:var(--dsw-shadow-lv3);opacity:0;pointer-events:none;transition:opacity .12s;z-index:10;white-space:normal}
.dscs-tip:hover::after{opacity:1}
.dscs-preset{height:24px;border-radius:12px;padding:0 10px;font-size:11px}
.dscs-version-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dscs-mono{font-family:var(--dsw-font-markdown-code-block,monospace);font-size:12px}
.dscs-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000}
.dscs-dialog{width:min(440px,calc(100vw - 32px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
.dscs-dialog-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:24px}
.dscs-dialog-body{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dscs-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dscs-out{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto;border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;padding:8px;margin:0}
`

const InfoIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
)

/* ================= komponen utama ================= */

function CustomSettingsSection(props: { scope: ScopeLike }): ReactElement {
  const { scope } = props
  // WAJIB bungkus arrow: method SettingsScopeController pakai `this.store` —
  // referensi mentah (scope.getSnapshot) melepas `this` → TypeError
  // "Cannot read properties of undefined (reading 'store')" (kejadian nyata).
  const snapshot = useSyncExternalStore(
    (cb) => scope.subscribe(cb),
    () => scope.getSnapshot(),
  )

  const [tunables, setTunables] = useState<Tunable[] | null>(null)
  const [tunablesError, setTunablesError] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({})
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [version, setVersion] = useState<VersionResponse | null>(null)
  const [versionBusy, setVersionBusy] = useState(false)
  const [versionError, setVersionError] = useState(false)
  const [confirmUpgrade, setConfirmUpgrade] = useState(false)
  const [upgradeState, setUpgradeState] = useState<'idle' | 'running' | 'restarting' | 'error'>('idle')
  const [upgradeError, setUpgradeError] = useState<string | null>(null)

  /* ---- load deskriptor tunable sekali ---- */
  useEffect(() => {
    let alive = true
    fetch(`${API}/tunables`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: Tunable[]) => {
        if (!alive) return
        setTunables(data)
        const init: Record<string, string> = {}
        for (const t of data) init[t.id] = String(t.default)
        setDrafts((prev) => ({ ...init, ...prev }))
      })
      .catch(() => { if (alive) setTunablesError(true) })
    return () => { alive = false }
  }, [])

  /* ---- refresh status (applied + installedVersion + marker restart) ---- */
  const refreshStatus = (): void => {
    fetch(`${API}/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: StatusResponse | null) => { if (data) setStatus(data) })
      .catch(() => { /* koneksi putus saat restart — wajar */ })
  }
  useEffect(() => {
    refreshStatus()
    const timer = window.setInterval(refreshStatus, STATUS_POLL_MS)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---- poll restart gagal saat upgradeState === 'restarting' ---- */
  useEffect(() => {
    if (upgradeState !== 'restarting') return
    if (status?.lastRestartFailed) {
      setUpgradeState('error')
      setUpgradeError('npm install selesai, tapi restart dsh gagal. Jalankan manual: sudo systemctl restart dsh')
    }
  }, [status, upgradeState])

  /* ---- nilai resolved namespace (fallback ke default deskriptor) ---- */
  const resolvedValue = snapshot.value ?? {}
  const draftOf = (t: Tunable): string => {
    const v = drafts[t.id]
    if (v !== undefined) return v
    const n = resolvedValue[t.id]
    return n !== undefined ? String(n) : String(t.default)
  }

  const saveTunable = async (t: Tunable): Promise<void> => {
    const raw = Number(draftOf(t))
    const value = Number.isFinite(raw)
      ? Math.min(t.max, Math.max(t.min, Math.round(raw)))
      : t.default
    setDrafts((prev) => ({ ...prev, [t.id]: String(value) }))
    setSaveState((prev) => ({ ...prev, [t.id]: 'saving' }))
    try {
      await scope.set(t.id, value)
      setSaveState((prev) => ({ ...prev, [t.id]: 'saved' }))
      refreshStatus()
      window.setTimeout(() => {
        setSaveState((prev) => (prev[t.id] === 'saved' ? { ...prev, [t.id]: 'idle' } : prev))
      }, 2500)
    } catch {
      setSaveState((prev) => ({ ...prev, [t.id]: 'error' }))
    }
  }

  const resetTunable = async (t: Tunable): Promise<void> => {
    setDrafts((prev) => ({ ...prev, [t.id]: String(t.default) }))
    setSaveState((prev) => ({ ...prev, [t.id]: 'saving' }))
    try {
      await scope.unset(t.id)
      setSaveState((prev) => ({ ...prev, [t.id]: 'saved' }))
      refreshStatus()
    } catch {
      setSaveState((prev) => ({ ...prev, [t.id]: 'error' }))
    }
  }

  /* ---- cek versi terbaru ---- */
  const checkVersion = (): void => {
    setVersionBusy(true)
    setVersionError(false)
    fetch(`${API}/version`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: VersionResponse) => { setVersion(data) })
      .catch(() => setVersionError(true))
      .finally(() => setVersionBusy(false))
  }

  /* ---- upgrade ---- */
  const runUpgrade = async (): Promise<void> => {
    setConfirmUpgrade(false)
    setUpgradeState('running')
    setUpgradeError(null)
    try {
      const res = await fetch(`${API}/upgrade`, { method: 'POST' })
      const body = (await res.json()) as UpgradeResponse
      if (!res.ok) {
        const reason = body.reason === 'upgrade-in-progress' ? 'Upgrade sedang berjalan.'
          : body.reason === 'already-up-to-date' ? 'Versi sudah terbaru.'
          : body.reason === 'registry-unreachable' ? 'Registry npm tidak terjangkau.'
          : body.reason === 'npm-not-found' ? 'npm CLI tidak ditemukan.'
          : 'Upgrade ditolak.'
        setUpgradeState('error')
        setUpgradeError(reason)
        return
      }
      if (body.ok) {
        setUpgradeState('restarting')
      } else {
        setUpgradeState('error')
        setUpgradeError(
          body.reason === 'npm-install-failed'
            ? `npm install gagal.${body.outputTail ? `\n${body.outputTail}` : ''}`
            : 'Upgrade gagal.',
        )
      }
    } catch {
      setUpgradeState('error')
      setUpgradeError('Gagal menghubungi host.')
    }
  }

  const upgradeBlocked = version !== null && version.ok === true && version.upToDate === true

  return (
    <div className="dscs-root">
      <p className="dscs-intro">
        Setting kustom dsh: nilai tersimpan permanen di ~/.dsh/settings.yaml dan diterapkan
        saat boot; tunable bertanda "berlaku langsung" ikut diterapkan saat diubah — tanpa restart.
      </p>

      {tunablesError && <p className="dscs-error">Gagal memuat daftar setting dari host.</p>}
      {snapshot.status === 'unavailable' && (
        <p className="dscs-error">Host half plugin tidak tersedia — muat ulang halaman atau periksa log dsh.</p>
      )}

      {(tunables ?? []).map((t) => {
        const appliedNow = status?.applied?.[t.id]
        const isLive = t.restart !== true
        const isApplied = appliedNow !== undefined && appliedNow === Number(draftOf(t)) && saveState[t.id] !== 'saving'
        return (
          <div key={t.id} className="dscs-card">
            <h3 className="dscs-card-title">
              {t.label}
              <span className="dscs-tip" data-tip={t.tooltip}><InfoIcon /></span>
            </h3>
            <p className="dscs-desc">{t.description}</p>
            <div className="dscs-field-row">
              <input
                className="dscs-input"
                type="number"
                min={t.min}
                max={t.max}
                step={1}
                value={draftOf(t)}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                aria-label={t.label}
              />
              {t.unit && <span className="dscs-unit">{t.unit}</span>}
              {(t.presets ?? []).map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="dscs-btn dscs-preset"
                  onClick={() => { setDrafts((prev) => ({ ...prev, [t.id]: String(p.value) })) }}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                className="dscs-btn dscs-btn-primary"
                disabled={saveState[t.id] === 'saving'}
                onClick={() => void saveTunable(t)}
              >
                {saveState[t.id] === 'saving' ? 'Menyimpan…' : saveState[t.id] === 'saved' ? '✓ Tersimpan' : 'Simpan'}
              </button>
              <button
                type="button"
                className="dscs-btn"
                disabled={saveState[t.id] === 'saving'}
                onClick={() => void resetTunable(t)}
              >
                Reset
              </button>
            </div>
            <div className="dscs-field-row">
              {isLive ? (
                <span className="dscs-badge dscs-badge-live">✓ Berlaku langsung — tanpa restart</span>
              ) : (
                <span className="dscs-badge">Perlu restart dsh</span>
              )}
              {isApplied ? (
                <span className="dscs-badge dscs-badge-live">✓ Aktif: {fmtMs(appliedNow as number)}</span>
              ) : appliedNow !== undefined ? (
                <span className="dscs-hint">Berjalan: {fmtMs(appliedNow)} · draft: {fmtMs(Number(draftOf(t)))}</span>
              ) : t.consumer === 'browser' ? (
                <span className="dscs-hint">Dipakai browser half (strip Git State) — nilai baru aktif di tiap tab pada siklus refresh berikutnya.</span>
              ) : (
                <span className="dscs-hint">codeRuntime tidak tersedia — belum diterapkan.</span>
              )}
              {saveState[t.id] === 'error' && <p className="dscs-error">Gagal menyimpan.</p>}
            </div>
          </div>
        )
      })}

      <div className="dscs-card">
        <h3 className="dscs-card-title">Versi dsh</h3>
        <p className="dscs-desc">
          Versi terpasang dibaca lokal; versi terbaru diambil dari registry npm (@deepseek-ai/dsh, dist-tag latest).
        </p>
        <div className="dscs-version-row">
          <span className="dscs-hint">Terpasang:</span>
          <span className="dscs-mono">{status?.installedVersion ?? '…'}</span>
          <button type="button" className="dscs-btn" disabled={versionBusy} onClick={checkVersion}>
            {versionBusy ? 'Memeriksa…' : 'Cek versi terbaru'}
          </button>
        </div>
        {versionError && <p className="dscs-error">Registry npm tidak terjangkau — coba lagi nanti.</p>}
        {version !== null && version.ok === false && (
          <p className="dscs-error">
            {version.reason === 'registry-unreachable' ? 'Registry npm tidak terjangkau — coba lagi nanti.' : 'Gagal memeriksa versi.'}
          </p>
        )}
        {version !== null && version.ok === true && (
          <div className="dscs-version-row">
            <span className="dscs-hint">Terbaru (npm):</span>
            <span className="dscs-mono">{version.latest ?? '?'}</span>
            {version.upToDate === true ? (
              <span className="dscs-badge dscs-badge-live">✓ Sudah terbaru</span>
            ) : (
              <>
                <span className="dscs-badge">Ada versi baru</span>
                <a
                  className="dscs-btn"
                  href="https://www.npmjs.com/package/@deepseek-ai/dsh"
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
                >
                  Halaman npm
                </a>
                <button
                  type="button"
                  className="dscs-btn dscs-btn-primary"
                  disabled={upgradeState === 'running' || upgradeState === 'restarting'}
                  onClick={() => setConfirmUpgrade(true)}
                >
                  {upgradeState === 'running' ? 'Mengunduh & memasang…' : upgradeState === 'restarting' ? 'Menunggu restart…' : 'Upgrade'}
                </button>
              </>
            )}
          </div>
        )}
        {upgradeBlocked && (
          <p className="dscs-hint">
            {status?.installedVersion && version?.latest ? `Versi terpasang (${status.installedVersion}) sama dengan terbaru (${version.latest}).` : ''}
          </p>
        )}
        {upgradeState === 'restarting' && (
          <p className="dscs-hint">npm install selesai — dsh akan restart otomatis dalam beberapa detik. Halaman akan terhubung kembali.</p>
        )}
        {upgradeState === 'error' && upgradeError && <p className="dscs-error">{upgradeError}</p>}
      </div>

      {confirmUpgrade && (
        <div className="dscs-overlay" role="presentation" onClick={() => setConfirmUpgrade(false)}>
          <div
            className="dscs-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => { e.stopPropagation() }}
          >
            <div className="dscs-dialog-title">Upgrade dsh?</div>
            <div className="dscs-dialog-body">
              {version?.installed !== null && version?.installed !== undefined && version?.latest ? (
                <>Versi {version.installed} → {version.latest}. npm install -g dijalankan, lalu dsh restart otomatis. Browser akan terputus sesaat (halaman reconnect sendiri). Sesi agen aman (persist).</>
              ) : (
                <>npm install -g @deepseek-ai/dsh@latest dijalankan, lalu dsh restart otomatis. Browser akan terputus sesaat.</>
              )}
            </div>
            <div className="dscs-dialog-actions">
              <button type="button" className="dscs-btn" onClick={() => setConfirmUpgrade(false)}>Batal</button>
              <button type="button" className="dscs-btn dscs-btn-danger" onClick={() => void runUpgrade()}>Upgrade</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- registrasi ---------- */
export function apply(ctx: Context): void {
  const settingsScope = (ctx as unknown as { settingsScope?: SettingsScopeFace }).settingsScope
  const slots = (ctx as unknown as {
    slots: {
      inject(slotName: string, callback: () => void): void
      register(spec: unknown, component: unknown): void
    }
  }).slots
  if (!settingsScope || !slots) return // degradasi halus: tanpa tab

  // Stylesheet scoped + disposable (pola dsh-file-explorer/dsh-session-archive).
  ctx.effect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-dsh-custom-settings', '')
    el.textContent = CSS
    document.head.appendChild(el)
    return () => { el.remove() }
  })

  const scope = settingsScope.bind({ namespace: 'custom-settings' })

  // WAJIB lewat slots.inject (anti-race deklarasi slot); slot list wajib options.id.
  // Catatan: `slots` di sini SUDAH ctx.slots (di-destructure di atas) — jangan
  // salin pola session-archive yang `slots`-nya = ctx utuh (slots.slots.inject).
  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: 'custom-settings',
      order: 26, // paling akhir: general=0, models=10, plugins=15, agent-presets=20, archived-sessions=25
      label: () => 'Custom Settings',
      inject: () => ({ scope }),
    },
    CustomSettingsSection,
  ))
}
