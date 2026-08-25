# dsh-custom-settings — catatan untuk agent

Plugin "custom patch/setting dsh" untuk Web UI DeepSeek Harness: tab Settings
**"Custom Settings"** (paling akhir, order 26) berisi form tunable yang
di-apply **live tanpa restart** + kartu versi dsh (versi terpasang instan,
cek terbaru ke npm, **upgrade sekali-klik** dengan dialog konfirmasi).
**Baca ini sebelum ngoding di paket ini.** Dokumentasi user-facing di
`README.md`.

## Apa ini

- **Registri tunable** (`src/tunables.ts`): sumber tunggal daftar setting
  kustom. Tiap tunable = `{ id, configKey, label, description, tooltip, min,
  max, default, unit, presets?, restart?, consumer?, readApplied?,
  apply(ctx, value) }`. `consumer`: 'host' (default) | 'browser' (nilai
  dipakai client half plugin lain → apply host no-op + teks status beda);
  `readApplied(ctx)`: sumber nilai ter-apply utk `/api/status` (default:
  codeRuntime.config). Menambah setting baru = tambah SATU entri + rebuild
  host — browser half render otomatis dari `GET /api/tunables`, tanpa sentuh
  client.
- **Tunable v1 `runCodeMaxWallMs`** (configKey `maxWallMs`): membesarkan batas
  `run_code` dari 600.000 ms (10 menit) ke default 3.600.000 ms (1 jam) —
  menutup jebakan "approval hangus saat plan dibaca >10 menit" di preset
  `code` (exit_plan_mode berjalan di dalam run_code; timeout menghitung waktu
  baca plan; terbukti 2× di sesi 5ae70e81). Nilai **live**: `run()` code
  runtime membaca `this.config.maxWallMs` di setiap run.
- **Tunable v2/v3 `gitStatePollMs` + `gitStateCmdTimeoutMs`** (milik plugin
  dsh-git-state, konsep CONSUMER): pertama dikonsumsi browser half
  dsh-git-state (`consumer: 'browser'`, apply host no-op — client bind
  namespace ini sendiri); kedua dikonsumsi host half-nya lewat objek bersama
  'customSettingsApplied'. Preset poll: 30 dtk / 1 mnt / 5 mnt / 15 mnt /
  30 mnt / 1 jam / 3 jam / 6 jam / 12 jam / 1 hari.
- **Kartu versi dsh**: versi terpasang tampil instan (lokal), "Cek versi
  terbaru" (npm registry dist-tag latest), tombol Upgrade → npm install -g →
  restart dsh otomatis (detached, setelah respons terkirim).

## Arsitektur & seam

```
src/tunables.ts        # registri tunable (SUMBER TUNGGAL daftar setting)
src/index.ts           # host half: settings.register + apply live + 4 route API
src/client/index.tsx   # browser half: slot settings.section order 26 → tab
cordis.patch.yml       # - insert: [{id: custom-settings, name: dsh-custom-settings}]
```

- **Settings namespace `custom-settings`**: `ctx.settings.register(NS,
  z.object({...}))` (row `settings` = `@deepseek-ai/dsh-settings-file`,
  dokumen `~/.dsh/settings.yaml`). Schema dari `@deepseek-ai/schemastery`
  (DEFAULT export — `import z from`, BUKAN named; `.int()` TIDAK ada — pakai
  `min/max/default`; validasi integer di `apply()` via Math.round). `scope.get()`
  = resolved (deep-frozen, default terisi); `scope.watch(cb)` dipanggil saat
  dokumen berubah (termasuk tulis dari browser via loopback RPC) — bungkus
  `ctx.effect(() => scope.watch(...))`.
- **Apply live**: cordis TIDAK membekukan config plugin (diverifikasi rc.7,
  0 kemunculan freeze) → mutasi `codeRuntime.config.maxWallMs` langsung dipakai
  run berikutnya (`setTimeout(..., this.config.maxWallMs)` di tiap run()).
  `codeRuntime` dibaca via `ctx.get('codeRuntime')` (opsional/defensive).
- **Objek bersama lintas-plugin** (`'customSettingsApplied'`): apply()
  mem-provide SATU service cordis berisi nilai utk plugin konsumen (kini:
  `{ gitState: { cmdTimeoutMs } }` untuk host half dsh-git-state). Konsumen
  membaca LAZY via `ctx.get(...)` per-request → urutan boot dua arah aman;
  apply() tunable memutasi objek IN-PLACE → perubahan live tanpa event.
  Diverifikasi micro-test standalone cordis (provide/get dua urutan + mutasi
  in-place terbaca) SEBELUM dipakai — seam baru wajib diverifikasi dulu.
- **Route API** (`ctx.webServer`, pola file-explorer, `kind: 'exact'`):
  `GET /tunables`, `GET /status` (`{applied, installedVersion,
  lastRestartFailed}`), `GET /version`, `POST /upgrade`, `POST /save`
  (path tulis SATU-SATUNYA dari browser; lihat lesson 25 Aug 2026 di bawah;
  konteks face `settings.mutate(ns, ops, expectedRevision?)` dari provider +
  `settings.get(ns)` utk readApplied konsumen browser).
