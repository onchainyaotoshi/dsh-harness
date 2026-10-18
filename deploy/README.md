# deploy — artefak deploy dsh

Artefak dari repo lama `deepseek-harness-deploy` (kini diarsipkan di GitHub),
disanitasi untuk repo publik ini.

- `loopback-proxy.mjs` — proxy loopback (tulis ulang Host/Origin) yang
  dipakai `dsh-proxy.service`, dengan bridge login Cloudflare Access opsional.
  Konfigurasi aktual (port, proses) dijelaskan di `CLAUDE.md` lokal.
- `access-auth.mjs` — validasi JWT Access dan pertukaran token DSH lokal.
- `dsh-git-state-diagram/` — mockup diagram UI plugin `dsh-git-state`.
- `CLAUDE.md` — **catatan deploy PRIVAT** (path absolut, domain, konfigurasi
  VPS) — file LOKAL (gitignored), JANGAN pernah di-push.

Catatan: patch WS heartbeat & pnpm-patch claude-compat yang dulu hidup di
repo ini sudah dipindah ke plugin `dsh-patches` (27 Aug 2026).

Bridge login diaktifkan dengan tiga environment variable pada service proxy:
`DSH_ACCESS_ISSUER=https://<team>.cloudflareaccess.com`, `DSH_ACCESS_AUD=<application-audience>`,
dan `DSH_ACCESS_HOSTNAME=<public-hostname>`. Ketiganya wajib diisi bersama.
Tanpa ketiganya, proxy mempertahankan login DSH manual.

Saat aktif, setiap request HTTP dan handshake WebSocket wajib membawa JWT
Access dengan signature RS256, issuer, audience aplikasi, type `app`, dan
masa berlaku yang benar. Host/Origin harus sesuai domain publik; request
cross-site ditolak kecuali navigasi dokumen utama `GET /` (query sesi boleh)
setelah login OTP. Pengecualian ini tetap wajib JWT valid dan tidak berlaku
untuk API, iframe, POST, atau WebSocket. Header fetch metadata diteruskan
utuh agar pagar API DSH tetap bekerja. JWKS diambil hanya dari issuer yang dikonfigurasi dan
di-cache lima menit. Jangan pernah melepas policy Access di Cloudflare.

Setelah validasi, proxy mengambil URL peluncuran dari journal PID service
`dsh.service` yang aktif dan menukarnya langsung ke loopback DSH. Cookie DSH
disimpan di memori proxy dan diperbarui paling lambat lima menit; token dan
cookie itu tidak dikirim ke browser. Pengguna cukup membuka domain biasa.
Service proxy perlu akses baca journal milik service DSH. Kegagalan validasi
Access menghasilkan 403; kegagalan pertukaran DSH menghasilkan 503.
Dengan `DSH_PROXY_LOG=1`, penolakan mencatat kode alasan tetap
(`host`, `cross-site`, `origin`, `jwt`, `dsh-session`), tanpa token atau cookie.
DSH tetap memakai autentikasi aslinya pada port langsung.

Bridge ini berada di repo deployment, di luar instalasi npm DSH. Update
paket DSH tidak menimpa kode bridge maupun environment/drop-in systemd
proxy. Saat token peluncuran berubah setelah restart DSH, pertukaran
berikutnya membaca token dari PID baru secara otomatis.

Kompatibilitas saat ini diverifikasi dengan DSH 0.2.0-rc.2. Bridge bergantung
pada URL peluncuran `http://127.0.0.1:3080/?token=...`, pertukaran HTTP 303,
dan cookie `dsh-auth-*` dengan `Max-Age`. Jika versi DSH berikutnya mengubah
kontrak ini, bridge perlu disesuaikan; kegagalan pertukaran menghasilkan
503. Setelah upgrade, periksa akses domain melalui login Access dan log
proxy, bukan hanya keberhasilan proses install.

Verifikasi terisolasi: `CONNECT_GINEE=readonly NODE_ENV=development node --test tests/access-proxy.test.mjs`.
Tes memakai kunci RSA buatan, JWKS tiruan, dan server loopback ephemeral;
tidak membaca journal atau kredensial pengguna dan tidak mengakses API luar.
