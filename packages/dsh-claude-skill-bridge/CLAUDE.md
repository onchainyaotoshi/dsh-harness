# dsh-claude-skill-bridge — catatan untuk agent

Bridge skill & command Claude Code → DSH. **Baca ini sebelum ngoding di
paket ini.** Host-only: tidak ada UI, tidak ada route, tidak ada service yang
diprovide. Kerjaannya satu kali sinkronisasi idempoten saat boot, lalu
berhenti — loader skill tetap milik `dsh-bridges` (claude-code provider).

## Apa ini

DSH (profil web) membaca skill/command dari `~/.claude/skills` +
`~/.claude/commands` + `~/.claude/agents` (dan `<cwd>/.claude/*`) lewat
provider claude-code di `dsh-bridges`. Ia TIDAK pernah membaca
`~/.claude/plugins/cache`, dan TIDAK bisa membaca skill yang di-embed di
binary Claude Code. Plugin ini meng-reconcile aset dari DUA sumber itu ke
folder terkelola `~/.dsh/claude-bridge/`, lalu symlink ke user scope yang
tadi. Hasilnya: skill muncul di katalog sesi DAN di menu `/` composer
(`dsh-client-ui-skill` — `/name` di draft → `dsh-tool-skill` menyuntik
`<skill_content>`; host command tetap diprioritaskan kalau nama bentrok).

Source of truth versi aktif: `~/.claude/plugins/installed_plugins.json`
(field `plugins.<key>[0].installPath`). Fallback: scan
`~/.claude/plugins/cache/<marketplace>/<plugin>/` (`.in_use` dulu, lalu
semver tertinggi, lalu `unknown`).

## Cara pakai ke depan (ringkas)

- **Semuanya otomatis**: tiap boot dsh, plugin re-sync idempoten dari cache
  plugin Claude Code + binary → muncul di katalog & menu `/` DSH. Tidak perlu
  menjalankan apa pun.
- **Tambahkan plugin Claude Code lain** (mis. pr-review-toolkit): edit
  `~/.dsh/profiles/web/cordis.patch.yml` →
  `- id: claude-skill-bridge` + `config: {mirror: ["superpowers@claude-plugins-official", "...", "pr-review-toolkit@claude-plugins-official"]}`
  → restart dsh sekali → plugin-nya masuk bridge.
- **Hapus/matikan satu plugin**: keluarkan dari daftar `mirror` → restart →
  boot berikutnya entry-nya di-prune (file milik user sendiri tidak
  tersentuh).
- **Matikan seluruh bridge**: di patch profil `- {id: claude-skill-bridge, disabled: true}`
  (dan hapus override `config` bila ada) → restart → plugin berhenti sync.
  CATATAN: symlink yang sudah dibuat TIDAK ikut dibersihkan (prune hanya
  berjalan saat plugin aktif) — untuk bersih total hapus manual
  `~/.dsh/claude-bridge` + symlink di `~/.claude/skills` & `~/.claude/commands`
  yang menunjuk ke sana.
- **Aktif setelah perubahan config**: restart dsh sekali (skill `restart-dsh`);
  perubahan file di `~/.dsh/claude-bridge` TANPA restart (watcher live).

## Arsitektur & seam

```
src/index.ts        # host half: Config(mirror, extract, bridgeDir) + runSync() idempoten
cordis.patch.yml    # - insert: [{id: claude-skill-bridge, name: dsh-claude-skill-bridge}]
```

- **Config (yang dipakai "tambah/hapus plugin dari bridge")**: `mirror`
  (array `nama@marketplace`, default superpowers/frontend-design/code-review)
  dan `extract` (nama skill builtin binary, default
  artifact-design/artifact-diagramming). Ubah via `~/.dsh/profiles/web/cordis.patch.yml`:
  `- id: claude-skill-bridge` + `config: {mirror: [...]}`. Plugin di-uninstall
  dari Claude Code → entry yatim di-prune saat boot berikutnya.
