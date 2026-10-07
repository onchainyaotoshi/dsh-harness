# dsh-session-archive — catatan untuk agent

Plugin arsip sesi untuk Web UI DeepSeek Harness: halaman Settings "Archived
Sessions" + unarchive (dengan dialog konfirmasi). **Baca ini sebelum ngoding
di paket ini.** Dokumentasi user-facing ada di `README.md`.

## Apa ini

- **Archive itu bawaan dsh** (row menu sesi → RPC `workspace.archiveSession`);
  sesi terarsip disembunyikan otomatis oleh UI grouping. Paket ini TIDAK
  membangun aksi archive.
- Yang dibangun: (1) host half = subclass `WorkspaceRegistry` yang menambah
  `unarchiveSession` (seam resmi TIDAK punya unarchive) + route
  `POST /plugins/dsh-session-archive/api/unarchive`; (2) browser half = section
  `settings.section` id `archived-sessions` order 25 (PALING AKHIR — setelah
  Agent presets) berisi daftar per workspace + tombol Unarchive + dialog
  konfirmasi.
- **Cakupan v1 sengaja**: unarchive + kelola, TANPA delete permanen (prinsip
  append-only dsh). Derivatif ringan dari MichengAI/dsh-archive-manager
  (Apache-2.0) — tanpa fork WorkspaceBrowser, tanpa bedah delete.

## Arsitektur & seam

```
src/index.ts          # host half: default export class SessionArchiveWorkspaceRegistry
                      #   extends WorkspaceRegistry (@deepseek-ai/dsh-workspace)
src/client/index.tsx  # browser half: slot settings.section → ArchivedSessionsSection
cordis.patch.yml      # PENGECUALIAN konvensi: - {id: workspace, disabled: true}
                      #   + - insert: [{id: session-archive, name: dsh-session-archive}]
```

- **Host**: parent `WorkspaceRegistry` mendaftar service `workspaceRegistry`
  (constructor `super(ctx, "workspaceRegistry")`) — disable row default
  `workspace` + insert row kita = penggantian bersih; RPC archive bawaan tetap
  jalan (method diwarisi). `static inject` parent `["storageDomain",
  "sessionPersistence"]` WAJIB di-restate (shadow, bukan merge) + `webServer`.
  `[Service.init]` override: `await super[Service.init]()` dulu, baru register
  route (state registry sudah siap). Member `requireState/setState/
  enqueueOperation` adalah `private` di .d.ts → cast `RegistryInternals`
  (runtime-nya metode biasa; pola komunitas). `unarchiveSession` idempoten:
  cermin `archiveSession` parent — hanya menulis field global
  `archivedSessionIds` (domain workspace, `~/.dsh/storages/workspace.json`);
  tabel `workspaces` TIDAK disentuh (slot `sessionIds` dipertahankan →
  unarchive mengembalikan posisi). Rantai update UI:
  `setState` → `domain/changed` → apiproxy → frame
  `host/archived-sessions-changed` → `ctx.workspaces.list` store otomatis.
- **Browser**: slot `settings.section` (kind `list`, scope `root`, owner
  `{close}`; opsi `id`/`order`/`label` thunk/`inject`). Registrasi WAJIB lewat
  `slots.inject` (anti-race). Data dari `ctx.workspaces.list`
  (`archivedSessionIds` + `items[].sessionIds`) + `ctx.sessions.list`
  (`byId` TIDAK difilter arsip → judul tetap terbaca). Unarchive via fetch
  route host; sukses = store ter-update otomatis + fallback `workspaces.refresh()`
  bila set tak berubah (no-op idempoten). Dialog konfirmasi = keputusan user
  (reversibel, tapi user minta dialog).
- Versi dsh target: 0.1.0-rc.6 (seam diverifikasi 17 Aug 2026).

## Lesson learned (jangan diulang)

- **`dsh plugin add` butuh pnpm di PATH**: shell non-interaktif agent tidak
  memuat `~/.nvm/versions/node/v24.15.0/bin` (tempat `pnpm` berada) → error
  "pnpm not found on PATH — install pnpm to manage profile plugins". Fix:
  `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"` dulu.
