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

// ---------------------------------------------------------------------------
// Patch 1: heartbeat ping WebSocket downlink (dsh-client-connection)
// Mencegah Cloudflare edge memutus koneksi setelah idle ±100-120 detik.
// Kejadian nyata 24 Aug 2026: UPGRADE /api/events.mux berulang tiap ~127 dtk.
// ---------------------------------------------------------------------------
const WS_CONN = {
  id: 'ws-heartbeat-connection',
  pkg: '@deepseek-ai/dsh-client-connection',
  fileRel: 'lib/index.js',
  marker: '// [dsh-ws-heartbeat-patch]',
  steps: [
    {
      old: `var WebSocketDownlinks = class {
	api;
	server = new WebSocketServer({ noServer: true });
	pumps = /* @__PURE__ */ new Set();`,
      replacement: `var WebSocketDownlinks = class {
	api;
	server = new WebSocketServer({ noServer: true });
	pumps = /* @__PURE__ */ new Set();
	/** // [dsh-ws-heartbeat-patch] heartbeat intervals per live socket. */
	heartbeats = /* @__PURE__ */ new Set();`,
    },
    {
      old: `		await Promise.all(this.pumps);`,
      replacement: `		for (const timer of this.heartbeats) clearInterval(timer);
		this.heartbeats.clear();
		await Promise.all(this.pumps);`,
    },
    {
      old: `		this.server.handleUpgrade(req, socket, head, (websocket) => {
			const abort = new AbortController();
			websocket.once("close", () => {
				abort.abort();
			});`,
      replacement: `		this.server.handleUpgrade(req, socket, head, (websocket) => {
			const abort = new AbortController();
			// // [dsh-ws-heartbeat-patch] idle timeout di proxy/edge (Cloudflare ±100-120s) memutus
			// downlink tanpa traffic; ping 25s menjaga koneksi tetap aktif.
			const heartbeat = setInterval(() => {
				if (websocket.readyState === WebSocket.OPEN) websocket.ping();
			}, 25000);
			this.heartbeats.add(heartbeat);
			const clearHeartbeat = () => {
				clearInterval(heartbeat);
				this.heartbeats.delete(heartbeat);
			};
			websocket.once("close", () => {
				clearHeartbeat();
				abort.abort();
			});`,
    },
    {
      old: `			websocket.once("error", () => {
				abort.abort();
			});`,
      replacement: `			websocket.once("error", () => {
				clearHeartbeat();
				abort.abort();
			});`,
    },
  ],
}

// ---------------------------------------------------------------------------
// Patch 2: client resync mempertahankan pending waits (dsh-client-runtime)
// Kartu Plan review / ask_user_question hilang sendiri saat reconnect karena
// pending.clear() berbalapan dengan replay host (24 Aug 2026).
// ---------------------------------------------------------------------------
const WS_RESYNC = {
  id: 'ws-heartbeat-resync',
  pkg: '@deepseek-ai/dsh-client-runtime',
  fileRel: 'lib/client.js',
  marker: '/* [dsh-ws-heartbeat-patch] keep pending waits across resync',
  steps: [
    {
      old: `				this.baseSeq = 0;
				this.pending.clear();
				this.pendingRev++;`,
      replacement: `				this.baseSeq = 0;
				/* [dsh-ws-heartbeat-patch] keep pending waits across resync the host replays question/approval/requested per
				 * mux open and mint() replaces by key, so keeping the waits lets the
				 * replay refresh them; clearing here raced the replay and silently
				 * dropped the pending card (Plan review / ask_user_question). */
				this.pendingRev++;`,
    },
  ],
}

// ---------------------------------------------------------------------------
// Patch 3: dsh-claude-compat fallback default dir (manifest tanpa field dir)
// Manifest plugin Claude Code yang tidak mendeklarasikan `skills`/`commands`
// (superpowers, frontend-design, dll.) bikin katalog DSH kosong padahal di
// Claude Code jalan — mirror perilaku fallback Claude Code (27 Aug 2026).
// SEAKAN-AN ULANG: patch ini sebelumnya di-maintain pnpm patch di profil;
// karena sekarang dikelola plugin ini, `patchedSig` menangani file yang
// SUDAH ter-patch pnpm (cukup suntik marker) sedangkan `steps` menangani file
// pristine (pnpm patch sudah dicabut).
// ---------------------------------------------------------------------------
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

export const PATCHES = [WS_CONN, WS_RESYNC, COMPAT]

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
  const require = createRequire(baseUrl)
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
