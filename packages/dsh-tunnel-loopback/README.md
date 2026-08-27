# dsh-tunnel-loopback

Plugin [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) untuk
deployment yang menyajikan Web UI lewat **tunnel / reverse proxy** — URL browser
bukan loopback, padahal request yang sampai ke dsh sudah ditulis ulang menjadi
loopback oleh proxy di depannya (contoh: cloudflared → proxy loopback → dsh).

## Masalah yang dipecahkan

Di akses non-loopback, sisi klien DSH sengaja menurunkan persistence settings
menjadi `memory` (`connection.isLoopback ? "host" : "memory"` di
`dsh-client-ui-settings`). Akibatnya dari domain publik:

- **Tema, bahasa, Composer Enter, dan welcome notice tidak persist** —
  balik ke default tiap reload.
- `SettingsDocumentStore` (settings-general) dan `WelcomeNoticeStore`
  (settings-models) juga ikut dimatikan.

Padahal server, lewat proxy yang menulis ulang `Host`, **sudah** memperlakukan
request sebagai loopback — server fence lolos, yang gagal hanya kesepakatan
loopback di browser. Plugin ini memperbaikinya: saat boot client, set
`connection.isLoopback = true` sehingga semua gate di atas mengikuti jalur
loopback.

Server-side fence **tidak** diubah: method istimewa (`settings.*`,
`host.pickDirectory`, dll.) tetap ditolak 403 oleh dsh kecuali request memang
terlihat loopback dari sisi server. Tanpa proxy penulis-ulang-Host, plugin ini
tidak membuka apa pun — settings UI hanya akan menampilkan error yang memang
ada.

## Cara kerja (dan kenapa urutan bundle penting)

1. `dsh.client.immediately = true` → shell me-prefetch bundle ini sebelum boot
   plugin, jadi fiber-nya selalu terdaftar paling awal (tidak kalah balapan
   jaringan dengan bundle lain).
2. Client half `inject: ['connection']` → menunggu service `connection`, lalu
   set `isLoopback = true` pada saat giliran aktivasinya.
3. Cordis mengaktifkan injector sesuai urutan registrasi — karena row ini
   terdaftar sebelum baris-baris `@deepseek-ai/dsh-web-app`, flip terjadi
   SEBELUM plugin settings mengikat scope-nya.

**Karena itu posisi bundle ini KRITIS:** dia harus ada SEBELUM
`@deepseek-ai/dsh-web-app` di `dsh.profile.bundles` pada `package.json` profil.

## Instalasi

> **Status: belum di-publish ke npm.** Untuk sekarang, pasang dari checkout
> monorepo via link lokal:
>
> ```sh
> dsh plugin --profile web add link:/<path checkout dsh-harness>/packages/dsh-tunnel-loopback
> ```
>
> Instruksi registry di bawah berlaku setelah paket ini di-publish.

```sh
dsh plugin --profile web add dsh-tunnel-loopback
```

lalu **edit** `~/.dsh/profiles/web/package.json` — `dsh plugin add` menaruh
bundle baru di **akhir** daftar `dsh.profile.bundles`; pindahkan entri
`dsh-tunnel-loopback` ke posisi sebelum `@deepseek-ai/dsh-web-app`:

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "dsh-tunnel-loopback",
  "@deepseek-ai/dsh-web-app"
] } }
```

lalu restart dsh sekali. Kalau urutannya salah, host half plugin ini menulis
peringatan di log (`journalctl -u dsh`) dan fix tidak aktif.

Verifikasi urutan tanpa restart:

```sh
dsh --profile web --dump-config | grep -n -B1 -A2 'dsh-tunnel-loopback\|dsh-client-connection'
```

Row `tunnel-loopback` harus muncul sebelum row `connection`.

## Verifikasi efek

1. Buka UI lewat domain tunnel.
2. Settings → Appearance → pilih Dark → reload halaman.
3. Tema harus tetap Dark (sebelumnya balik ke System).
4. Di konsol browser: log `dsh-tunnel-loopback: connection.isLoopback dipaksa true`.

## Keamanan

Plugin ini **tidak** menyentuh autentikasi maupun fence `/api` server. Ia hanya
membuat browser setuju dengan klasifikasi loopback yang sudah terjadi di sisi
server. Artinya: pasang hanya di deployment yang memang punya proxy
penulis-ulang-Host di depannya, dan jangan pernah melepas lapisan autentikasi
deployment (mis. Cloudflare Access) — itu tetap satu-satunya pagar terhadap
pemanggil asing, persis seperti sebelum plugin ini dipasang.
