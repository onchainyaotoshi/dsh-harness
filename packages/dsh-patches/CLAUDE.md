# dsh-patches — catatan untuk agent

**Satu plugin untuk SEMUA patch deploy DeepSeek Harness** (workaround tanpa
seam). Host-only: tidak ada UI, tidak ada route, tidak ada service yang
diprovide. Source of truth logika ada di `scripts/patch-core.mjs` — host half
dan CLI memakai core yang sama.

> Repo ini PUBLIK. Jangan tulis nama asli, email, path absolut `/home/*`, atau
> identitas VPS di file sini. Pakai istilah generik dan `~` untuk home.

## Apa ini

Dua jenis perbaikan yang dikelola di satu paket:

1. **Patch file (no-seam workaround)** — di-reapply otomatis saat boot dsh:
   - `ws-heartbeat-connection` — heartbeat ping WebSocket downlink
     (`@deepseek-ai/dsh-client-connection`). Mencegah edge/proxy memutus
     koneksi setelah idle ±100-120 dtk (UPGRADE /api/events.mux berulang
     tiap ~127 dtk, insiden 24 Aug 2026).
   - `ws-heartbeat-resync` — client runtime mempertahankan pending waits saat
     resync (`@deepseek-ai/dsh-client-runtime`). Kartu Plan review /
     ask_user_question hilang sendiri saat reconnect (race vs replay host).
   - `claude-compat-default-dirs` — fallback default dir saat manifest plugin
     Claude Code tidak mendeklarasikan field `skills`/`commands`
     (`dsh-claude-compat`). Insiden 27 Aug 2026: superpowers + teman-teman
     hilang dari katalog DSH padahal jalan di Claude Code.
2. **Seam fix (BUKAN patch file)** — reminder "semua argumen required" di
   Code Mode lewat `systemPrompt.section()` (API publik). Menekan error
   `invalid arguments: missing required property "description"` yang sering
   muncul karena model melupakan argumen (terutama bash `description`).

## Arsitektur & seam

```
src/index.ts            # host half: Service — (a) auto-repair SEMUA patch saat
                        # boot (queueMicrotask, marker-aware, warn bukan throw);
                        # (b) register prompt section 'tool:code-required-args'
                        # (order 151, persis sesudah tools:sdk di 150).
scripts/patch-core.mjs  # SUMBER TUNGGAL: PATCHES (id/pkg/fileRel/marker/
                        # steps/patchedSig/sigMarkerStep), patchSource (murni),
                        # resolvePatchPath, inspectPatch, applyPatch.
scripts/apply-patch.mjs # CLI manual di atas core — check/apply, idempoten.
cordis.patch.yml        # layer: - insert: [{ id: patches, name: dsh-patches }]
```

- Boot timing: `queueMicrotask` di `Service.init` — sama seperti
  `dsh-copy-link-sesi`; patch menulis file bundle yang dibaca saat request
  berikutnya, jadi tidak perlu menunggu sebelum dsh selesai boot.
- Resolusi path: `createRequire(ctx.baseUrl)` (baseUrl = dir profil, di-set
  `dsh-app-boot`). Berkat node_modules bersama (`~/.dsh/profiles/node_modules`
  yang di-link ke tree global dsh), satu resolusi menjangkau paket framework
  global MAUPUN paket profil — tanpa path absolut di kode, jadi aman saat
  versi nvm/instalasi berubah. Fallback walk-up `package.json` menangani
  paket yang tidak mengekspos `./package.json` (mis. `dsh-claude-compat`).
- Idempotensi per patch: `marker` unik. `patchedSig` + `sigMarkerStep` dipakai
  untuk patch yang SEBELUMNYA di-maintain mekanisme lain (mis. pnpm patch)
  — file sudah berubah tapi belum membawa marker kita: cukup suntik marker.
- Seam yang diverifikasi: dsh 0.1.1-rc.2 (bundle + systemPrompt + tools
  service). Cek ulang bila dsh di-upgrade (lihat "Upgrade dsh" di bawah).

## Riwayat mekanisme lama (yang DIGANTIKAN paket ini)

| Lama | Lokasi | Nasib |
|---|---|---|
| `patch-dsh-ws-heartbeat.mjs` | workspace root deploy (bukan repo) | Logic → `patch-core.mjs`; script + `ExecStartPre` dihapus |
| pnpm patch `dsh-claude-compat.patch` | `~/.dsh/profiles/web/patches/` + `patchedDependencies` di pnpm-lock | → patch ke-3 di sini; patch + entri lock dihapus |

## Upgrade dsh — apa yang terjadi

- `npm update -g` menimpa node_modules → marker-marker patch hilang (untuk
  paket framework). **Restart dsh biasa** (yang memang wajib setelah upgrade)
  → auto-repair memasang ulang. Tidak ada langkah manual.
- Kalau anchornya berubah (upstream refactor): log `ANCHOR_MISSING` per patch
  → perbarui `scripts/patch-core.mjs` (jangan ubah di tempat lain).
- Kalau suatu patch TIDAK lagi dibutuhkan (seam publik sudah ada di upstream):
  hapus entrinya dari `PATCHES` + catat di sini + cek file-nya bersih kembali.

