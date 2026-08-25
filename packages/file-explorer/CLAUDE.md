# dsh-file-explorer — catatan untuk agent

Panel tree file + viewer untuk Web UI DeepSeek Harness. **Baca ini sebelum
ngoding di paket ini.** Dokumentasi user-facing ada di `README.md`; file ini
berisi pengetahuan teknis & lesson learned KHUSUS paket ini (kalau paket
dipindah ke repo sendiri, file ini ikut).

## Arsitektur

```
src/index.ts          # host half (Node): route HTTP list/read/raw/workspaces
src/client/index.tsx  # browser half: seat details (kolom kanan) + conversation.session.header.utilities
cordis.patch.yml      # layer: - insert: [{ id: file-explorer, name: dsh-file-explorer }]
```

Satu row di `cordis.patch.yml` melayani host half DAN browser roster sekaligus.

### Host half — 4 route exact di `ctx.webServer` (`/plugins/dsh-file-explorer/api/*`)

| Route | Fungsi | Batas |
|---|---|---|
| `GET /workspaces` | daftar workspace terdaftar | — |
| `GET /list` | listing satu direktori | — |
| `GET /read` | isi satu file teks | 512 KiB (`MAX_READ_BYTES`) |
| `GET /raw` | preview biner (gambar) | 8 MiB (`MAX_RAW_BYTES`), Content-Type dari ekstensi (`MIME_BY_EXT`) |

### Security boundary — WAJIB, jangan dilemahkan

Semua akses file lewat `resolveInside()`: cek workspace terdaftar
(`ctx.workspaceRegistry`) lalu `ctx.fs.contains(root, target)` — di luar root
workspace = **403**. Client TIDAK pernah menggabung segmen path sendiri; host
menghitung path tiap entry di `/list`. Route ini **tidak** ikut pagar `/api`
(method PRIVILEGED), jadi containment ini satu-satunya pagar antara browser dan
filesystem host. UI yang meng-ekspos route ini wajib tetap di balik autentikasi
deployment. Boundary ini adalah WARISAN wajib untuk plugin lain yang menyentuh
filesystem.

## Seam dsh yang dipakai

`webServer` (register route exact), `fs` (resolve/contains/listDir/stat/
readText/readBytes), `workspaceRegistry`, `slots`, `layout`
(openDetails/closeDetails), `sessions.list`. Diverifikasi di dsh
0.1.0-rc.6 dan di-upgrade ulang ke 0.1.1-rc.1 (25 Aug 2026) — kalau dsh
di-upgrade lagi, cek ulang seam-nya dulu.

Tombol launcher ditaruh di slot `conversation.session.header.utilities`
(kind list, scope sesi) dengan `order: 1` — occupant bawaan
`session-log-download` (tombol "session log" kanan atas) pakai order default
0 dan render ascending, jadi tombol Files muncul di sebelah kanannya. Scope
sesi berarti tombol TIDAK muncul di layar hero (tanpa sesi) — diterima
pemilik saat pindah dari `sidebar.footer.action` (scope root).

## Lesson learned (jangan diulang)

- **Register slot UI WAJIB lewat `ctx.slots.inject(namaSlot, () => ctx.slots.register(...))`**
  — JANGAN register langsung di apply(). Register langsung = race dengan
  deklarasi slot oleh ui-layout/ui-sidebar → error "slot is not declared"
  (kejadian nyata 15 Aug 2026).
- **Slot ber-kind `list` WAJIB `options.id`** (identitas entry di ledger list)
  — tanpa id → error `list slot "..." requires options.id` (kejadian nyata
  15 Aug 2026).
- **UI plugin WAJIB token `--dsw-*` + pola shell** (pelajaran 15 Aug 2026):
  versi awal panel ini pakai warna hardcoded + emoji → kelihatan asing.
  Pakai CSS variables theme-aware (body / body[data-ds-dark-theme]; referensi
  nilai: `dsh-client-ui-theme/lib/styles/design-platform.css`): bg
  `--dsw-alias-bg-base/layer-1/2`, border `--dsw-alias-border-l1/l2`, teks
  `--dsw-alias-label-primary/secondary/tertiary`, hover
  `--dsw-alias-interactive-bg-hover`, font shorthand `--dsw-font-*`, kode
  `--dsw-font-markdown-code-block` + `--dsw-alias-markdown-code-block[-banner]`,
  shadow `--dsw-shadow-lv3`. Pola shell: row radius 8px + hover, icon-button
  28px (radius 8px; di header panel pakai 999px kayak close DetailsPanel
  bawaan), icon 16px feather-style SVG (currentColor). Hover/focus TIDAK bisa
  dinyatakan di inline style → inject satu `<style>` scoped lewat ctx.effect
  (return disposer hapus elemen). JANGAN emoji sebagai icon UI.
