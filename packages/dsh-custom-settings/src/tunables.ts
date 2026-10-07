/**
 * dsh-custom-settings — registri tunable.
 *
 * SUMBER TUNGGAL daftar setting kustom. Menambah setting baru = tambah SATU
 * entri di TUNABLES + rebuild (host half saja). Browser half render form
 * otomatis dari GET /api/tunables — client tidak perlu disentuh.
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Batas atas setTimeout Node (2^31-1 ms — lebih besar dibulatkan ke 1 ms).
 * Sama dengan MAX_TIMER_DELAY_MS dari @deepseek-ai/dsh-timeout yang dipakai
 * dsh-code-runtime-worker-thread; sengaja di-hardcode + dikomentari supaya
 * tidak bergantung versi paket yang berbeda di registry (instalasi lokal
 * 0.1.0-rc.7 vs dist-tag npm 0.0.1-rc.1 — mismatch).
 */
export const MAX_TIMER_DELAY_MS = 2147483647

export interface TunablePreset {
  label: string
  value: number
}

export interface Tunable {
  /** Key field di namespace settings `custom-settings` (kebab/lowercase safe). */
  id: string
  /** Key di object config service target (default = id). */
  configKey?: string
  /** Label pendek di UI. */
  label: string
  /** Deskripsi inline (satu-dua kalimat, bahasa Indonesia). */
  description: string
  /** Tooltip lengkap saat hover ikon info. */
  tooltip: string
  min: number
  max: number
  default: number
  /** Satuan tampilan input. */
  unit?: string
  /** Preset cepat (nilai dalam ms). */
  presets?: TunablePreset[]
  /** true = butuh restart dsh; false (default) = berlaku live tanpa restart. */
  restart?: boolean
  /**
   * Siapa konsumen nilai: 'host' (default) = proses dsh; 'browser' = client
   * half plugin lain yang mem-bind namespace ini sendiri (apply host no-op).
   */
  consumer?: 'host' | 'browser'
  /** Baca nilai ter-apply utk GET /api/status. Default: ptcRuntime.config[configKey ?? id]. */
  readApplied?(ctx: Context): number | undefined
  /** Terapkan nilai ke runtime. Dipanggil saat boot & setiap nilai berubah. */
  apply(ctx: Context, value: number): void
}

/** Face service ptcRuntime (loose — kebenaran runtime ada di dsh). */
interface CodeRuntimeLike {
  config?: Record<string, unknown>
}

/**
 * Objek bersama LINTAS PLUGIN untuk tunable yang konsumennya plugin lain
 * (saat ini: host half dsh-git-state). Custom-settings mem-provide objek ini
 * sebagai service cordis 'customSettingsApplied'; plugin konsumen membacanya
 * LAZY per-request via ctx.get (urutan boot dua arah aman; perubahan nilai
 * live karena apply() memutasi objek IN-PLACE — referensi tidak diganti).
 * Diverifikasi langsung di @deepseek-ai/cordis terpasang (micro-test:
 * provide/get dua urutan boot + mutasi in-place terbaca).
 */
export interface CustomSettingsApplied {
  gitState?: { cmdTimeoutMs?: number }
}

function sharedApplied(ctx: Context): CustomSettingsApplied | undefined {
  return (ctx as unknown as { get<T>(key: string): T | undefined })
    .get<CustomSettingsApplied>('customSettingsApplied')
}

