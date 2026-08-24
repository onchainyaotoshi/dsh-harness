# dsh-file-explorer

Plugin [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) untuk
Web UI: panel tree file workspace aktif + viewer isi file (teks dan preview
gambar kecil), di kolom kanan (seat `details`).

## Fitur

- Tree direktori workspace aktif — auto-select mengikuti sesi; override manual
  bertahan sampai sesi berganti.
- **Mengikuti direktori kerja agent** (workdir panggilan bash terbaru sesi).
  Jadi kalau agent bekerja di dalam git worktree linked
  (`/home/<repo>/.claude/worktrees/...`), panel ikut buka tree di situ —
  bukan cuma root checkout utama tempat sesi dibuat. Workdir di luar semua
  workspace terdaftar → panel tetap di perilaku cwd (batas containment).
- Viewer source code dengan theme tokens `--dsw-*` (ikut light/dark).
- Preview gambar kecil lewat route `raw` (Content-Type dari ekstensi).

## Instalasi

```sh
dsh plugin --profile web add dsh-file-explorer
```

lalu restart dsh sekali. Instalasi lokal dari checkout monorepo (sebelum
publish): `dsh plugin --profile web add ./packages/file-explorer`.

## Keamanan

Semua route API panel dibatasi **containment workspace** di host half
(`ctx.fs.contains`) — akses di luar root workspace terdaftar ditolak 403.
Route ini tidak ikut pagar `/api` (method PRIVILEGED), jadi pastikan UI ini
tetap di balik autentikasi deployment (mis. Cloudflare Access). Boundary ini
wajib dipertahankan di plugin apa pun yang menyentuh filesystem.

## Develop

```sh
pnpm install   # sekali, dari root monorepo
pnpm build     # host half + client bundle
pnpm watch     # iterasi UI (refresh browser; bundle di-serve no-cache)
```
