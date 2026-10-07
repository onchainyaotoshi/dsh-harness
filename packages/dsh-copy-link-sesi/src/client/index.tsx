/**
 * dsh-copy-link-sesi — browser half.
 *
 * Deep-link: kalau URL halaman memuat `?session=<sessionId>` (link hasil menu
 * "Salin link" di baris sesi), buka sesi itu begitu terdaftar di daftar sesi,
 * lalu bersihkan parameter dari URL (one-shot — reload tidak melompat balik
 * ke sesi lama). Sesi yang tidak dikenal (link basi) diabaikan setelah batas
 * waktu. DSH 0.2 menyediakan slot menu resmi dan uiWorkspace.openSession.
 */
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'copy-link-sesi'
export const inject = ['sessions', 'uiWorkspace', 'slots']

const PARAM = 'session'
const GIVE_UP_MS = 15_000

interface SessionsFace {
  list: {
    subscribe(cb: () => void): () => void
    getSnapshot(): { ids?: readonly string[] }
  }
}

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: { inject(name: string, cb: () => void): void; register(spec: unknown, component: unknown): void } }).slots
  slots.inject('sidebar.workspaces.session.menu.item', () => slots.register(
    { name: 'sidebar.workspaces.session.menu.item', id: 'copy-session-link', order: 500 },
    ({ sessionId, useMenuOpenState }: { sessionId: string; useMenuOpenState(): [boolean, (open: boolean) => void] }) => {
      const [, setOpen] = useMenuOpenState()
      return <MenuItemButton onSelect={() => {
        const url = new URL(window.location.href)
        url.search = ''
        url.searchParams.set('session', sessionId)
        void navigator.clipboard.writeText(url.href).then(() => setOpen(false)).catch((error) => ctx.logger.warn(String(error)))
      }}>Salin link</MenuItemButton>
    },
  ))
  const sessions = (ctx as unknown as { sessions?: SessionsFace }).sessions
  const navigation = (ctx as unknown as { uiWorkspace: { openSession(id: string): void } }).uiWorkspace
  if (!sessions) return
  const target = new URLSearchParams(window.location.search).get(PARAM)
  if (!target) return

  let done = false
  let timer: number | undefined
  let unsub: (() => void) | undefined

  const finish = (): void => {
    if (done) return
    done = true
    if (timer !== undefined) window.clearTimeout(timer)
    unsub?.()
    const url = new URL(window.location.href)
    if (url.searchParams.get(PARAM) !== null) {
      url.searchParams.delete(PARAM)
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    }
  }

  const tryOpen = (): void => {
    if (done) return
    const snap = sessions.list.getSnapshot()
    const ids = snap.ids ?? []
    if (ids.includes(target)) {
      // Navigation synchronously publishes reference counts to this same list.
      // Detach first to prevent recursive openSession calls.
      finish()
      navigation.openSession(target)
    }
  }

  unsub = sessions.list.subscribe(tryOpen)
  timer = window.setTimeout(finish, GIVE_UP_MS)
  ctx.effect(() => () => { if (timer !== undefined) window.clearTimeout(timer); unsub?.() })
  tryOpen() // list sudah siap (baseline cepat) → langsung tanpa nunggu event
}