## Menambah patch baru

1. Tentukan `marker` unik (mis. `// [dsh-patches:nama-fix]`).
2. Tulis `steps: [{ old, replacement }]` dengan indentasi TAB persis seperti
   file target (ukur byte-exact: `sed -n 'X,Yp' <file> | cat -A`).
3. Tambah entri ke `PATCHES` di `patch-core.mjs`.
4. `node scripts/apply-patch.mjs` → cek status; restart dsh; verifikasi marker
   di file target + baris log host half.
5. Catat alasan seam-nya tidak ada (kenapa butuh patch) di bagian ini.

## Lesson learned (jangan diulang)

- **Service subclass WAJIB `static provide` unik** (insiden 27 Aug 2026 — boot
  crash-loop): kelas `extends Service` TANPA `provide` didaftarkan cordis dengan
  nama `undefined`. `dsh-copy-link-sesi` sudah memakai jalur itu, sehingga
  plugin KEDUA yang serupa (paket ini, waktu itu tanpa provide) menabrak:
  `plugin tree failed to load ... service "undefined" has been registered at
  <SessionLinkHost>` → dsh crash-loop → website down ±5 menit. Fix:
  `static provide = 'dsh.patches.host'` (nama unik). Pelajaran: plugin host
  baru di profil web HARUS punya `provide` bila `extends Service`.
- **Boot INFO tidak selalu tampil di journal** — verifikasi efektif patch
  lewat check marker file (`apply-patch.mjs --check`), bukan log.
- **`dsh plugin --profile web add` menjalankan pnpm install profil** — kalau di
  profil masih ada `patchedDependencies` untuk paket yang akan dipatch plugin
  ini, pnpm GAGAL (patch bentrok) dan registrasi rollback total. Urutan aman:
  cabut pnpm patch (patch file + `patchedDependencies` di `pnpm-workspace.yaml`
  + lockfile) DULU, baru registrasi plugin.

## Verifikasi

```sh
pnpm --filter dsh-patches build            # build host ESM (lib/index.js)
node scripts/apply-patch.mjs --check       # 0 = semua terpasang, 1 = ada pending/anchor rusak
node scripts/apply-patch.mjs               # pasang semua (idempoten)
# setetelah dsh plugin --profile web add ./packages/dsh-patches:
dsh --profile web --dump-config | grep -A3 'patches'     # row hadir
# restart dsh (skill restart-dsh), lalu:
#   journalctl -u dsh | grep dsh-patches                  # baris info/warn per patch
#   grep -c marker tiap file target                        # = 1
# UI: jalankan Code Mode (PTC) → prompt sesi memuat section
#   '## Required arguments in run_code programs' (cek via Trajectory / session log).
# Migrasi setelah verifikasi:
#   - hapus ExecStartPre patch lama dari unit dsh.service + daemon-reload
#   - hapus ~/.dsh/profiles/web/patches/dsh-claude-compat.patch + entri
#     patchedDependencies di pnpm-lock.yaml
```

## Migrasi 7 Oct 2026 — DSH 0.2.0-rc.2

DSH 0.2 memiliki heartbeat sendiri di `dsh-api-gateway`
dan tidak lagi memiliki paket `dsh-client-runtime`; kedua patch WS 0.1
sudah dipensiunkan. Patch aktif menangani fallback direktori Claude,
admission metadata sumber Claude lama, serta producer pesan Claude native.
Nama mode tool berubah `code` → `ptc`; jangan mengasumsikan nama/argumen tool
lama tetap berlaku setelah upgrade. Verifikasi marker patch terpisah dari
hasil boot browser.

## History lama setelah upgrade 7 Oct 2026

Log v0 bisa berisi source `{kind: "claude-compat", form: "rules"}` hasil
backport plugin. Migrator v2→v3 punya allowlist producer lama yang belum
memuat shape ini. Patch `session-legacy-claude-source` mengizinkan HANYA
kind tersebut, form rules/hook-context, dan tepat dua key; metadata tambahan
yang mungkin berisi koordinat tetap ditolak. Migrasi v3→v4 mempertahankan
source direct tersebut. Jangan menonaktifkan validasi semua source/event
dan jangan menghapus pesan atau mengganti identitas sesi.

`dsh-claude-compat@0.8.3` masih mengeluarkan wrapper plugin lama meski peers
bertanda wildcard. Patch rules/hook source menggunakan kind claude-compat
yang native di v4. Dedupe rules mengenali bentuk legacy, direct, dan
plugin-prefixed hasil migrasi. Compatibility gate bukan bukti perilaku API.

Paket format internal tidak tersedia langsung di profile resolver; resolve
melalui paket pemilik dsh-session. Jalankan CLI patch sebelum restart agar
module yang sudah diimport tidak memakai fungsi migrator lama.

Verifikasi history harus menunggu loading history selesai, bukan hanya
header/slot plugin siap. Tes offline memakai catalog resmi, recovery strict
dan validation current; bandingkan isi SEMUA pesan sebelum/sesudah migrasi.
Backup raw log dulu. Artefak/titel/path privat hanya dicatat di deploy lokal.
