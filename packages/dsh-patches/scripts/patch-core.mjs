/**
 * patch-core.mjs — sumber tunggal SEMUA patch deploy DeepSeek Harness
 * (workaround tanpa seam) yang dikelola plugin `dsh-patches`.
 *
 * Dipakai oleh:
 * - scripts/apply-patch.mjs  → CLI manual (--check / pasang / target profil)
 * - src/index.ts (host half) → auto-repair saat boot dsh: kalau patch hilang
 *   (biasanya karena dsh di-upgrade), host half memasang ulang sendiri;
 *   kalau anchor tidak cocok, warn loud (TIDAK pernah menggagalkan boot).
 *
 * JANGAN duplikasi konstanta/logika ini di tempat lain — file ini satu-satunya
 * sumber kebenaran. Anchor pakai indentasi TAB persis seperti bundle.
 *
 * Konsep per patch:
 * - `marker`: string yang menandai file sudah ter-patch (idempotensi).
 * - `steps`: daftar { old → replacement } yang dijalankan berurutan pada
 *   file PRISTINE (belum ter-patch). Semua old harus ketemu, kalau satu saja
 *   tidak → ANCHOR_MISSING (versi file berubah di upgrade dsh).
 * - `patchedSig` + `sigMarkerStep` (opsional): untuk patch yang sebelumnya
 *   di-maintain mekanisme lain (mis. pnpm patch) sehingga file sudah berubah
 *   TAPI belum membawa marker kita. `patchedSig` = potongan teks khas hasil
 *   patch; kalau ketemu → cukup suntik marker lewat `sigMarkerStep`.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STATUS = {
  INSTALLED: 'installed',
  APPLIED: 'applied',
  ANCHOR_MISSING: 'anchor-missing',
  NOT_FOUND: 'not-found',
}

// DSH 0.2 owns WebSocket heartbeats in api-gateway. Claude directory discovery
// and admission of audited legacy Claude message sources still need patches.
const COMPAT = {
  id: 'claude-compat-default-dirs',
  pkg: 'dsh-claude-compat',
  fileRel: 'src/plugins.js',
  marker: '// [dsh-patches:claude-compat-default-dirs]',
  patchedSig: `if (skillDirs.length === 0 && await pathExists(join(installPath, 'skills'))) skillDirs.push(join(installPath, 'skills'));`,
  sigMarkerStep: {
    old: `// Claude Code falls back to the default dirs when the manifest omits a`,
    replacement: `// [dsh-patches:claude-compat-default-dirs] Claude Code falls back to the default dirs when the manifest omits a`,
  },
  steps: [
    {
      old: `      const skillDirs = manifestDirs(manifest, 'skills', installPath);
      for (const dir of skillDirs) push('skills')(await discoverSkills(dir, providerName, source, rank));
      const commandsDir = typeof manifest.commands === 'string' ? resolve(installPath, manifest.commands) : undefined;`,
      replacement: `      const skillDirs = manifestDirs(manifest, 'skills', installPath);
      // [dsh-patches:claude-compat-default-dirs] Claude Code falls back to the default dirs when the manifest omits a
      // dir field (e.g. superpowers, frontend-design) — mirror that instead of
      // silently dropping the plugin's skills/commands.
      if (skillDirs.length === 0 && await pathExists(join(installPath, 'skills'))) skillDirs.push(join(installPath, 'skills'));
      for (const dir of skillDirs) push('skills')(await discoverSkills(dir, providerName, source, rank));
      let commandsDir = typeof manifest.commands === 'string' ? resolve(installPath, manifest.commands) : undefined;
      if (commandsDir === undefined && await pathExists(join(installPath, 'commands'))) commandsDir = join(installPath, 'commands');`,
    },
  ],
}

const LEGACY_CLAUDE_SOURCE = {
  id: 'session-legacy-claude-source',
  pkg: '@deepseek-ai/dsh-session-format-v2-to-v3',
  resolveFrom: '@deepseek-ai/dsh-session',
  fileRel: 'lib/index.js',
  marker: '// [dsh-patches:session-legacy-claude-source]',
  steps: [{
    old: `function assertSource(message) {
\tconst source = record(message["source"], "message source");`,
    replacement: `function assertSource(message) {
\tconst source = record(message["source"], "message source");
\t// [dsh-patches:session-legacy-claude-source]
\t// Released Claude compatibility rules/hook context has no event coordinates.
\t// Admit only the audited exact shape; leave every other unknown source refused.
\tif (source["kind"] === "claude-compat" && Object.keys(source).length === 2 &&
\t\t(source["form"] === "rules" || source["form"] === "hook-context")) return;`,
  }],
}

const COMPAT_MESSAGE_SOURCE = {
  id: 'claude-compat-message-source',
  pkg: 'dsh-claude-compat',
  fileRel: 'src/index.js',
  marker: '// [dsh-patches:claude-compat-message-source]',
  steps: [
    {
      old: `    const present = (list) => list.some((m) => m?.source?.kind === 'plugin' && m.source.plugin === 'dsh-claude-compat');`,
      replacement: `    // [dsh-patches:claude-compat-message-source]
    const isCompatSource = (source) => ['claude-compat', 'dsh-claude-compat', 'plugin:dsh-claude-compat', 'plugin:claude-compat'].includes(source?.kind)
      || (source?.kind === 'plugin' && source.plugin === 'dsh-claude-compat');
    const present = (list) => list.some((m) => isCompatSource(m?.source));`,
    },
    {
      old: `          && event.data?.source?.kind === 'plugin'
          && event.data.source.plugin === 'dsh-claude-compat';`,
      replacement: `          && isCompatSource(event.data?.source);`,
    },
    {
      old: `source: { kind: 'plugin', plugin: 'dsh-claude-compat', form: 'rules' },`,
      replacement: `source: { kind: 'claude-compat', form: 'rules' },`,
    },
  ],
}

const COMPAT_HOOK_SOURCE = {
  id: 'claude-compat-hook-source',
  pkg: 'dsh-claude-compat',
  fileRel: 'src/hooks.js',
  marker: '// [dsh-patches:claude-compat-hook-source]',
  steps: [
    {
      old: `import { createUserMessage } from '@deepseek-ai/dsh-llm';`,
      replacement: `// [dsh-patches:claude-compat-hook-source]
import { createUserMessage } from '@deepseek-ai/dsh-llm';`,
    },
    ...Array.from({ length: 2 }, () => ({
      old: `source: { kind: 'plugin', plugin: 'dsh-claude-compat', form: 'hook-context' },`,
      replacement: `source: { kind: 'claude-compat', form: 'hook-context' },`,
    })),
  ],
}

export const PATCHES = [COMPAT, LEGACY_CLAUDE_SOURCE, COMPAT_MESSAGE_SOURCE, COMPAT_HOOK_SOURCE]

/**
 * Proses satu file untuk satu patch. Murni (tanpa IO): caller yang menulis.
 * @param {string} source isi file
 * @param {object} patch definisi patch (dari PATCHES)
 * @returns {{ status: string, source: string }}
 */