- **runSync() 4 fase**: (1) copyTree per plugin (mini-rsync: skip bila
  size+mtime sama; hapus ekstra) + command flat diberi `name:` frontmatter
  (`ensureName`); (2) ekstrak builtin dari binary: cari
  `---\nname:<skill>` lalu backtick PENUTUP yang tidak di-escape, decode
  `\uXXXX`/`\``, lalu `adaptSkillText` menyuntik blok notranslate untuk skill
  di `NOTRANSLATE_SKILLS` (marker `dsh-bridge:notranslate`, idempoten)
  SEBELUM compare/write; (2b) `enforceNotranslate`: suntik blok notranslate
  ke `<name>/SKILL.md` setiap anggota `NOTRANSLATE_SKILLS` yang ada di
  bridge — mencakup jalur MIRROR (frontend-design) yang tidak lewat
  extractBuiltin; (3) symlink entry bridge → user scope (relatif, pola
  ast-grep); (4) prune symlink yatim yang resolve-nya DI DALAM bridge folder.
- **Tidak menyentuh registry skill** — tidak ada `ctx.skills`; tidak ada
  service; `inject: []`. Write-only filesystem + symlink.
- **Boot timing**: `apply()` menjalankan `void runSync().catch(log)` —
  fire-and-forget, async. Log via `ctx.logger`.
- Seam yang diverifikasi: dsh 0.1.0-rc.7 bundle dsh-bridges (claude-code
  provider), dsh-app-boot patch engine, dsh-client-ui-skill. Cek ulang bila
  dsh di-upgrade.

## Lesson learned (jangan diulang)

- **`customSkillDirs` di row `skill-filesystem` MUNGKIN GAGAL**: di profil
  web, row `skill-filesystem` di-`disabled: true` oleh bundle
  `@deepseek-ai/dsh-web-app` (diverifikasi via `dsh --profile web
  --dump-config`, 24 Aug 2026). Override config di row yang disabled = TIDAK
  berlaku. Registrasi yang hidup di profil web = user scope yang dibaca
  bridge claude-code. Selalu cek `--dump-config` SEBELUM bergantung pada
  config override row bawaan.
- **Parser beda-beda**: provider claude-code (dsh-bridges) mengambil nama
  command dari FILENAME (frontmatter `name:` tidak wajib; `description`
  opsional — fallback ke paragraf pertama); provider filesystem native
  (`dsh-skill-filesystem`) WAJIB `name:` + `description:` dan menolak key
  legacy camelCase (`userInvocable`, `modelInvocable`,
  `disableModelInvocation`). `when_to_use` (snake) adalah key yang dibaca
  bridge claude-code — jangan dinormalisasi ke `whenToUse` untuk file yang
  hidup di user scope.
- **Symlink → skill itu sah**: fs-adapter dsh-bridges memakai `stat` yang
  mengikuti symlink ("a symlinked skill directory resolves" — komentar di
  kode). Precedent: `~/.claude/skills/ast-grep` symlink.
- **Ekstraksi binary**: mulai dari `---` terakhir di ±300 byte SEBELUM
  `name:<skill>`, berhenti di backtick TANPA escape (count backslash
  parity), decode `\uXXXX` lalu `\`  → `; konten punya `\u2014` (em dash)
  dan backtick-escape. Jangan tulis ulang bila sudah identik (hash/compare).
- **Watcher live, restart hanya utk komposisi**: penambahan file/symlink di
  ~/.claude/skills langsung masuk katalog TANPA restart dsh. Restart hanya
  diperlukan saat menambah/dalam mengubah row `claude-skill-bridge` di
  profil (satu kali; skill `restart-dsh`).
- **Privasi repo**: konten skill pihak ketiga TIDAK pernah masuk repo
  (diekstrak/copy hanya runtime di machine user); kode WAJIB `homedir()` —
  tanpa path absolut `/home/*`.
- **Command Claude Code TIDAK tool-agnostik — adaptasikan via `adaptCommandText`**
  (incident 24 Aug 2026): `/code-review` asli ("Use a Haiku agent", "5 parallel
  Sonnet agents", "gh bash command") membuat agent DSH sesi restricted (hanya
  `run_code` yang langsung callable) memanggil `read`/`glob` → "unknown tool",
  lalu loop 6× "invalid arguments: missing required property description" →
  user abort. Adaptasi (hanya command `code-review`): nama model/tool → istilah
  netral (cheap subagent / full subagents / gh CLI via shell) + catatan
  toolset-agnostik di Notes. Cache Claude Code tetap ASLI — yang berubah hanya
  salinan bridge.
