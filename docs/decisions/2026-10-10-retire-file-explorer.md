# ADR 2026-10-10 — Pensiunkan `dsh-file-explorer` (panel file kini native DSH 0.2)

Status: **diterima** (keputusan pemilik, 10 Oct 2026)

## Konteks

`dsh-file-explorer` adalah paket pertama monorepo ini (15 Aug 2026): panel tree file
+ viewer source code, host half dengan empat route `ctx.webServer`
(`/workspaces`, `/list`, `/read`, `/raw`) dan browser half yang menempati kolom
kanan (`details`; sejak 0.2: tab `sidebar.right.pane.tab`).

DSH 0.2 sudah menyediakan kemampuan itu secara native:

- `@deepseek-ai/dsh-client-ui-sidebar-files` — panel file di UI
- `@deepseek-ai/dsh-api-workspace-files` — backend listing/read workspace

Plugin-nya juga sudah **dinonaktifkan di profil web** (bundle `dsh-file-explorer`
dicabut dari `dsh.profile.bundles`); dependency `link:` profil ke folder paket ini
ikut dicabut di perubahan yang sama.

## Keputusan

1. **Paket `packages/file-explorer/` dihapus dari repo.** Fungsinya sudah native;
   mempertahankannya berarti memelihara seam yang tidak dipakai lagi beserta tesnya.
2. **Aturan keamanannya TIDAK dihapus** — statusnya dinaikkan jadi konvensi lintas
   paket di `CLAUDE.md` root: setiap route API yang menyentuh filesystem wajib
   containment check (`ctx.fs.contains` → 403 di luar root) dan path tidak pernah
   datang dari client. Berlaku untuk semua plugin lokal, bukan cuma panel file.
3. **Ilmu yang lintas paket dipindah**, bukan ikut terhapus: bagian "Pelajaran UI
   plugin" di `CLAUDE.md` root memuat aturan slot (`ctx.slots.inject`,
   `options.id`, priority slot `single`), token `--dsw-*`, seat layout vs
   `shell.overlay`, pemetaan `FsError.code`, TDZ deps array `useEffect`, dan
   `sessions.list` cwd ≠ workdir agent. Catatan panjang aslinya tetap bisa diambil
   dari git history.

## Konsekuensi

- Template "tambah plugin baru" berganti ke `packages/dsh-tunnel-loopback` (kerangka
  dual-half paling ringkas) atau `packages/dsh-git-state` (contoh lengkap: route host
  + slot UI + tes).
- Tes containment khusus plugin itu dihapus dari `tests/dsh-0.2.test.mjs` (tidak ada
  lagi yang diuji); aturan containment tetap berlaku dan tetap diuji oleh paket yang
  menyajikan route filesystem.
- Komentar "pola dsh-file-explorer" yang tersisa di beberapa paket merujuk pola
  UI/route yang diwarisi dari paket ini — contoh hidupnya kini `dsh-git-state` dan
  `dsh-custom-settings`.
- Nama npm `dsh-file-explorer` tetap milik pihak lain (`sanguing`); repo ini memang
  tidak menerbitkan paket ke npm.
- Panel file di UI sepenuhnya milik core: perubahan core ke depan tidak lagi
  memerlukan penyesuaian plugin lokal.

## Referensi

- `CLAUDE.md` root — konvensi lintas paket + bagian "Pelajaran UI plugin"
- `git show 11ab1df:packages/file-explorer/CLAUDE.md` — catatan teknis lengkap paket
  yang dipensiunkan (arsip di history)
