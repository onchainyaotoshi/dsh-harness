# dsh-harness

Monorepo plugin [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) + artefak deploy —
konsolidasi `dsh-plugins` dan `deepseek-harness-deploy` (kedua repo lama diarsipkan, lihat
[docs/decisions/2026-08-28-consolidate-repos-dsh-harness.md](docs/decisions/2026-08-28-consolidate-repos-dsh-harness.md)).
Satu repo, banyak paket npm (opsi B — lihat [ADR topologi](docs/decisions/2026-08-15-plugin-monorepo-topology.md)).

## Daftar plugin

| Paket | Deskripsi |
|---|---|
| `dsh-session-archive` | Halaman kelola sesi terarsip (Settings → Archived Sessions) + unarchive dengan dialog konfirmasi — derivatif Apache-2.0 dari MichengAI/dsh-archive-manager (tanpa fork UI, tanpa delete permanen) |
| `dsh-tunnel-loopback` | Deployment tunnel/proxy: paksa `connection.isLoopback` di client supaya persistensi settings (tema/bahasa/welcome notice) hidup saat URL browser bukan loopback — WAJIB terdaftar sebelum `@deepseek-ai/dsh-web-app` di `dsh.profile.bundles` |
| `dsh-git-state` | Strip status git (branch/perubahan/stash/worktree/PR) di atas composer |
| `dsh-copy-link-sesi` | Menu "Salin link" di baris sesi + deep-link `?session=` (buka sesi dari URL) |
| `dsh-custom-settings` | Tab Settings "Custom Settings": tunable live + cek/upgrade versi dsh |
| `dsh-claude-skill-bridge` | Bridge skill & command Claude Code → DSH (sumber extract skill builtin binary + adaptasi konten) |
| `dsh-patches` | Satu tempat semua patch deploy (workaround no-seam) + reminder Code Mode |

> **Dipensiunkan 10 Oct 2026:** `dsh-file-explorer` — panel file kini native DSH 0.2
> (`@deepseek-ai/dsh-client-ui-sidebar-files` + `dsh-api-workspace-files`). Lihat
> [ADR pensiun](docs/decisions/2026-10-10-retire-file-explorer.md).

## Struktur

- `packages/*` — plugin (satu paket npm per plugin)
- `deploy/` — artefak deploy: `loopback-proxy.mjs` (dipakai `dsh-proxy.service`) dan mockup UI
  `dsh-git-state-diagram/`. Catatan deploy privat ada di `deploy/CLAUDE.md` — file LOKAL,
  gitignored, tidak pernah di-push.

## Cara develop

```sh
pnpm install
pnpm build          # build semua paket (host half + client bundle)
pnpm watch          # watch client bundle (untuk iterasi UI)
```

## Cara test di VPS

```sh
cd dsh-harness && pnpm build
dsh plugin --profile web add ./packages/dsh-git-state
dsh --profile web --dump-config | grep git-state       # layer harus muncul
sudo systemctl restart dsh                            # SEKALI, di jeda antar turn!
```

Catatan `dsh-tunnel-loopback`: setelah `dsh plugin add`, **pindahkan manual**
entrinya di `dsh.profile.bundles` ke posisi SEBELUM `@deepseek-ai/dsh-web-app`
(`dsh plugin add` menaruh bundle baru di akhir daftar). Kalau urutannya salah,
host half plugin memperingatkan di log dan fix tidak aktif.

Verifikasi HTTP:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/plugins/dsh-git-state/client.js   # 200
# route API tiap paket terdokumentasi di packages/<nama>/CLAUDE.md
```

Iterasi UI berikutnya TANPA restart: `pnpm watch` + refresh browser
(bundle di-serve no-cache; di produksi row HMR di-omit).

## Distribusi

Repo ini **tidak menerbitkan paket ke npm** — nama `dsh-bridges`, `dsh-session-archive`,
maupun `dsh-file-explorer` sudah dipakai pihak lain di registri. Distribusinya lewat
path lokal:

```sh
dsh plugin --profile web add ./packages/<nama>
```

## Keamanan

Route API plugin lokal yang menyentuh filesystem **tidak** ikut pagar `/api` (method
PRIVILEGED), jadi satu-satunya pagar browser→host adalah **containment workspace** di
host half (`ctx.fs.contains` → 403 di luar root) plus aturan bahwa path tidak pernah
datang dari client. Aturan ini berlaku untuk SEMUA plugin lokal — jangan pernah
melemahkannya — dan UI yang mengekspos route itu wajib tetap di balik autentikasi
deployment (mis. Cloudflare Access).