export const TUNABLES: Tunable[] = [
  {
    id: 'runCodeMaxWallMs',
    configKey: 'maxTimeoutMs',
    label: 'Batas waktu run_code (maxTimeoutMs)',
    description: 'Berapa lama satu eksekusi run_code boleh berjalan sebelum dihentikan.',
    tooltip:
      'Batas maksimum timeout yang dapat diminta eksekusi PTC. Berlaku untuk panggilan berikutnya. Timeout default runtime tetap mengikuti pengaturan bawaan DSH.',
    min: 1,
    max: MAX_TIMER_DELAY_MS,
    default: 3_600_000,
    unit: 'ms',
    presets: [
      { label: '10 menit', value: 600_000 },
      { label: '1 jam', value: 3_600_000 },
      { label: '6 jam', value: 21_600_000 },
    ],
    restart: false,
    apply(ctx, value) {
      // cordis TIDAK membekukan config plugin (diverifikasi rc.7): mutasi
      // object config ini langsung dipakai run berikutnya
      // (setTimeout(..., this.config.maxTimeoutMs) di setiap run()).
      const runtime = (ctx as unknown as { get<T>(key: string): T | undefined })
        .get<CodeRuntimeLike>('ptcRuntime')
      if (runtime?.config) runtime.config.maxTimeoutMs = Math.round(value)    },
  },
  {
    // Konsumen: BROWSER half dsh-git-state (bind namespace 'custom-settings'
    // sendiri via configForms.get + subscribe). Tidak ada state host yang
    // perlu dimutasi — apply sengaja no-op; persistensi & form tetap di sini.
    id: 'gitStatePollMs',
    label: 'Interval auto-refresh Git State',
    description: 'Jeda antar pembaruan otomatis strip status git di atas composer.',
    tooltip:
      'Dipakai browser half dsh-git-state (poll /plugins/dsh-git-state/api/state). Makin kecil = status makin fresh, tapi beban host naik (tiap tab × tiap workspace) — minimum dibatasi 10 detik (pelajaran insiden beban 16 Aug 2026). Berlaku live tanpa restart: tiap tab memakai nilai baru pada siklus refresh berikutnya.',
    min: 10_000,
    max: 86_400_000,
    default: 30_000,
    unit: 'ms',
    presets: [
      { label: '30 dtk', value: 30_000 },
      { label: '1 mnt', value: 60_000 },
      { label: '5 mnt', value: 300_000 },
      { label: '15 mnt', value: 900_000 },
      { label: '30 mnt', value: 1_800_000 },
      { label: '1 jam', value: 3_600_000 },
      { label: '3 jam', value: 10_800_000 },
      { label: '6 jam', value: 21_600_000 },
      { label: '12 jam', value: 43_200_000 },
      { label: '1 hari', value: 86_400_000 },
    ],
    restart: false,
    consumer: 'browser',
    apply() { /* no-op: konsumennya browser half plugin lain */ },
    // Nilai ter-apply = resolved namespace (sudah terisi default via schema);
    // dibaca dari provider settings supaya GET /api/status menampilkannya dan
    // badge "Aktif" di tab Custom Settings berfungsi (ditambahkan 25 Aug 2026).
    readApplied(ctx) {
      const settings = (ctx as unknown as { get<T>(key: string): T | undefined })
        .get<{ describe(): Array<{ ns: string; value: Record<string, number> }> }>('settings')
      return settings?.describe().find((row) => row.ns === 'custom-settings')?.value?.gitStatePollMs
    },
  },
  {
    // Konsumen: HOST half dsh-git-state — baca lazy per-request dari objek
    // bersama 'customSettingsApplied' (lihat helper sharedApplied di atas).
    id: 'gitStateCmdTimeoutMs',
    label: 'Timeout perintah git (Git State)',
    description: 'Batas waktu satu perintah git read-only di host sebelum dianggap gagal.',
    tooltip:
      'Dipakai host half dsh-git-state saat mengumpulkan /api/state (rev-parse, status, stash list, worktree list, gh pr list). Naikkan bila ada repo/worktree besar yang statusnya lambat; turunkan untuk gagal cepat. Berlaku live untuk request berikutnya, tanpa restart.',
    // Max SENGAJA disamakan preset terbesar (1 hari) supaya semua tombol
    // preset benar-benar bisa diset — tanpa ini nilai >60 dtk ter-clamp
    // diam-diam saat disimpan.
    min: 1_000,
    max: 86_400_000,
    default: 6_000,
    unit: 'ms',
    presets: [
      { label: '30 dtk', value: 30_000 },
      { label: '1 mnt', value: 60_000 },
      { label: '5 mnt', value: 300_000 },
      { label: '15 mnt', value: 900_000 },
      { label: '30 mnt', value: 1_800_000 },
      { label: '1 jam', value: 3_600_000 },
      { label: '3 jam', value: 10_800_000 },
      { label: '6 jam', value: 21_600_000 },
      { label: '12 jam', value: 43_200_000 },
      { label: '1 hari', value: 86_400_000 },
    ],
    restart: false,
    apply(ctx, value) {
      const shared = sharedApplied(ctx)
      if (shared?.gitState) shared.gitState.cmdTimeoutMs = Math.round(value)
    },
    readApplied(ctx) {
      // Sumber otoritatif = resolved namespace (bukan objek bersama): nilai
      // di sini tidak bergantung urutan apply boot (pelajaran 25 Aug 2026 —
      // status menampilkan 6000 setelah restart padahal dokumen berisi 300000).
      const settings = (ctx as unknown as { get<T>(key: string): T | undefined })
        .get<{ describe(): Array<{ ns: string; value: Record<string, number> }> }>('settings')
      return settings?.describe().find((row) => row.ns === 'custom-settings')?.value?.gitStateCmdTimeoutMs
    },
  },
]
