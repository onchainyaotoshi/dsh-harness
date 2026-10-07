/**
 * dsh-patches — host half.
 *
 * SATU tempat untuk semua workaround tanpa seam DeepSeek Harness:
 *
 * 1. Boot auto-repair untuk SEMUA patch deploy (lihat scripts/patch-core.mjs
 *    untuk daftar & logikanya — sumber tunggal). Kalau patch hilang karena
 *    dsh di-upgrade, dipasang ulang otomatis; kalau anchor tidak cocok,
 *    warn loud — boot TIDAK pernah gagal karena hal ini.
 * 2. Reminder "argumen required" untuk Code Mode (seam fix, BUKAN file patch):
 *    tools:sdk hanya bilang "Tool arguments must be lossless JSON" — model
 *    DeepSeek-V4 sering melupakan field required (terutama bash `description`)
 *    sehingga program ditolak "invalid arguments: missing required property".
 *
 * Kenapa plugin, bukan script systemd / pnpm patch: setiap `npm update dsh`
 * menimpa node_modules, dan mekanisme lama (ExecStartPre + pnpm patch)
 * tersebar di luar repo — di sini semuanya ter-versioning dan ter-reapply
 * otomatis. Patch yang TIDAK punya seam tetap butuh patch file (kondisi ini
 * tercatat per patch di CLAUDE.md); yang SUDAH punya seam (seperti reminder
 * ini) memakai API publik dan tidak menyentuh node_modules sama sekali.
 */
import { Service } from '@deepseek-ai/cordis'
import { readFileSync, writeFileSync } from 'node:fs'
import { PATCHES, STATUS, inspectPatch } from '../scripts/patch-core.mjs'

const CODE_ARGS_REMINDER = `## Required arguments in run_code programs

Every tool call inside a run_code program must pass ALL required arguments from
its current declared schema. A missing required property rejects the call.
Check required fields and their types before emitting the program; do not infer
argument names from another tool or an earlier version of the harness.`

export default class PatchesHost extends Service {
  static inject = []
  /**
   * Nama service WAJIB di-set: tanpa `provide`, cordis memakai nama `undefined`
   * dan plugin kedua yang `extends Service` tanpa `provide` (di sini:
   * dsh-copy-link-sesi) saling menabrak → boot GAGAL dengan
   * service "undefined" has been registered at <SessionLinkHost>
   * (insiden 27 Aug 2026). Jangan hapus tanpa mengganti nama unik lain.
   */
  static provide = 'dsh.patches.host'

  async [Service.init](): Promise<void> {
    // Tunda ke microtask: auto-repair tidak boleh memperlambat boot.
    queueMicrotask(() => this.repairAll())
    this.registerCodeArgsReminder()
  }

  /** Pasang ulang semua patch yang hilang; warn (bukan throw) saat anchor berubah. */
  private repairAll(): void {
    const baseUrl = (this.ctx as { baseUrl?: unknown }).baseUrl
    if (typeof baseUrl !== 'string') {
      this.ctx.logger?.warn?.(`[dsh-patches] ctx.baseUrl tidak tersedia — auto-repair dilewati`)
      return
    }
    for (const patch of PATCHES) {
      try {
        this.repairOne(patch, baseUrl)
      } catch (error) {
        this.ctx.logger?.warn?.(`[dsh-patches] auto-repair "${patch.id}" gagal: ${String(error)}`)
      }
    }
  }

  private repairOne(patch: { id: string }, baseUrl: string): void {
    const inspection = inspectPatch(patch, baseUrl, readFileSync)
    if (!inspection.exists) {
      this.ctx.logger?.warn?.(
        `[dsh-patches] "${patch.id}" tidak ditemukan: ${inspection.path ?? '(resolve gagal)'} — periksa versi dsh / profil`
      )
      return
    }
    if (inspection.status === STATUS.ANCHOR_MISSING) {
      this.ctx.logger?.warn?.(
        `[dsh-patches] "${patch.id}" hilang DAN anchor tidak cocok: ${inspection.path} — versi dsh mengubah file? Periksa scripts/patch-core.mjs lalu jalankan scripts/apply-patch.mjs`
      )
      return
    }
    if (inspection.status === STATUS.INSTALLED) return
    // STATUS.APPLIED — hasil transformasi berbeda dari isi file.
    writeFileSync(inspection.path, inspection.source)
    this.ctx.logger?.info?.(`[dsh-patches] "${patch.id}" terpasang (ulang): ${inspection.path}`)
  }

  /**
   * Reminder untuk Code Mode: satu prompt section global (order 151, tepat
   * setelah tools:sdk di 150). Kosong di presentasi native sehingga tidak
   * menambah token yang tidak perlu. Dipakai saat assembly (bukan saat boot),
   * jadi service `tools` yang mungkin belum hidup saat init tetap terbaca.
   */
  private registerCodeArgsReminder(): void {
    const ctx = this.ctx
    ctx.inject?.(['systemPrompt'], (systemPromptCtx) => {
      try {
        systemPromptCtx.systemPrompt.section({
          name: 'tool:code-required-args',
          order: 151,
          text: (context: { scope?: unknown }) => {
            try {
              const tools = ctx.get?.('tools') as { modeFor?: (scope: unknown) => string } | undefined
              const mode = tools?.modeFor?.(context?.scope)
              if (mode !== 'ptc' && mode !== 'both') return ''
            } catch {
              return ''
            }
            return CODE_ARGS_REMINDER
          },
        })
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-patches] registrasi reminder Code Mode gagal: ${String(error)}`)
      }
    })
  }
}
