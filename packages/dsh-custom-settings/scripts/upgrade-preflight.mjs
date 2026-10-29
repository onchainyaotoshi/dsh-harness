import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// Use DSH's own compatibility evaluator, including its prerelease semantics.
// Importing app-boot does not boot a profile or execute user hooks.
export function checkUpgrade({ targetVersion, profileDir = join(homedir(), '.dsh/profiles/web'), read = p => JSON.parse(readFileSync(p, 'utf8')), resolve, evaluate } = {}) {
  const profilePath = join(profileDir, 'package.json')
  const require = createRequire(profilePath)
  resolve ??= name => {
    try { return require.resolve(`${name}/package.json`) } catch {
      let dir = dirname(require.resolve(name))
      for (;;) {
        const path = join(dir, 'package.json')
        try { if (read(path).name === name) return path } catch {}
        const parent = dirname(dir)
        if (parent === dir) throw new Error(`Manifest unavailable: ${name}`)
        dir = parent
      }
    }
  }
  if (!evaluate) throw new Error('DSH compatibility evaluator unavailable')
  const manifest = read(profilePath)
  const blockers = []
  // Framework packages belong to the host, never a separately installed profile copy.
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh-')) blockers.push(`${name}: salinan core di profil harus dihapus agar mengikuti runtime DSH`)
  }
  for (const name of manifest.dsh?.profile?.bundles ?? []) {
    if (name.startsWith('@deepseek-ai/')) continue
    const plugin = read(resolve(name))
    const issue = evaluate(plugin, {}, targetVersion)
    if (issue) blockers.push(`${name}: ${JSON.stringify(issue.requirements)}`)
  }
  return blockers
}
