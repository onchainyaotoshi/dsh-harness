# dsh-bridges

## Apa ini

Fork kompatibilitas bridge tujuh coding agent untuk DSH 0.2.0-rc.2.
Provenance dan lisensi upstream ada di UPSTREAM.md dan LICENSE.

## Arsitektur & seam

Host-only, satu row `bridges`. Subsystem di src/agents membaca skill,
memory, hook, izin dan MCP masing-masing tool. Dependencies DSH adalah
peer agar tidak menimpa framework host. Build tsc mempertahankan struktur
modul upstream dan memungkinkan pemeriksaan tipe seluruh seam.

## Lesson learned

- Versi 0.2.4 membawa core DSH 0.1 sebagai dependencies; salinan profil
  menutupi core baru dan membuat sessionController unavailable.
- DSH 0.2 mengganti `agent/session-start` dengan `agent/created`;
  initialization harus ditunggu sebelum agent mulai menerima input.

- Source pesan sekarang memakai producer `dsh-bridges` lewat augmentasi
  MessageSourceMap, menggantikan catch-all `plugin` yang dihapus core.
- Hook Stop wajib awaited pada serial turn-stopping; fire-and-forget
  kehilangan continuation karena turn sudah ditutup.
- Nama npm `dsh-bridges` sudah dipakai upstream (yhlooo, 0.3.0), jadi paket ini
  TIDAK untuk diterbitkan: distribusinya lewat
  `dsh plugin --profile web add ./packages/dsh-bridges`. Metadata
  `repository`/`homepage`/`bugs` diarahkan ke repo monorepo ini (direktori
  packages/dsh-bridges); `author` tetap yhlooo sebagai atribusi Apache-2.0.

## Verifikasi

Unit tests memakai filesystem/session/registry mock atau proses hook lokal
yang terkontrol. Jangan jalankan hook/MCP pengguna untuk tes. Browser smoke
hanya navigasi, tanpa prompt model atau API produksi eksternal.

Verifikasi migrasi: build/typecheck host terhadap tipe 0.2 lulus, 527 unit
tests bridge dan 4 tes mock/VM plugin lokal lulus. Inventory live menunjukkan
9 custom plugins aktif tanpa fiber failed; browser console 0 error. Semua
request Ginee/Odoo tetap tidak dijalankan. Claude hook/MCP kini dimiliki
bridge; bila claude-compat juga aktif, matikan handler duplikat di config
claude-compat (enableHooks/enableMcp), bukan fungsi bridge.