- **Versi terpasang**: derivasi layout npm-global dari `process.execPath`
  (`<node>/../lib/node_modules/@deepseek-ai/dsh/package.json`) — `createRequire(process.argv[1])`
  GAGAL karena argv[1] = symlink bin (diverifikasi). Fallback
  `createRequire(import.meta.url)`.
- **Versi terbaru**: `fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest')`
  + `AbortSignal.timeout(8000)`; bandingkan dengan mini semver lokal
  (core numerik + prerelease segmen, tanpa dependensi).
- **Upgrade**: `execFile(process.execPath, [npmCliPath, 'install', '-g',
  '@deepseek-ai/dsh@latest'])` — npm-cli di `<node>/../lib/node_modules/npm/bin/npm-cli.js`
  (service PATH memuat nvm tapi jangan diandalkan; npm global prefix milik
  user → TANPA sudo). Sukses → respons dikirim → `spawn('bash', ['-c', 'sleep
  3; sudo -n systemctl restart dsh ...'])` detached+unref (bash/sudo/systemctl
  ada di PATH service: /usr/local/bin:/usr/bin:/bin). Marker kegagalan restart
  di `os.tmpdir()/dsh-upgrade-restart-failed` (dibaca `/api/status` →
  `lastRestartFailed`). Lock `upgrading` mencegah 2 upgrade bersamaan.
- **Browser**: `settingsScope.bind({namespace})` dari
  `@deepseek-ai/dsh-client-ui-settings` → `{getSnapshot, subscribe, set,
  unset}` (transport loopback — deployment pakai dsh-tunnel-loopback).
  Registrasi tab WAJIB `slots.inject('settings.section', ...)` + `options.id`
  (pola dsh-session-archive).
- Versi dsh target: 0.1.0-rc.7 (seam diverifikasi 19 Aug 2026; kalau upgrade
  dsh, cek ulang: nama service settings/codeRuntime, slot settings.section,
  PATH service, layout npm-global).

## Lesson learned (jangan diulang)

- **JANGAN salin pola `slots.slots.inject(...)` dari dsh-session-archive
  mentah-mentah**: di session-archive variabel `slots` = `ctx` utuh (cast),
  jadi `slots.slots` = `ctx.slots`; di paket ini `slots` SUDAH di-destructure
  jadi `ctx.slots` → `slots.slots` = undefined → "Cannot read properties of
  undefined (reading 'inject')" saat apply client (kejadian nyata 19 Aug 2026,
  loader entry gagal, tab Custom Settings tidak muncul). Pakai
  `slots.inject(...)` / `slots.register(...)` langsung.
- **Method `settingsScope.bind()`-scope WAJIB dibungkus arrow di
  `useSyncExternalStore`**: `SettingsScopeController.getSnapshot/subscribe`
  adalah class method yang membaca `this.store` — referensi mentah
  (`scope.getSnapshot`) melepas `this` → TypeError "Cannot read properties of
  undefined (reading 'store')" di render (kejadian nyata 19 Aug 2026, tab
  Custom Settings crash). Pakai `(cb) => scope.subscribe(cb)` +
  `() => scope.getSnapshot()`. `scope.set/unset` aman karena dipanggil
  sebagai method.
- **`@deepseek-ai/schemastery` = DEFAULT export** (`import z from ...`), dan
  schema-nya DESKRIPTOR callable — `z.number().int()` TIDAK ADA (error
  TypeError), `z.number().min/max/default` ada; validasi integer lakukan di
  `apply()` (Math.round).
- **JANGAN import `@deepseek-ai/dsh-timeout`**: dist-tag npm-nya (0.0.1-rc.1)
  BEDA dari versi yang ter-install di deployment (0.1.0-rc.7) — resolusi versi
  bisa mismatch. `MAX_TIMER_DELAY_MS = 2147483647` di-hardcode + dikomentari di
  `tunables.ts` (konstanta stabil Node).
- **`createRequire(process.argv[1])` gagal** saat entry dijalankan lewat
  symlink (bin/dsh) — MODULE_NOT_FOUND. Versi terpasang dibaca dari
  `process.execPath`-derived global path (layout npm-global standar).
- **Mutasi config plugin itu sah** (cordis tidak freeze config, diverifikasi
  rc.7) — inilah mekanisme "patch runtime" paket ini. Kalau dsh berubah
  (config di-freeze / dibaca sekali di konstruktor), tunable `restart: true`
  atau mekanisme lain.
- **Route mutasi `POST /upgrade` beda dari route GET lain di monorepo**:
  eksekusi npm install -g + sudo systemctl restart. Aman hanya karena
  deployment single-user + Cloudflare Access + dialog konfirmasi. Jangan
  expose publik; kalau deployment jadi multi-user, tambah gate auth.
- **Restart dari dalam proses dsh**: respons HTTP harus terkirim SEBELUM
  restart dijadwalkan (sleep 3 detik); child wajib `detached: true` +
  `unref()` supaya survive kematian parent; deteksi kegagalan via marker file
  (bukan exit code yang bisa hilang).
