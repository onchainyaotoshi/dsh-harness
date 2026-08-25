/**
 * dsh-claude-skill-bridge — host half (tanpa UI, tanpa route).
 *
 * DSH (profil web) TIDAK membaca cache plugin Claude Code dan TIDAK bisa
 * membaca skill yang di-embed di binary Claude Code. Plugin ini menjembatani:
 * saat boot (sekali, idempoten) ia meng-reconcile:
 *
 *   1. Asset plugin Claude Code yang di-allowlist (config `mirror`, default:
 *      superpowers/frontend-design/code-review) dari
 *      `~/.claude/plugins/installed_plugins.json` (installPath authoritative)
 *      → dicopy ke `~/.dsh/claude-bridge/` (folder sumber yang dikelola).
 *   2. Skill builtin Claude Code (default: artifact-design,
 *      artifact-diagramming) yang hanya ada DI DALAM binary
 *      (`~/.local/bin/claude`) → diekstrak via pola frontmatter
 *      `---\nname:<skill>` … backtick penutup → SKILL.md di bridge folder.
 *   3. Symlink tiap entry bridge folder ke user scope yang SUDAH dibaca DSH:
 *      `~/.claude/skills/<name>`, `~/.claude/commands/<name>.md`,
 *      `~/.claude/agents/<name>.md` (bridge claude-code provider dsh-bridges,
 *      stat mengikuti symlink — precedent ast-grep).
 *   4. Prune symlink yatim milik plugin (menunjuk ke bridge folder tapi
 *      entrynya sudah hilang) — tidak pernah menyentuh milik user sendiri.
 *
 * Setelah itu, watcher skill DSH menampilkan semuanya di katalog dan menu '/'
 * composer. Plugin TIDAK menyentuh registry skill — loader tetap dsh-bridges.
 *
 * KEAMANAN/PRIVASI: hanya path user-scope di bawah homedir; pencabutan symlink
 * hanya untuk yang resolve-nya DI DALAM bridge folder. Konten skill pihak
 * ketiga TIDAK masuk repo — hanya di mesin user.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

export const name = 'claude-skill-bridge'
export const inject: string[] = []

export const Config = z.object({
  /** Plugin Claude Code yang di-mirror, format `nama@marketplace`. */
  mirror: z.array(z.string()).default([
    'superpowers@claude-plugins-official',
    'frontend-design@claude-plugins-official',
    'code-review@claude-plugins-official',
  ]),
  /** Nama skill builtin yang diekstrak dari binary Claude Code. */
  extract: z.array(z.string()).default(['artifact-design', 'artifact-diagramming']),
  /** Override folder sumber bridge (default `~/.dsh/claude-bridge`). */
  // Key object schemastery memang optional by default — TANPA `.optional()`
  // (API itu gaya zod; schemastery 3.18 tidak punya, crash boot — 24 Aug 2026).
  bridgeDir: z.string(),
})

/* ------------------------------------------------------------------ */
/* Path & util                                                          */
/* ------------------------------------------------------------------ */

function claudeDir(): string {
  return join(homedir(), '.claude')
}
function bridgeDir(config: { bridgeDir?: string }): string {
  const p = config.bridgeDir ?? join(homedir(), '.dsh', 'claude-bridge')
  return isAbsolute(p) ? p : join(homedir(), p)
}
function numKey(name: string): number {
  const parts = name.split('.').map((n) => parseInt(n, 10) || 0)
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0)
}

function pickVersionDir(base: string): string | undefined {
  try {
    const dirs = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    if (dirs.length === 0) return undefined
    const inUse = dirs.filter((d) => existsSync(join(base, d, '.in_use')))
    if (inUse.length > 0) {
      inUse.sort((a, b) => (numKey(a) < numKey(b) ? 1 : numKey(a) > numKey(b) ? -1 : 0))
      return inUse[0]
    }
    const semver = dirs.filter((d) => /^\d+\.\d+\.\d+/.test(d))
    if (semver.length > 0) {
      semver.sort((a, b) => (numKey(a) < numKey(b) ? 1 : numKey(a) > numKey(b) ? -1 : 0))
      return semver[0]
    }
    return dirs.includes('unknown') ? 'unknown' : dirs[0]
  } catch {
    return undefined
  }
}

