# dsh-plugins — catatan untuk agent (DSH / Claude Code)

Monorepo plugin DeepSeek Harness. **Baca ini sebelum ngoding di repo ini.**

## Keputusan terkunci (jangan diubah tanpa konfirmasi pemilik)

- **15 Aug 2026 — Topologi: SATU monorepo ini untuk SEMUA plugin** (opsi B).
  Satu plugin = satu paket npm di packages/*. JANGAN bikin repo terpisah per
  plugin, JANGAN bikin plugin di luar workspace ini. ADR lengkap:
  docs/decisions/.
- **15 Aug 2026 — Format paket**: dual-half — dsh.bundle (cordis.patch.yml
  dengan satu row name: <paket>) + dsh.client kalau ada UI
  (exports["./client"]). Satu row melayani host half DAN browser roster
  sekaligus.
- **15 Aug 2026 — Security boundary file-explorer**: semua route API panel
  wajib containment check dalam workspace terdaftar (ctx.fs.contains) — 403
  di luar root. Boundary ini WARISAN wajib untuk plugin lain yang menyentuh
  filesystem.

## Di mana dokumen berada

- **File ini (root)**: hanya konvensi & aturan yang berlaku LINTAS paket.
- **`packages/<nama>/CLAUDE.md`**: arsitektur, seam dsh, lesson learned, dan
  verifikasi KHUSUS satu plugin. Setiap plugin WAJIB punya satu. Template
  minimal: "Apa ini" / "Arsitektur & seam" / "Lesson learned" / "Verifikasi".
  Kalau plugin suatu hari dipindah ke repo sendiri, folder + CLAUDE.md-nya
  tinggal diangkat — ilmunya ikut.

## Struktur

```
packages/
  file-explorer/          # panel tree file + viewer source code
    src/index.ts          # host half (Node): route HTTP list/read/raw/workspaces/active-dir
    src/client/index.tsx  # browser half: seat details (kolom kanan) + conversation.session.header.utilities
    cordis.patch.yml      # layer: - insert: [{ id: file-explorer, name: dsh-file-explorer }]
  dsh-tunnel-loopback/    # paksa connection.isLoopback=true di client (tunnel/proxy)
    src/index.ts          # host half: marker + pemeriksa urutan komposisi
    src/client/index.ts   # browser half: flip isLoopback sebelum settings bind
    cordis.patch.yml      # layer: - insert: [{ id: tunnel-loopback, name: dsh-tunnel-loopback }]
  dsh-git-state/          # strip status git (branch/perubahan/stash/worktree/PR) di atas composer
    src/index.ts          # host half (Node): route HTTP GET /plugins/dsh-git-state/api/state (git read-only; timeout via service customSettingsApplied)
    src/client/index.tsx  # browser half: slot conversation.input.dock (order -10); interval poll dari Custom Settings
    cordis.patch.yml      # layer: - insert: [{ id: git-state, name: dsh-git-state }]
  dsh-session-archive/    # halaman kelola sesi terarsip (Settings → Archived Sessions) + unarchive
    src/index.ts          # host half: subclass WorkspaceRegistry (unarchiveSession) + route POST /api/unarchive
    src/client/index.tsx  # browser half: slot settings.section (order 16) — daftar per workspace + dialog konfirmasi
    cordis.patch.yml      # PENGECUALIAN: - {id: workspace, disabled: true} + - insert: [{id: session-archive, name: dsh-session-archive}]
  dsh-copy-link-sesi/     # menu "Salin link" di baris sesi + deep-link ?session= (buka sesi dari URL)
    src/index.ts          # host half: AUTO-REPAIR patch menu saat boot (logika di scripts/patch-core.mjs)
    src/client/index.tsx  # browser half: buka sesi dari ?session= lalu bersihkan param URL (one-shot)
    scripts/patch-core.mjs  # sumber tunggal logika patch — menu baris sesi TIDAK punya seam (rc.6/rc.7)
    scripts/apply-patch.mjs # CLI manual di atas core (fallback — host half sudah otomatis)
    cordis.patch.yml      # layer: - insert: [{id: copy-link-sesi, name: dsh-copy-link-sesi}]
  dsh-custom-settings/    # tab Settings "Custom Settings" (order 26): tunable live (juga milik plugin lain, mis. git-state) + cek/upgrade versi dsh
    src/tunables.ts       # SUMBER TUNGGAL daftar tunable (tambah setting = 1 entri, UI render otomatis)
    src/index.ts          # host half: settings.register + apply live ke codeRuntime.config + 4 route API (termasuk POST /api/upgrade)
    src/client/index.tsx  # browser half: slot settings.section (order 26) — form tunable + tooltip + dialog upgrade
    cordis.patch.yml      # layer: - insert: [{id: custom-settings, name: dsh-custom-settings}]
  dsh-claude-skill-bridge/ # bridge skill & command Claude Code (plugin cache + skill builtin binary) → DSH
    src/index.ts          # host half HOST-ONLY (tanpa UI): saat boot — mirror plugin-pilihan ke
                          #   ~/.dsh/claude-bridge/ (config `mirror`), ekstrak skill builtin binary
                          #   (config `extract`), symlink ke ~/.claude/skills|commands|agents, prune yatim
    cordis.patch.yml      # layer: - insert: [{id: claude-skill-bridge, name: dsh-claude-skill-bridge}]
                          # CATATAN: customSkillDirs di row skill-filesystem di-DISABLE oleh dsh-web-app
                          # di profil web — registrasi via user scope (verified 24 Aug 2026).
```

Detail per plugin: `packages/*/CLAUDE.md` masing-masing.

## Konvensi lintas paket

- **Pengecualian `cordis.patch.yml` (khusus plugin yang MENGGANTI service
  inti, seperti `dsh-session-archive`)**: boleh menonaktifkan row default
  (`- {id: <id-default>, disabled: true}`) + row insert sendiri; bundle
  ditaruh di AKHIR `dsh.profile.bundles` supaya layer-nya menang. Lihat
  `docs/decisions/2026-08-17-session-archive-unarchive-only.md`. Plugin biasa
  tetap satu row insert tanpa disable.

- Nama paket: dsh-<kata> (unscoped). Nama = id plugin = id modul browser.
- Build: pnpm install (sekali) → pnpm build (tsdown; preset bersama
  tsdown.client.ts).
- Bundle client wajib eksternal semua @deepseek-ai/* (purity gate).
- Bundle client WAJIB punya shim CJS di banner/footer preset (tsdown.client.ts):
  `var module = { exports: {} }; var exports = module.exports;` (banner) +
  `return module.exports;` (footer). Tanpa shim: "exports is not defined" saat
  materialisasi (kejadian nyata 15 Aug 2026). JANGAN dihapus.
- **UI plugin wajib `ctx.slots.inject(...)`** (bukan register langsung di
  apply), **slot ber-kind `list` wajib `options.id`**, dan **wajib token
  `--dsw-*`** (theme-aware). Detail + kejadian nyata:
  `packages/file-explorer/CLAUDE.md`.
- **Skill `restart-dsh` kembar** (18 Aug 2026): `.dsh/skills/restart-dsh/SKILL.md`
  (dibaca DSH; terverifikasi live — watcher filesystem provider langsung
  publish ke katalog sesi) + `.claude/skills/restart-dsh/SKILL.md` (dibaca
  Claude Code). Konten SAMA, edit dua-duanya. Isinya: restart `dsh.service`
  dari dalam turn agent — detached + sleep (jangan matikan turn sendiri),
  `sudo -n systemctl` scope system (`systemctl --user` gagal di shell agent),
  verifikasi MainPID baru, sesi persist jadi aman, client-only = cukup build +
  refresh.
- Tambah plugin baru: salin packages/file-explorer → ganti nama + isi →
  otomatis masuk workspace (packages/*). WAJIB buat `CLAUDE.md` paket
  (template di atas) dan perbarui bagian "Struktur" di file ini.
- Test di VPS: dsh plugin --profile web add ./packages/<nama> → verifikasi
  dsh --profile web --dump-config → restart dsh SEKALI di jeda antar turn
  (sesi persist, jangan restart saat ada agent lagi kerja).
- Iterasi UI: pnpm watch + refresh browser (produksi tanpa HMR — endpoint
  no-cache).
- Versi dsh target: 0.1.0-rc.6 — seam yang dipakai tiap paket diverifikasi di
  versi ini (daftar lengkap per paket di CLAUDE.md paket masing-masing); kalau
  dsh di-upgrade, cek ulang seam-nya dulu.
- Publish: build dulu, lalu pnpm --filter <paket> publish --access public.
  User lain: dsh plugin --profile web add <nama> + restart.
- **PRIVASI (wajib, pasca-insiden 15 Aug 2026): repo ini PUBLIK.** Jangan pernah
  menulis nama asli, email pribadi, path absolut (di luar repo), atau identitas VPS
  ke file repo ini — termasuk CLAUDE.md per paket. Identitas git = noreply
  (cek `git config user.email` harus berakhiran @users.noreply.github.com),
  sudah diset repo-lokal — jangan diubah ke email pribadi. Sebelum push: audit
  grep + git log (lihat aturan lengkap di CLAUDE.md workspace utama).
- **Disiplin belajar: SETIAP insiden/error yang makan waktu → tambah baris
  pelajaran SEBELUM commit fix-nya.** Catat di `CLAUDE.md` paket yang
  bersangkutan — lesson learned-nya ikut pindah kalau paket dipisah; ke file
  ini (root) hanya kalau berlaku lintas paket. Inilah "progressive learning"
  repo ini — tanpa baris baru, kesalahan yang sama bisa terulang di sesi baru.
