import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { checkUpgrade } from '../packages/dsh-custom-settings/scripts/upgrade-preflight.mjs'
// Installed host evaluator is exercised without booting a profile or invoking hooks.
const require = createRequire(new URL('../package.json', import.meta.url))
const { evaluatePluginCompatibility: evaluate } = await import(require.resolve('@deepseek-ai/dsh-app-boot'))
const plugin = JSON.parse((await import('node:fs')).readFileSync(new URL('../packages/dsh-custom-settings/package.json', import.meta.url)))
function check(targetVersion, dependencies = {}, manifest = plugin) {
  return checkUpgrade({ targetVersion, profileDir: '/mock', evaluate,
    resolve: () => '/mock/plugin',
    read: p => p.endsWith('package.json') ? { dependencies, dsh: { profile: { bundles: [plugin.name] } } } : manifest })
}
test('same API series accepts patch upgrades and rejects next minor including prereleases', () => {
  for (const v of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1', '0.2.9']) assert.deepEqual(check(v), [])
  for (const v of ['0.1.9', '0.3.0-rc.1', '0.3.0', '1.0.0']) assert.equal(check(v).length, 1)
})
test('old pinned plugin blocks before install; exemptions are not accepted', () => {
  assert.equal(check('0.2.1-rc.2', {}, { ...plugin, peerDependencies: { '@deepseek-ai/dsh-fs': '0.2.0-rc.2' } }).length, 1)
})
test('profile core copies block even if current version happens to match', () => {
  assert.match(check('0.2.1-rc.2', { '@deepseek-ai/dsh-user-approval': '0.2.1-rc.2' })[0], /salinan core/)
})
test('missing evaluator fails closed', () => {
  assert.throws(() => checkUpgrade({ targetVersion: '0.2.1-rc.2', read: () => ({}) }), /evaluator unavailable/)
})