- **E2E upgrade tidak bisa diuji saat latest == terpasang** — gating diuji
  (409 already-up-to-date), jalur error npm diuji dengan paket tak ada;
  eksekusi sungguhan baru teruji saat versi baru terbit. Jangan klaim
  teruji E2E.
- **settings.section order 26** = paling akhir; penghuni terpasang: general 0,
  models 10, plugins 15, agent-presets 20, archived-sessions 25. Header
  Settings (`settings.header` dll) adalah chrome global shell — jangan
  sembunyikan dari plugin.
- **Face `provide` WAJIB return `void`** kalau hasilnya dibungkus
  `ctx.effect(() => provide(...))`: deklarasi return `unknown` memicu TS2769
  overload effect (kejadian nyata 19 Aug 2026). Lifetime service milik fiber
  provider — framework cordis membersihkannya saat plugin reload/dispose,
  disposer manual tidak perlu.
- **Stub `ctx.effect` untuk smoke test host WAJIB MENGEKSEKUSI callback**
  segera (semantik cordis), bukan sekadar mengumpulkannya (kejadian nyata 19
  Aug 2026): stub yang hanya push callback membuat provide + SEMUA register
  route tidak jalan → smoke tampak "apply tidak melakukan apa-apa" dan
  diagnosis sempat salah arah ke bundle basi.
- **Handoff nilai lintas plugin pakai provide/get lazy + mutasi in-place**
  (pola baru 19 Aug 2026, lihat Arsitektur): assignment properti mentah di
  ctx ternyata TIDAK throw di cordis terpasang, tetap pakai `provide()`
  karena idiomatik + terlacak; JANGAN ganti referensi objek bersama saat
  apply (konsumen yang membaca lazy bisa kehilangan perubahan).
- **JANGAN seed `drafts` form tunable dengan default saat mount** (25 Aug
  2026, laporan pemilik "nilai gak persist padahal notif Tersimpan"): draftOf
  memprioritaskan draft, jadi input SELALU menampilkan default setelah
  refresh — padahal nilai tersimpan tetap ada di settings.yaml. Gejala khas:
  input 30000/6000 padahal dokumen berisi 300000/300000. Fix: draft hanya
  diisi saat pengguna mengetik/memilih preset; fallback draftOf = draft →
  resolved (scopeSnapshot) → default deskriptor.
- **`settingsScope.set/unset` di dsh-client-ui-settings 0.1.1-rc.2
  MENELAN kegagalan** (25 Aug 2026): `SettingsScopeController.write`
  meng-catch semua error DAN respons non-ok (settings-conflict dgn revision
  basi dari tab lain, settings-rejected) → `recover()` (reload mirror) →
  resolve biasa → `await scope.set()` SELALU sukses → UI "✓ Tersimpan" palsu.
  DIVERIFIKASI live: bump revision eksternal (tab lain) → Simpan dari tab
  dengan mirror basi → notif "✓ Tersimpan" + "✓ Aktif: 1 jam", dokumen TIDAK
  berubah, revision tetap. Ini penyebab hilangnya gitStateCmdTimeoutMs
  pemilik. Fix: path tulis SATU-SATUNYA adalah `POST /api/save` milik host
  (provider `settings.mutate` tanpa revision fence — dibaca fresh
  server-side, dan menulis per-field sehingga tidak menimpa field lain);
  client menampilkan error nyata dari route. `settingsScope` kini hanya untuk
  BACA (mirror describe).
- **`settings.mutate(ns, ops, expectedRevision?)` ada di provider**
  (0.1.1-rc.2), tapi TIDAK ada di scope hasil `register` (hanya
  get/watch/update/replace) — unset per-field via provider, bukan scope.
  `settings.get(ns)` = resolved satu namespace (default terisi) — sumber
  readApplied konsumen browser (gitStatePollMs) supaya badge "Aktif" muncul.

## Verifikasi

```sh
pnpm --filter dsh-custom-settings build        # host ESM + client CJS
# setelah dsh plugin add + restart dsh:
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/plugins/dsh-custom-settings/client.js  # 200
curl -sS http://127.0.0.1:3080/plugins/dsh-custom-settings/api/tunables    # JSON deskriptor — 3 tunable; gitStatePollMs punya 10 preset + consumer=browser
curl -sS http://127.0.0.1:3080/plugins/dsh-custom-settings/api/status      # applied.maxWallMs=3600000 + installedVersion (+ gitStateCmdTimeoutMs setelah ubah nilai)
curl -sS http://127.0.0.1:3080/plugins/dsh-custom-settings/api/version     # upToDate=true saat latest==terpasang
curl -sS -X POST http://127.0.0.1:3080/plugins/dsh-custom-settings/api/upgrade  # 409 already-up-to-date
# UI: Settings → Custom Settings (paling bawah); ubah nilai → status "Aktif" berubah
# tanpa restart; cek versi → "Sudah terbaru". E2E upgrade hanya saat versi baru terbit.
```
