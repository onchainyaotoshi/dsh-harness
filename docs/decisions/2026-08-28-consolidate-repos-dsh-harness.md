# Konsolidasi repo: dsh-harness (pengganti dsh-plugins + deepseek-harness-deploy)

- **Tanggal**: 28 Aug 2026
- **Status**: accepted

## Konteks

Ada dua repo mitra yang dipakai bergantian sebagai folder kerja sesi chat:

- `dsh-plugins` (PUBLIC) — monorepo plugin: 8 paket npm (`dsh-file-explorer`,
  `dsh-session-archive`, `dsh-tunnel-loopback`, `dsh-git-state`,
  `dsh-copy-link-sesi`, `dsh-custom-settings`, `dsh-claude-skill-bridge`,
  `dsh-patches`).
- `deepseek-harness-deploy` (PRIVATE) — artefak & catatan deploy dsh di VPS:
  `loopback-proxy.mjs` (dipakai `dsh-proxy.service`), mockup diagram
  `dsh-git-state-diagram`, catatan insiden WS heartbeat, path absolut dan
  domain pribadi.

Pemilik sering bingung harus mulai sesi chat di folder mana; keduanya
mengisi lapisan yang berbeda tetapi sebenarnya satu domain kerja.

## Keputusan

1. **Satu repo publik `dsh-harness`** menggantikan keduanya. Nama paket root
   diubah menjadi `dsh-harness`.
2. **History `dsh-plugins` dipertahankan UTUH** sebagai baseline repo baru
   (history public, aman; 42+ commit ikut).
3. **Artefak deploy masuk subfolder `deploy/` sebagai satu commit impor.**
   History repo deploy TIDAK dibawa — repo lama tetap menyimpan history
   penuh dan tetap PRIVATE saat diarsipkan, jadi tidak ada data yang hilang.
4. **Sanitasi wajib**: semua path absolut dan domain pribadi yang ada di isi
   repo deploy TIDAK pernah masuk repo publik (audit grep sebelum push).
5. **Catatan deploy privat (path absolut, domain, konfigurasi VPS) tetap
   lokal** di `deploy/CLAUDE.md` — gitignored, tidak pernah di-push, dan
   tetap utuh di arsip private repo lama.
6. **Kedua repo lama diarsipkan di GitHub** (`dsh-plugins` dan
   `deepseek-harness-deploy`).
7. **Folder lokal tunggal `dsh-harness`** — pengganti kedua folder lama.
   Unit systemd `dsh.service` & `dsh-proxy.service` di-update menunjuk ke
   folder baru; registry workspace dsh dikonsolidasi menjadi satu entri.

## Konsekuensi

- Satu tempat ngoding, satu tempat mulai sesi chat — tidak ada lagi
  kebingungan folder.
- Paket npm tetap dipublish dari repo ini; metadata `repository` di npm
  tidak berubah otomatis (republish per paket opsional, tidak wajib).
- Isi repo deploy yang diarsipkan tidak lagi ikut berkembang di GitHub;
  perubahannya sekarang hidup di `deploy/` repo ini (yang trackable) +
  `deploy/CLAUDE.md` (yang privat, lokal).
- Rujukan nama lama (`dsh-plugins`, `deepseek-harness`) di file yang sudah
  diarsipkan tidak diperbarui.

## Keputusan terkait

- [2026-08-15-plugin-monorepo-topology.md](2026-08-15-plugin-monorepo-topology.md)
  — topologi monorepo tetap berlaku; hanya nama repo yang berubah.
