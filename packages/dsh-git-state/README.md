# dsh-git-state

Plugin [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) untuk
Web UI: strip status git satu baris di atas composer — branch, ahead/behind,
perubahan uncommitted, stash, worktree, dan PR open — untuk setiap workspace
terdaftar. Klik strip untuk melihat detail.

## Fitur

- Strip ringkas (slot `conversation.input.dock`, baris paling atas) — chip
  bernilai nol disembunyikan; bersih ditandai "bersih"; bukan repo git ditandai
  redup.
- **Deteksi worktree aktif**: strip menampilkan branch/ahead-behind/perubahan
  dari checkout yang sedang dikerjakan (riwayat `workdir` bash sesi tab itu +
  proses hidup), bukan checkout utama. Multi-tab dengan worktree berbeda aman —
  tiap tab menghitung sendiri dari sesinya.
- Panel detail: file berubah (kode XY porcelain), daftar stash, daftar worktree
  dengan tag `utama` / `aktif` / `dipakai` (proses hidup) / `dikerjakan sesi
  lain` + jumlah perubahan tiap worktree, daftar PR open (link ke GitHub).
- Auto-select workspace mengikuti sesi aktif (cwd canonical); override manual
  lewat tab workspace bertahan sampai sesi berganti.
- Auto-refresh default 30 detik + tombol refresh manual. Interval bisa diatur
  live dari **Settings → Custom Settings** (preset 30 dtk s.d. 1 hari) — tiap
  tab memakai nilai baru pada siklus refresh berikutnya, tanpa restart.
- Timeout perintah git di host (default 6 dtk) juga bisa dinaikkan untuk
  repo/worktree besar dari halaman yang sama.
- Semua perintah git **read-only**, dibatasi ke workspace terdaftar.

## Instalasi

```sh
dsh plugin --profile web add dsh-git-state
```

lalu restart dsh sekali. Instalasi lokal dari checkout monorepo (sebelum
publish): `dsh plugin --profile web add ./packages/dsh-git-state`.

## Keamanan

Host half hanya menjalankan perintah read-only (`status --porcelain`,
`rev-parse`, `stash list`, `worktree list`, `gh pr list`) dengan `git -C
<path>` — path selalu dari `workspaceRegistry`, client hanya mengirim id
workspace. Route ini tidak ikut pagar `/api` (method PRIVILEGED), jadi pastikan
UI ini tetap di balik autentikasi deployment (mis. Cloudflare Access).

## Keterbatasan

- PR open butuh `gh` CLI terautentikasi di host; tanpa itu chip PR
  disembunyikan (graceful).
- Strip scope sesi — tidak muncul di layar hero (tanpa sesi aktif).
- Worktree non-utama dicek status & sync-nya (cap 20); daftar file di-cap 200.
- Deteksi "aktif" mengandalkan riwayat bash sesi DSH; kerja lewat terminal
  eksternal (ssh) hanya terlihat lewat proses hidup (tag `dipakai`).
