# dsh-patches

Satu tempat untuk semua patch deploy DeepSeek Harness (workaround tanpa seam dari upstream):

- **Auto-repair saat boot** — patch bundle yang hilang setelah `npm update -g` dipasang ulang otomatis, idempoten, warn (bukan crash) kalau anchor berubah.
- **Reminder Code Mode** — prompt section yang menekan error `invalid arguments: missing required property "description"` (model lupa argumen required, terutama `tools.bash`).

Instalasi:

```sh
dsh plugin add ./path/to/dsh-patches   # lalu restart dsh
```

Catatan lengkap untuk pengembang: lihat `CLAUDE.md` di paket ini.