/** Resolution installPath aktif: installed_plugins.json dulu, fallback scan cache. */
function resolveInstallPath(mirrorKey: string): string | undefined {
  const at = mirrorKey.indexOf('@')
  const pluginName = at >= 0 ? mirrorKey.slice(0, at) : mirrorKey
  const marketplace = at >= 0 ? mirrorKey.slice(at + 1) : 'claude-plugins-official'
  try {
    const file = join(claudeDir(), 'plugins', 'installed_plugins.json')
    if (existsSync(file)) {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as {
        plugins?: Record<string, Array<{ installPath?: string }>>
      }
      const hit = doc.plugins?.[mirrorKey]?.[0]
      if (hit?.installPath) return hit.installPath
    }
  } catch {
    /* jatuh ke scan cache */
  }
  const base = join(claudeDir(), 'plugins', 'cache', marketplace, pluginName)
  const version = pickVersionDir(base)
  return version === undefined ? undefined : join(base, version)
}

/** Copy tree mini-rsync: skip identik (size+mtime), copy baru/berubah, hapus ekstra. */
function copyTree(srcDir: string, dstDir: string): string[] {
  const copied: string[] = []
  mkdirSync(dstDir, { recursive: true })
  const entries = readdirSync(srcDir, { withFileTypes: true })
  const keep = new Set<string>()
  for (const entry of entries) {
    keep.add(entry.name)
    const src = join(srcDir, entry.name)
    const dst = join(dstDir, entry.name)
    if (entry.isDirectory()) {
      copied.push(...copyTree(src, dst))
      continue
    }
    let need = !existsSync(dst)
    if (!need) {
      const s = lstatSync(src)
      const d = lstatSync(dst)
      need = s.size !== d.size || s.mtimeMs > d.mtimeMs + 1
    }
    if (need) {
      copyFileSync(src, dst)
      copied.push(dst)
    }
  }
  for (const found of readdirSync(dstDir)) {
    if (!keep.has(found)) rmSync(join(dstDir, found), { recursive: true, force: true })
  }
  return copied
}

/** Command Claude Code: pastikan frontmatter punya `name:` (parser FS butuh).
 *  Bridge claude-code memakai nama dari filename, field ini aman untuk keduanya. */
function ensureName(frontmatter: string, name: string): string {
  if (/^name:/m.test(frontmatter)) return frontmatter
  if (frontmatter.startsWith('---\n')) {
    return `---\nname: ${name}\n` + frontmatter.slice(4)
  }
  return `---\nname: ${name}\ndescription: ${name}\n---\n${frontmatter}`
}

/** Adaptasi tool-agnostik untuk command Claude Code — protokol asli dipertahankan,
 *  nama-nama tool/model khusus Claude Code diganti dengan istilah netral yang
 *  sama-sama dimengerti Claude Code (Agent/subagent) dan DSH (subagent/workflow).
 *  Latar belakang (incident 24 Aug 2026): /code-review asli ("Use a Haiku agent",
 *  "5 parallel Sonnet agents", "gh bash command") membuat agent DSH memanggil
 *  tool dengan argumen yang salah / tool yang tidak tersedia langsung di sesi
 *  restricted (hanya run_code yang langsung callable). */
function adaptCommandText(name: string, text: string): string {
  let out = text
  out = out.replace(/Haiku agent/gi, 'cheap subagent')
  out = out.replace(/Sonnet agents/gi, 'full subagents')
  out = out.replace(/Sonnet agent/gi, 'full subagent')
  out = out.replace(/gh bash command/gi, 'gh CLI via your shell (in presets where only the code/run tool is directly callable, run it inside that tool)')
  out = out.replace(
    /- Make a todo list first/,
    '- Make a todo list first\n- Tools are toolset-agnostic: access files and gh via your shell/code-runner tool, and delegate parallel passes to subagents (each tool call needs its required fields, e.g. `description` for subagent calls)',
  )
  return name === 'code-review' ? out : text
}

/* ------------------------------------------------------------------ */
/* Adaptasi skill builtin: aturan notranslate                           */
/* ------------------------------------------------------------------ */

/** Skill yang salinan bridge-nya wajib membawa aturan notranslate.
 *  Nama = nama entry di bridge folder. Perluas cakupan = tambah satu nama. */
const NOTRANSLATE_SKILLS = new Set(['artifact-design', 'artifact-diagramming', 'frontend-design'])