- **Checkpoint dump-config SEBELUM restart wajib**: row `- id: workspace`
  harus `disabled: true` dan row `session-archive` aktif tanpa disabled. Tanpa
  disable → dua penyedia service `workspaceRegistry` → boot gagal KERAS
  "duplicate service" (kelihatan, tapi merusak sesi semua orang — jangan
  sampai). Verifikasi: `dsh --profile web --dump-config | grep -A3 'id: workspace'`.
- **Member parent `private` di .d.ts**: `requireState/setState/enqueueOperation`
  WorkspaceRegistry dinyatakan `private` di types — subclass TypeScript butuh
  cast tipe lokal (`RegistryInternals`); runtime-nya metode biasa (komunitas
  menulis JS sehingga lolos). `[Service.init]` justru `protected` — override
  sah; `static inject` parent wajib di-restate (shadow, bukan merge).
- **Unarchive idempoten + kode status tegas**: id tak dikenal → 200 tanpa
  menulis (retry-safe, beda dari komunitas yang melempar). Body salah → 400,
  >4KB → 413, error lain → 500. Route tidak ikut pagar `/api` (bukan
  privileged-method) — konsisten dengan plugin route lain monorepo.
- **UI ter-update lewat frame, bukan polling**: `setState` → `domain/changed`
  → apiproxy → frame `host/archived-sessions-changed` → `workspaces.list`
  store otomatis. Fallback `workspaces.refresh()` hanya bila respons
  `archivedSessionIds` masih memuat id (no-op idempoten). Terbukti E2E 17 Aug:
  unarchive dari Settings → baris hilang → sesi muncul kembali di tree.
- **Order section settings punya penghuni yang tak terduga**: order terpasang
  = general 0 · models 10 · plugins 15 · **agent-presets 20**
  (dsh-client-ui-agent-preset — section ini TIDAK muncul di daftar seam yang
  digrep awal karena label-nya dari locale, id-nya `agent-presets`). Cek
  `grep -B2 -A6 'name: "settings.section"'` di seluruh node_modules sebelum
  memilih order. Kami pakai 25 = paling akhir (permintaan pemilik).
- **Header Settings itu chrome global shell** (`settings.header`/
  `settings.action`/`settings.close` — dirender shell untuk SEMUA section,
  bukan milik section aktif): tombol "Open configuration file" muncul di
  setiap section termasuk punya kita — BUKAN bug plugin. Jangan coba
  sembunyikan dari sisi plugin.
- **Boot bisa mati karena store sesi korup di sisi LAIN** (insiden 27 Aug
  2026): init plugin ini (`list` → `sessionPersistence.list` →
  `assertStoredIdentity`) adalah canary paling awal untuk identitas sesi —
  jika `~/.dsh/sessions/<cwd>--` punya file yang header-nya tidak cocok lokasi
  fisik, crash-loop `corrupt session log` muncul lewat stack plugin ini.
  Diagnosa: `journalctl -u dsh -n 100` + cek `systemctl show dsh -p NRestarts`
  (loop tersembunyi jika hanya `activating`). Detail repair header zstd:
  deploy/CLAUDE.md.

## Verifikasi

```sh
# setelah install + restart dsh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/plugins/dsh-session-archive/client.js   # 200
curl -sS -X POST http://127.0.0.1:3080/plugins/dsh-session-archive/api/unarchive \
  -H 'Content-Type: application/json' -d '{"sessionId":"x"}'                                          # 200 idempoten
# UI: Settings → Archived Sessions (setelah Plugins); arsipkan sesi dari row
# menu sidebar → muncul di section → Unarchive (dialog) → kembali ke tree.
# Checkpoint WAJIB sebelum restart: dsh --profile web --dump-config → row
# `workspace` disabled:true + row `session-archive` aktif.
```

## Migrasi 7 Oct 2026 — DSH 0.2.0-rc.2

DSH 0.2 sudah menyediakan
`WorkspaceRegistry.unarchiveSession`; gunakan implementasi parent dan hapus
mutasi state private duplikat. Subclass/disable row workspace masih dipakai
untuk mempertahankan komposisi instalasi yang ada. Sisi browser memakai
`dsh-api-session-controller` dan `dsh-api-workspace-controller`.
Method `workspaces.list.getSnapshot` kini membaca receiver internal:
`useSyncExternalStore((cb) => list.subscribe(cb), () => list.getSnapshot())`
wajib, atau halaman arsip crash `refreshSnapshot` undefined.