- **`copyTree` skip bila target lebih baru (mtime)** — edit manual di
  `~/.dsh/claude-bridge/<entry>` TIDAK tertimpa saat boot berikutnya, selama
  sumber cache tidak lebih baru. Kalau perubahan harus permanen & idempoten,
  masukkan ke logika plugin (adaptCommandText adalah contohnya — satu sumber
  di repo), bukan edit-edit manual.
- **Auto-translate browser merusak artifact → suntikkan aturan notranslate lewat
  kode, bukan edit manual** (incident 25 Aug 2026): skill `artifact-*` hasil
  ekstrak binary tidak mengatur meta anti-translate; HTML artifact yang dibuat
  agent ditawari auto-translate oleh browser — label, heading, dan teks SVG
  ke-mangle, user harus klik "Never translate this site" manual. Edit manual
  SKILL.md di bridge folder PASTI hilang (fase ekstraksi hash-compare menimpa
  dengan raw binary saat boot). Solusi: `adaptSkillText` — satu sumber di repo,
  disisipkan setelah ekstraksi sebelum compare/write, marker HTML
  `dsh-bridge:notranslate` buat idempoten; hanya salinan bridge yang berubah,
  binary tetap asli (precedent `adaptCommandText`). Perluas ke skill lain =
  tambah satu nama di `NOTRANSLATE_SKILLS`. Cakupan kini termasuk
  `frontend-design` (hasil MIRROR cache plugin, bukan ekstrak) — jalur
  mirror dijaga fase 2b `enforceNotranslate`; konsekuensinya copyTree
  menyalin ulang SKILL.md itu tiap boot (ukuran salinan ≠ sumber cache)
  lalu blok disuntik lagi: dua tulisan kecil per boot, konten tetap stabil.