/** Marker idempotensi — dipakai adaptSkillText agar blok tidak dobel. */
const NOTRANSLATE_MARKER = 'dsh-bridge:notranslate'

/** Blok aturan yang disuntikkan ke ujung SKILL.md salinan bridge. */
const NOTRANSLATE_BLOCK = `## Never-translate meta — mandatory

<!-- dsh-bridge:notranslate -->

Every published HTML artifact MUST include this tag inside \`<head>\`:

\`\`\`html
<meta name="google" content="notranslate">
\`\`\`

and MUST set \`translate="no"\` on the opening \`<html>\` tag. These pages are
typographic and diagrammatic work: browser auto-translate rewrites headings,
labels, and inline-SVG \`<text>\`, breaking layout and meaning. Never publish an
artifact without it — the reader must never have to click "Never translate
this site" by hand.
`

/** Suntik aturan notranslate ke salinan bridge skill tertentu (idempoten via
 *  marker). Binary/cache asli tidak pernah berubah — hanya SKILL.md di
 *  bridge folder, pola adaptCommandText. Wajib lewat kode: edit manual di
 *  bridge folder ditimpa fase ekstraksi (hash-compare) saat boot. */
function adaptSkillText(name: string, text: string): string {
  if (!NOTRANSLATE_SKILLS.has(name)) return text
  if (text.includes(NOTRANSLATE_MARKER)) return text
  return text.replace(/\s*$/, '') + '\n' + NOTRANSLATE_BLOCK
}

/** Fase 2b: pastikan SETIAP anggota NOTRANSLATE_SKILLS yang ada di bridge
 *  membawa blok — mencakup jalur MIRROR (mis. frontend-design dari cache
 *  plugin) yang tidak melewati extractBuiltin. Catatan: karena ukuran
 *  salinan ≠ sumber cache, copyTree menyalin ulang tiap boot lalu blok
 *  disuntik lagi — dua tulisan kecil per boot, konten tetap stabil. */