- **Workspace aktif sesi = `ctx.sessions.list`, tanpa endpoint baru**
  (pelajaran 15 Aug 2026): bentuk `SessionListState { ids, byId, current,
  phase }` dengan `byId[id].cwd` = path canonical; SnapshotStore kompatibel
  `useSyncExternalStore(list.subscribe, list.getSnapshot)`. Cocokkan cwd ke
  `workspace.path` (registri host) di sisi client → auto-select workspace
  aktif, override manual bertahan sampai sesi berganti. Kalau dsh di-upgrade,
  cek ulang bentuk SessionListState ini dulu.
- **Cwd sesi ≠ direktori kerja agent — worktree linked butuh sinyal workdir**
  (pelajaran 24 Aug 2026, kasus nyata sesi "bikin worktree" di camis):
  `sessions.list.byId[id].cwd` di-stempel SAAT SESI DIBUAT dan tidak pernah
  berubah, walau agent kerja di dalam git worktree linked
  (`/home/<repo>/.claude/worktrees/feat/...` — yang ada DI DALAM root repo).
  `git worktree add` + `cd` di bash = workdir PER-PANGGILAN TOOL, bukan cwd
  sesi. Sinyal "agent lagi di mana" = event stream `session/event` →
  `tool/code-dispatch-start` → `data.arguments.workdir` (pola sama
  dsh-git-state). Implementasi: host index workdir terakhir per sesi
  (Map bounded 64, tulis ulang; 0 readSession utk sesi lain) + backfill 1×
  per sesi per boot via `ctx.get('sessionQuery').readSession(id)` (scan
  event TERAKHIR ke depan, dedup in-flight + tanda backfilled; tanpanya sesi
  idle pra-restart tidak pernah terdorong) + route `GET /active-dir` (murah,
  dipoll 3 dtk selagi panel terbuka). Client: `deepestWorkspace()` (mengandung
  workdir, segment-aware — bukan exact match kayak auto-select cwd); pindah
  workspace hanya kalau `!manualRef`; penanda `lastFollowRef` mencegah
  "perang navigasi" — re-follow hanya saat workdir BERUBAH, bukan tiap poll
  (kalau tidak, navigasi manual pengguna langsung ditimpa 3 dtk kemudian).
  Workdir di luar semua workspace → perilaku cwd tetap (batas containment).
  **UPDATE 25 Aug 2026 — FITUR DIHAPUS (sanction pemilik):** bukti dari
  session JSONL (`~/.dsh/sessions/*/*/session.jsonl.zstd`, parse per-event,
  JANGAN grep mentah — teks percakapan ikut ter-index dan menghasilkan false
  positive): sinyal `arguments.workdir` HANYA ada di sesi bridge Claude Code
  saat agen SECARA EKSPLISIT mengirim argumen `workdir` pada panggilan bash
  (sesi kaya worktree: 41/116 panggilan; sesi lain: 0). Sesi DSH-native tidak
  pernah memancarkan `tool/code-dispatch-start` sama sekali (mereka pakai
  `tool/call` tanpa workdir yang dipersist). Jadi `/active-dir` mengembalikan
  null untuk mayoritas sesi → follow tampak mati. Host-nya sendiri terbukti
  berfungsi (curl live mengembalikan path worktree untuk sesi yang kaya
  sinyal). Kesimpulan: premis desain (sinyal workdir selalu tersedia) salah —
  jangan bangun ulang fitur ini tanpa sinyal level harness.
