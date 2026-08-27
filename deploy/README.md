# deploy — artefak deploy dsh

Artefak dari repo lama `deepseek-harness-deploy` (kini diarsipkan di GitHub),
disanitasi untuk repo publik ini.

- `loopback-proxy.mjs` — proxy loopback (tulis ulang Host/Origin) yang
  dipakai `dsh-proxy.service`. Host & target di-run di atas loopback;
  konfigurasi aktual (port, proses) dijelaskan di `CLAUDE.md` lokal.
- `dsh-git-state-diagram/` — mockup diagram UI plugin `dsh-git-state`.
- `CLAUDE.md` — **catatan deploy PRIVAT** (path absolut, domain, konfigurasi
  VPS) — file LOKAL (gitignored), JANGAN pernah di-push.

Catatan: patch WS heartbeat & pnpm-patch claude-compat yang dulu hidup di
repo ini sudah dipindah ke plugin `dsh-patches` (27 Aug 2026).