- **Upgrade binary Claude Code bisa merusak pola ekstraksi — cek tiap upgrade**
  (incident 25 Aug 2026): binary 2.1.245 gagal diekstrak ("pola tidak
  ditemukan") karena `lastIndexOf('---', at-300)` hanya menemukan posisi
  ≤ at−300 — fence `---\n` yang menempel langsung di depan `name:<skill>`
  TIDAK PERNAH ketemu; di binary lama kebetulan ada `---` lain ≥300 byte
  sebelum marker, jadi sempat jalan tanpa terlihat salah. Perbaikan: cari
  `---\n` TERAKHIR dari posisi marker (wajib ≤300 byte di depannya) + loop
  SEMUA kemunculan marker dan pilih kandidat valid terpanjang (salinan tabel
  biner di tengah binary bisa menghasilkan fragmen pendek yang lolos
  validasi `startsWith('---')`). Gejala khas saat rusak: log "pola tidak
  ditemukan" tiap boot sementara salinan lama tetap tersaji — stale diam-diam.
- **`.optional()` TIDAK ADA di schemastery — jangan tulis gaya zod** (incident
  24 Aug 2026): `bridgeDir: z.string().optional()` membuat import plugin GAGAL
  saat boot -> `plugin tree failed to load` -> dsh crash-loop -> website 502.
  `@deepseek-ai/schemastery` (3.18.1, vendor fork dsh) tidak punya metode
  `.optional()`/`.nullable()` — key object schema adalah optional by default
  (disetel tanpa key => undefined), cukup `bridgeDir: z.string()`. API yang
  ada: `.default() .required() .min() .max() .pattern() .comment() dll`.
  Sebelum pakai API schema: probe `node --input-type=module -e "import z
  from '@deepseek-ai/schemastery'; console.log(typeof z.string().X)"`.
- **`dsh-claude-compat` tidak fallback ke default dir — plugin dengan manifest
  tanpa field dir hilang diam-diam** (incident 27 Aug 2026): compat 0.7.0 hanya
  scan `<installPath>/skills|commands` kalau `.claude-plugin/plugin.json`
  MENDIKLARAKAN field-nya; kalau manifest ADA tapi field-nya tidak (superpowers,
  frontend-design, claude-code-setup, remember, code-simplifier...), konten
  plugin dilewati — katalog DSH kosong untuk plugin itu padahal di Claude Code
  jalan. `agents/` tak terdampak (selalu discan tanpa cek manifest), makanya
  agent pr-review-toolkit tampil sementara skill superpowers hilang — sempat
  disalahkan ke copy manual, bukan root cause. Fix lokal (belum ada upstream):
  `cd ~/.dsh/profiles/web && pnpm patch dsh-claude-compat` → di
  `node_modules/.pnpm_patches/dsh-claude-compat@0.7.0/src/plugins.js` tambah
  fallback: `skillDirs.length === 0 && pathExists(<installPath>/skills)` →
  push default dir (sama utk `commands`, `const` → `let`) →
  `pnpm patch-commit` (tulis `patches/dsh-claude-compat.patch` +
  `patchedDependencies` di pnpm-lock.yaml → durable) → `node --check` +
  `dsh --profile web --dump-config` → restart dsh. Saat compat di-upgrade:
  cek apakah fallback sudah upstream; kalau belum pnpm patch lagi.

## Status profil web & archiving (27 Aug 2026)

- Plugin ini TIDAK lagi dipasang di profil web — jalur MIRROR digantikan
  `dsh-claude-compat` (baca `~/.claude/plugins` langsung, fresh, tanpa
  salinan). TETAP bernilai di monorepo sebagai satu-satunya pembuat dua hal
  yang tak bisa dihasilkan plugin lain: (a) `extract` builtin binary
  (artifact-design, artifact-diagramming), (b) salinan ADAPTED
  (`frontend-design` + marker notranslate; `code-review.md` tool-agnostik).
- 27 Aug 2026: `~/.dsh/claude-bridge` DIHAPUS, namun hanya setelah 4 entry
  bernilai adaptasi dipromosikan jadi file NYATA di user scope:
  `~/.claude/skills/{artifact-design,artifact-diagramming,frontend-design}`
  + `~/.claude/commands/code-review.md`. Marker `dsh-bridge:notranslate` dan
  teks adaptasi ikut terpindah (verifikasi grep; watcher live menampilkan
  keduanya di katalog tanpa restart). 14 skill superpowers = salinan verbatim
  cache → tidak dipromosikan (compat sajikan dari `~/.claude/plugins`,
  rank 750). 27 Aug 2026: compat 0.7.0 GAGAL memenuhi janji ini (lihat lesson
  learned di atas) → dipatch fallback default dir; terverifikasi 14 skill
  superpowers + claude-automation-recommender muncul di katalog.
- Resync manual bila binary/plugin berubah: `dsh plugin --profile web add
  ./packages/dsh-claude-skill-bridge` → restart dsh → sync idempoten → lepas
  lagi dari profile. EKSPEKTASI: fase (3) symlink MENGGANTI file user scope
  dengan symlink ke bridge dir (bukan bug).
- JANGAN hapus 4 entry adapted itu tanpa persiapan — satu-satunya sumber
  pengganti adalah ekstrak ulang dari binary (RAW, tanpa adaptasi
  notranslate → insiden 25 Aug 2026 bisa kembali). Pelajaran: sebelum
  mengganti/menghapus bridge lama, periksa apakah isinya ADAPTED (hash vs
  sumber cache/binary) — bukan asumsi "salinan murni".

## Verifikasi

```sh
pnpm --filter dsh-claude-skill-bridge build    # host ESM (lib/index.js, tidak ada client)
# setelah dsh plugin --profile web add ./packages/dsh-claude-skill-bridge:
dsh --profile web --dump-config | grep -A3 claude-skill-bridge   # row hadir
# restart dsh SEKALI (skill restart-dsh), lalu:
ls ~/.dsh/claude-bridge          # 14 superpowers + frontend-design + artifact-* + code-review.md
ls -la ~/.claude/skills | grep claude-bridge   # symlink bound
# UI: ketik / di composer → entry skills muncul (dsh-client-ui-skill).
# Idempotensi: systemctl restart dsh lagi → tidak ada file baru (log "selesai" tanpa copy).
#
# Tes "hapus": ubah config mirror (kosongkan) → restart → engine prune menghilangkan
# symlink milik bridge; file user sendiri tetap utuh.
```