function enforceNotranslate(bridge: string, log: (m: string) => void): void {
  for (const name of NOTRANSLATE_SKILLS) {
    const out = join(bridge, name, 'SKILL.md')
    try {
      if (!existsSync(out)) continue
      const before = readFileSync(out, 'utf8')
      const after = adaptSkillText(name, before)
      if (after !== before) {
        writeFileSync(out, after)
        log(`notranslate ${name}: blok disuntik`)
      }
    } catch (error) {
      log(`notranslate ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Salin asset satu plugin ke bridge folder. */
function mirrorPlugin(installPath: string, bridge: string): string[] {
  const copied: string[] = []
  const skillsDir = join(installPath, 'skills')
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (e.isDirectory()) copied.push(...copyTree(join(skillsDir, e.name), join(bridge, e.name)))
      else if (e.name.endsWith('.md')) {
        const dst = join(bridge, e.name)
        writeFileSync(dst, readFileSync(join(skillsDir, e.name), 'utf8'))
        copied.push(dst)
      }
    }
  }
  const commandsDir = join(installPath, 'commands')
  if (existsSync(commandsDir)) {
    const walk = (src: string, rel: string) => {
      for (const e of readdirSync(src, { withFileTypes: true })) {
        const s = join(src, e.name)
        const r = rel === '' ? e.name : `${rel}-${e.name}`
        if (e.isDirectory()) walk(s, r)
        else if (e.name.endsWith('.md')) {
          // grup nested: opsx/explore.md → opsx-explore.md (kebab, aman kedua parser)
          const dst = join(bridge, r.replace(/\.md$/, '') + '.md')
          const text = readFileSync(s, 'utf8')
          writeFileSync(dst, adaptCommandText(r.replace(/\.md$/, ''), ensureName(text, r.replace(/\.md$/, ''))))
          copied.push(dst)
        }
      }
    }
    walk(commandsDir, '')
  }
  const agentsDir = join(installPath, 'agents')
  if (existsSync(agentsDir)) {
    const out = join(bridge, 'agents')
    mkdirSync(out, { recursive: true })
    for (const e of readdirSync(agentsDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) {
        copyFileSync(join(agentsDir, e.name), join(out, e.name))
        copied.push(join(out, e.name))
      }
    }
  }
  return copied
}

/* ------------------------------------------------------------------ */
/* Ekstraksi skill builtin dari binary Claude Code                      */
/* ------------------------------------------------------------------ */

function findBinary(): string | undefined {
  const link = join(homedir(), '.local', 'bin', 'claude')
  try {
    if (existsSync(link)) {
      const target = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : link
      const resolved = isAbsolute(target) ? target : join(dirname(link), target)
      if (existsSync(resolved)) return resolved
    }
  } catch {
    /* lanjut fallback */
  }
  const versions = join(homedir(), '.local', 'share', 'claude', 'versions')
  try {
    const files = readdirSync(versions)
      .filter((n) => {
        try {
          return lstatSync(join(versions, n)).isFile()
        } catch {
          return false
        }
      })
      .sort((a, b) => (numKey(a) < numKey(b) ? 1 : numKey(a) > numKey(b) ? -1 : 0))
    for (const f of files) if (existsSync(join(versions, f))) return join(versions, f)
  } catch {
    /* tidak ada */
  }
  return undefined
}

function decodeJsEscapes(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\')
}

/** Ekstrak konten skill `skillName` dari binary (template literal: backtick
 *  penutup yang TIDAK di-escape). Semua kemunculan `name:<skill>` diprobe,
 *  kandidat valid TERPANJANG yang menang — salinan tabel biner bisa
 *  menghasilkan fragmen pendek yang lolos validasi awal. */
function extractFromBinary(data: Buffer, skillName: string): string | undefined {
  const marker = Buffer.from(`name: ${skillName}\n`)
  const fence = Buffer.from('---\n')
  let best: string | undefined
  let from = 0
  for (;;) {
    const at = data.indexOf(marker, from)
    if (at < 0) break
    from = at + 1
    // Fence pembuka: `---\n` TERAKHIR sebelum marker, wajib ≤300 byte di
    // depannya (dulu lastIndexOf('---', at-300) — hanya menemukan posisi
    // ≤ at-300, fence yang menempel di depan tak pernah ketemu; incident 25 Aug).
    const start = data.lastIndexOf(fence, at)
    if (start < 0 || at - start > 300) continue
    let i = start
    while (i < data.length) {
      if (data[i] === 0x60) {
        let backslashes = 0
        for (let j = i - 1; j >= 0 && data[j] === 0x5c; j--) backslashes++
        if (backslashes % 2 === 0) {
          const decoded = decodeJsEscapes(data.subarray(start, i).toString('utf8'))
          if (decoded.startsWith('---') && decoded.includes(`name: ${skillName}`)) {
            if (best === undefined || decoded.length > best.length) best = decoded
          }
          break
        }
      }
      i++
    }
  }
  return best
}

function extractBuiltin(skillName: string, bridge: string, log: (m: string) => void): boolean {
  const binary = findBinary()
  if (binary === undefined) {
    log(`extract ${skillName}: binary claude tidak ditemukan — skip`)
    return false
  }
  try {
    const data = readFileSync(binary)
    const raw = extractFromBinary(data, skillName)
    if (raw === undefined) {
      log(`extract ${skillName}: pola tidak ditemukan di ${binary} — skip`)
      return false
    }
    // Adaptasi salinan bridge (notranslate) SEBELUM compare/write — sehingga
    // boot berikutnya hash-compare cocok dan tidak menimpa ulang.
    const body = adaptSkillText(skillName, raw)
    const out = join(bridge, skillName, 'SKILL.md')
    if (!existsSync(out) || readFileSync(out, 'utf8') !== body) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, body)
      log(`extract ${skillName}: SKILL.md ditulis (${body.length} char)`)
    }
    return true
  } catch (error) {
    log(`extract ${skillName}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Symlink phase & prune                                                */
/* ------------------------------------------------------------------ */

/** Buat/luruskan symlink `linkPath` → `target`. Skip bila target adalah
 *  file/dir NYATA milik user (bukan symlink) — JANGAN timpa. */
function ensureSymlink(linkPath: string, target: string, log: (m: string) => void): boolean {
  mkdirSync(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath)) {
    try {
      if (!lstatSync(linkPath).isSymbolicLink()) {
        log(`symlink ${linkPath}: target nyata milik user — skip`)
        return false
      }
      const current = readlinkSync(linkPath)
      if (current === relative(dirname(linkPath), target)) return true
      unlinkSync(linkPath)
    } catch {
      unlinkSync(linkPath)
    }
  }
  symlinkSync(relative(dirname(linkPath), target), linkPath)
  return true
}

/** Hapus symlink milik bridge yang entry sumbernya sudah tidak ada. */
function pruneLinks(scopeDir: string, bridge: string, valid: (resolved: string) => boolean, log: (m: string) => void): number {
  const bridgePrefix = bridge.endsWith('/') ? bridge : bridge + '/'
  let removed = 0
  try {
    for (const e of readdirSync(scopeDir, { withFileTypes: true })) {
      const p = join(scopeDir, e.name)
      if (e.isDirectory()) {
        try {
          for (const f of readdirSync(p)) {
            const fp = join(p, f)
            if (!lstatSync(fp).isSymbolicLink()) continue
            const ref = readlinkSync(fp)
            if (ref.startsWith('..') || isAbsolute(ref)) continue
            const resolved = join(dirname(fp), ref)
            if (!resolved.startsWith(bridgePrefix)) continue
            if (!valid(resolved)) {
              unlinkSync(fp)
              removed++
              log(`prune: ${fp}`)
            }
          }
        } catch {
          /* bukan dir grup */
        }
        continue
      }
      if (!lstatSync(p).isSymbolicLink()) continue
      const ref = readlinkSync(p)
      if (ref.startsWith('..') || isAbsolute(ref)) continue
      const resolved = join(dirname(p), ref)
      if (!resolved.startsWith(bridgePrefix)) continue
      if (!valid(resolved)) {
        unlinkSync(p)
        removed++
        log(`prune: ${p}`)
      }
    }
  } catch {
    /* scope tidak ada */
  }
  return removed
}

/* ------------------------------------------------------------------ */
/* Sync utama                                                           */
/* ------------------------------------------------------------------ */

export async function runSync(ctx: Context, config: { mirror?: string[]; extract?: string[]; bridgeDir?: string }): Promise<void> {
  const bridge = bridgeDir(config)
  const log = (m: string) => ctx.logger.info(`claude-skill-bridge: ${m}`)

  mkdirSync(bridge, { recursive: true })

  // 1) mirror plugin
  for (const key of config.mirror ?? []) {
    const installPath = resolveInstallPath(key)
    if (installPath === undefined) {
      log(`mirror ${key}: installPath tidak ditemukan — skip`)
      continue
    }
    const copied = mirrorPlugin(installPath, bridge)
    log(`mirror ${key}: ${copied.length} file disinkronkan (${installPath})`)
  }

  // 2) builtin binary
  for (const skillName of config.extract ?? []) {
    extractBuiltin(skillName, bridge, log)
  }

  // 2b) notranslate untuk jalur mirror (tidak lewat extractBuiltin)
  enforceNotranslate(bridge, log)

  // 3) symlink bridge → user scope
  const skillsScope = join(claudeDir(), 'skills')
  const commandsScope = join(claudeDir(), 'commands')
  const agentsScope = join(claudeDir(), 'agents')
  let linked = 0
  for (const e of readdirSync(bridge, { withFileTypes: true })) {
    if (e.name === 'agents') continue
    if (e.isDirectory()) {
      if (ensureSymlink(join(skillsScope, e.name), join(bridge, e.name), log)) linked++
    } else if (e.name.endsWith('.md')) {
      if (ensureSymlink(join(commandsScope, e.name), join(bridge, e.name), log)) linked++
    }
  }
  const agentsBridge = join(bridge, 'agents')
  if (existsSync(agentsBridge)) {
    for (const f of readdirSync(agentsBridge)) {
      if (f.endsWith('.md') && ensureSymlink(join(agentsScope, f), join(agentsBridge, f), log)) linked++
    }
  }

  // 4) prune yatim: skill bundle (dir) & flat command (file)
  pruneLinks(skillsScope, bridge, (resolved) => existsSync(resolved), log)
  pruneLinks(commandsScope, bridge, (resolved) => existsSync(resolved), log)
  pruneLinks(agentsScope, bridge, (resolved) => existsSync(resolved), log)

  log(`selesai: ${linked} symlink aktif`)
}

export function apply(ctx: Context, config: { mirror?: string[]; extract?: string[]; bridgeDir?: string } = {}): void {
  void runSync(ctx, config).catch((error) => {
    ctx.logger.error(`claude-skill-bridge: sync gagal: ${error instanceof Error ? error.message : String(error)}`)
  })
}
