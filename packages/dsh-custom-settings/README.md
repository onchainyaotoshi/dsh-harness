# dsh-custom-settings

Custom settings & runtime patches untuk DeepSeek Harness Web UI, dikelola dari
halaman **Settings → Custom Settings** (tab paling bawah).

## Fitur

- **Tunable `runCodeMaxWallMs`** — batas waktu eksekusi `run_code`. Default
  dsh 10 menit membuat approval plan mode hangus kalau plan dibaca lebih lama
  (exit_plan_mode berjalan di dalam run_code). Default plugin: **1 jam**,
  diubah kapan pun dari UI. Nilai **berlaku langsung tanpa restart** dan
  bertahan di `~/.dsh/settings.yaml`.
- **Tunable Git State (milik plugin dsh-git-state)** — `Interval auto-refresh
  Git State` (default 30 dtk; preset 30 dtk / 1 mnt / 5 mnt / 15 mnt / 30 mnt /
  1 jam / 3 jam / 6 jam / 12 jam / 1 hari) dan `Timeout perintah git` (default
  6 dtk). Dua-duanya berlaku langsung tanpa restart; nilai pertama dipakai oleh
  browser half dsh-git-state, kedua oleh host half-nya.
- **Cek versi dsh** — versi terpasang tampil otomatis; tombol "Cek versi
  terbaru" membandingkan dengan registry npm.
- **Upgrade sekali-klik** — saat ada versi baru: tombol Upgrade + dialog
  konfirmasi → `pemeriksaan kompatibilitas → npm install versi yang diperiksa` → dsh restart otomatis
  (halaman reconnect sendiri, sesi agen aman).

## Pemasangan

```sh
dsh plugin --profile web add dsh-custom-settings
# lalu restart dsh sekali
```

## Pengembangan

Tambah setting baru = tambah satu entri di `src/tunables.ts` (host half),
rebuild — UI (form + deskripsi + tooltip) ter-render otomatis dari
`GET /api/tunables`. Lihat `CLAUDE.md` paket untuk arsitektur & lesson learned.

Upgrade memeriksa deklarasi kompatibilitas semua bundle plugin profil sebelum
mengubah instalasi. Plugin lokal mendukung seri API 0.2; versi 0.3 dan
selanjutnya memerlukan verifikasi/migrasi terlebih dahulu. Salinan core DSH
di profil ditolak karena dapat menutupi runtime baru. Dependensi core harus
mengikuti instalasi host. Pemeriksaan ini bukan jaminan bahwa versi mendatang
bebas perubahan perilaku; build dan tes tetap diperlukan saat memperluas dukungan.
