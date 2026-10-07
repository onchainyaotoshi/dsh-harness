/**
 * dsh-session-archive - host half.
 * Subclass WorkspaceRegistry yang memakai `unarchiveSession` bawaan DSH 0.2
 * + satu route HTTP untuk halaman arsip kustom:
 *   POST /plugins/dsh-session-archive/api/unarchive  { sessionId } →
 *     200 { archivedSessionIds } | 400 invalid-body/json | 413 body-too-large | 500
 *
 * Derivatif ringan dari MichengAI/dsh-archive-manager (Apache-2.0) — cakupan
 * v1: unarchive + halaman kelola. TANPA delete permanen (prinsip append-only).
 *
 * Archive sendiri = bawaan dsh (row menu → RPC workspace.archiveSession);
 * sesi terarsip disembunyikan otomatis oleh UI grouping. State arsip = field
 * global `archivedSessionIds` domain workspace (~/.dsh/storages/workspace.json);
 * unarchive TIDAK menyentuh tabel workspaces — sesi terarsip mempertahankan
 * slot sessionIds sehingga unarchive mengembalikan posisinya.
 */
import { Service } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

const API_PREFIX = '/plugins/dsh-session-archive/api'
const BODY_MAX_BYTES = 4 * 1024
const SESSION_ID_MAX = 200

export default class SessionArchiveWorkspaceRegistry extends WorkspaceRegistry {
  // Wajib restate inject parent (static field di-shadow, bukan merge) + webServer.
  static inject = ['storageDomain', 'sessionPersistence', 'webServer']

  async [Service.init](): Promise<void> {
    await super[Service.init]()
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: API_PREFIX + '/unarchive',
      handler: (req, res) => { void this.handleUnarchive(req, res) },
    }))
  }

  private async handleUnarchive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody(req)
      const raw = (body as { sessionId?: unknown } | null)?.sessionId
      if (typeof raw !== 'string' || raw === '' || raw.length > SESSION_ID_MAX) {
        sendJson(res, 400, { error: 'invalid-body' })
        return
      }
      await this.unarchiveSession(raw)
      // setState → domain/changed → frame host/archived-sessions-changed → UI
      // semua tab ter-update otomatis (rantai terverifikasi rc.6).
      sendJson(res, 200, { archivedSessionIds: [...this.archivedSessionIds] })
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      if (code === 'body-too-large') sendJson(res, 413, { error: 'body-too-large' })
      else if (code === 'invalid-json') sendJson(res, 400, { error: 'invalid-json' })
      else sendJson(res, 500, { error: 'internal-error' })
    }
  }
}

/* ---------- util HTTP ---------- */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}