export function patchSource(source, patch) {
  if (source.includes(patch.marker)) return { status: STATUS.INSTALLED, source }
  if (patch.patchedSig !== undefined && source.includes(patch.patchedSig)) {
    if (patch.sigMarkerStep !== undefined) {
      if (!source.includes(patch.sigMarkerStep.old)) return { status: STATUS.ANCHOR_MISSING, source }
      return {
        status: STATUS.APPLIED,
        source: source.replace(patch.sigMarkerStep.old, patch.sigMarkerStep.replacement),
      }
    }
    return { status: STATUS.INSTALLED, source }
  }
  let next = source
  for (const step of patch.steps) {
    if (!next.includes(step.old)) return { status: STATUS.ANCHOR_MISSING, source }
    next = next.replace(step.old, step.replacement)
  }
  return { status: STATUS.APPLIED, source: next }
}

/**
 * Resolusi path file target satu patch dari sebuah baseUrl (biasanya dir
 * profil). Bekerja untuk paket framework global MAUPUN paket profil berkat
 * node_modules bersama (mis. ~/.dsh/profiles/node_modules yang di-link ke
 * tree global dsh).
 * @param {object} patch definisi patch
 * @param {string} baseUrl base URL / jalur file yang dipakai createRequire
 * @returns {string} jalur absolut file target
 */
export function resolvePatchPath(patch, baseUrl) {
  let require = createRequire(baseUrl)
  // Internal format packages are reached through their owning Host package,
  // which may be globally installed rather than listed directly in a profile.
  if (patch.resolveFrom !== undefined) {
    require = createRequire(require.resolve(patch.resolveFrom))
  }
  let root
  try {
    // Sebagian paket mengekspos "./package.json" di exports.
    root = dirname(require.resolve(`${patch.pkg}/package.json`))
  } catch {
    // Kalau tidak (mis. dsh-claude-compat hanya "."): resolve entry utama lalu
    // naik sampai package.json ditemukan.
    let dir = dirname(require.resolve(patch.pkg))
    while (!existsSync(join(dir, 'package.json'))) {
      const parent = dirname(dir)
      if (parent === dir) throw new Error(`cannot locate package root for ${patch.pkg}`)
      dir = parent
    }
    root = dir
  }
  return join(root, patch.fileRel)
}

/**
 * Baca file target + patchSource tanpa menulis. `source` berisi hasil
 * transformasi (sama dengan isi file bila status INSTALLED / ANCHOR_MISSING).
 * @returns {{ patch, path, status, exists, source }}
 */
export function inspectPatch(patch, baseUrl, readFileSync) {
  let path
  try {
    path = resolvePatchPath(patch, baseUrl)
  } catch {
    return { patch, path: undefined, status: STATUS.NOT_FOUND, exists: false, source: undefined }
  }
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    return { patch, path, status: STATUS.NOT_FOUND, exists: false, source: undefined }
  }
  const result = patchSource(source, patch)
  return { patch, path, status: result.status, exists: true, source: result.source }
}

/**
 * Terapkan satu patch ke file (baca → patchSource → tulis bila berubah).
 * @returns {{ patch, path, status, changed }}
 */
export function applyPatch(patch, baseUrl, fs) {
  const inspection = inspectPatch(patch, baseUrl, fs.readFileSync)
  if (!inspection.exists || inspection.status === STATUS.NOT_FOUND) return { ...inspection, changed: false }
  if (inspection.status === STATUS.ANCHOR_MISSING) return { ...inspection, changed: false }
  if (inspection.status === STATUS.INSTALLED) return { ...inspection, changed: false }
  // status === APPLIED → hasil transformasi berbeda dari isi file; tulis.
  fs.writeFileSync(inspection.path, inspection.source)
  return { ...inspection, changed: true }
}