- **Deps array useEffect diakses SAAT RENDER — JANGAN referensikan
  useCallback yang dideklarasikan DI BAWAHNYA** (kejadian nyata 24 Aug 2026,
  "Cannot access 'load' before initialization"): efek follow menaruh `load`
  di deps array padahal `const load = useCallback(...)` ada di bawahnya →
  TDZ, SELURUH slot `details` padam (bukan cuma komponen gagal — "slot entry
  crashed"). Gejala di browser: panel tidak muncul sama sekali; console:
  ReferenceError. Fix: pindahkan efek ke SETELAH deklarasi callback-nya.
- **Petakan error `FsError.code` di route HTTP, jangan andalkan bentuk sendiri**
  (pelajaran 15 Aug 2026): klik file biner (gambar) → `ctx.fs.readText`
  melempar FsError `FS_NOT_TEXT` ("binary file") → tanpa pemetaan jadi 500
  "internal-error". `sendError` WAJIB petakan: FS_NOT_TEXT → 415 `binary-file`,
  FS_TOO_LARGE → 413, FS_NOT_FOUND → 404, FS_PERMISSION_DENIED /
  FS_SANDBOX_DENIED → 403. Preview biner lewat route `/raw`:
  `ctx.fs.readBytes` + Content-Type dari ekstensi + batas ukuran terpisah —
  TETAP lewat `resolveInside` (containment wajib sama).
- **Panel yang "memakan layout" WAJIB seat `details`, bukan `shell.overlay`**
  (keputusan pemilik, 18 Aug 2026): `shell.overlay` itu layer
  `position:absolute; inset:0` di atas grid — anak-anaknya TIDAK BISA mendorong
  layout (chat tidak terdorong, bukan salah CSS). Kolom kanan beneran = seat
  `details` (kind single, scope session) + `ctx.layout.openDetails()` /
  `closeDetails()`; default lebar 360px, clamp 300–520, ada drag handle.
  Konsekuensi yang DISETUJUI pemilik: seat ini menggantikan (shadow) panel
  "tool details" bawaan (`conversation.details.tool` milik
  ui-conversation/ui-tool) — jangan dianggap bug. Catatan implementasi:
  register dengan `priority: -1` — slot `single` MENOLAK register di priority
  yang sama dengan occupant (throw "already has a registration at priority 0",
  kejadian nyata 18 Aug 2026); yang menang = nilai priority TERENDAH (lowest
  renders). (Dulu disarankan memanggil `openDetails` di useEffect occupant —
  ATURAN ITU SUDAH DICABUT 25 Aug 2026, lihat lesson "JANGAN hidupkan lagi
  auto-open".) Tetap valid: akses layout hanya dari dalam komponen/effect,
  BUKAN di apply — `layout` bisa belum "wired" sebelum root entry mount
  (error "layout: panel actions not wired"); bungkus try/catch. Verifikasi
  occupancy lewat Inspect provider (Slots.listSubTree root "details").
- **Seat scope-sesi REMOUNT tiap pindah sesi — JANGAN hidupkan lagi
  auto-open** (keputusan pemilik 25 Aug 2026): seat `details` ber-scope
  session → entry baru per sesi, efek mount jalan lagi di setiap klik sesi.
  Versi awal plugin memanggil `openDetails()` di mount → tutup-manual
  pemilik selalu ditimpa tiap pindah sesi (keluhan nyata). Dua iterasi fix
  dalam satu hari: (1) guard pref localStorage — DIBUANG juga karena pemilik
  memutuskan lebih tegas: **panel selalu mulai tertutup, di browser siapa
  pun, tanpa kecuali; satu-satunya pemicu buka = klik tombol Files
  (toggle)**. Pref dibuang total (tanpa pembaca = dead code). Kalau suatu
  saat diminta persisten lagi, ingat: tulis pref di SATU jalur
  (openPanel/closePanel) — jalur close yang lupa menulis pernah bikin
  panel auto-open lagi tiap pindah sesi.
- **`ctx.layout` itu write-only — status buka/tutup dibaca dari DOM**
  (25 Aug 2026): face `layout` hanya punya openDetails/closeDetails (bundle
  ui-layout 0.1.1-rc.1); state asli = width px di store root (0 = tutup)
  dan TIDAK terekspos ke plugin. Toggle tombol Files membaca truth dari
  DOM: konten details tetap ter-mount walau kolom 0px (AppFrame selalu
  merender slot), jadi `.dshfe-panel`.clientWidth > 0 = benar-benar
  terlihat. JANGAN bikin state mirror sendiri — ui-layout me-CLOSE details
  OTOMATIS tiap pindah sesi (useLayoutEffect AppFrame) di luar kendali
  plugin. Jebakan pengujian: baca DOM/layout SYNC setelah dispatch
  menghasilkan nilai STALE (commit React async) — tunggu frame berikutnya
  sebelum menyimpulkan.

## Verifikasi

```sh
# di deployment, setelah `dsh plugin --profile web add` + restart dsh sekali
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/plugins/dsh-file-explorer/client.js   # 200
curl -sS http://127.0.0.1:3080/plugins/dsh-file-explorer/api/workspaces    # JSON daftar workspace
```

Iterasi UI: `pnpm watch` + refresh browser (produksi tanpa HMR — endpoint
no-cache).
