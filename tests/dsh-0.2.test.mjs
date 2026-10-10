import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { apply as applyGit } from '../packages/dsh-git-state/lib/index.js'
import { apply as applySettings, Config } from '../packages/dsh-custom-settings/lib/index.js'

function context(services = {}) {
  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    get: (name) => ctx[name],
    provide: (name, value) => { ctx[name] = value },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  }
  return { ctx, routes, listeners }
}
async function request(routes, path, body) {
  const req = new EventEmitter()
  req.url = path
  req.method = body === undefined ? 'GET' : 'POST'
  const res = { statusCode: 200, setHeader() {}, end(raw) { this.body = JSON.parse(raw) } }
  const result = routes.get(path.split('?')[0])(req, res)
  if (body !== undefined) queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  await result
  return res
}

test('Git collector uses the DSH 0.2 execution handle and preserves failures', async () => {
  let executed = 0
  const { ctx, routes } = context({
    workspaceRegistry: { archivedSessionIds: [], list: () => [{ id: 'test', title: 'test', path: '/mock/isolated-repository' }] },
    sessions: { list: () => [] },
    shell: {
      resolve: (req) => req,
      execute: async (spec) => {
        executed++
        assert.match(spec.command, /rev-parse --is-inside-work-tree/)
        return { result: async () => ({ exitCode: 1, timedOut: false, aborted: false, stdout: { text: '' }, stderr: { text: 'mock shell failure' } }) }
      },
    },
  })
  applyGit(ctx)
  const res = await request(routes, '/plugins/dsh-git-state/api/state')
  assert.equal(executed, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.workspaces[0].error, 'mock shell failure')
})

test('custom settings expose volatile fields and apply saved values through DSH 0.2', async () => {
  const schema = Config.toJSON()
  for (const key of ['runCodeMaxWallMs', 'gitStatePollMs', 'gitStateCmdTimeoutMs']) assert.equal(schema.refs[schema.refs[schema.uid].dict[key]].meta.volatile, true)
  const config = { runCodeMaxWallMs: 3600000, gitStatePollMs: 1800000, gitStateCmdTimeoutMs: 300000 }
  const settings = {
    configure: () => () => {},
    describe: () => [{ ns: 'custom-settings', value: config }],
    mutate: async (ns, ops) => {
      assert.equal(ns, 'custom-settings')
      for (const op of ops) config[op.path[0]] = op.value
    },
  }
  const { ctx, routes, listeners } = context({ settings, ptcRuntime: { config: { maxTimeoutMs: 600000 } } })
  applySettings(ctx, config)
  assert.equal(ctx.ptcRuntime.config.maxTimeoutMs, 3600000)
  assert.equal(ctx.customSettingsApplied.gitState.cmdTimeoutMs, 300000)
  assert.ok(listeners.has('settings/document-updated'))
  const res = await request(routes, '/plugins/dsh-custom-settings/api/save', { id: 'gitStateCmdTimeoutMs', value: 60000 })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.applied.gitStateCmdTimeoutMs, 60000)
  assert.equal(ctx.customSettingsApplied.gitState.cmdTimeoutMs, 60000)
})


test('deep-link navigation detaches before synchronous catalog notifications', () => {
  let client
  let listener
  let opened = 0
  let cleanUrl
  const window = {
    location: { search: '?session=test-session', href: 'http://localhost/?session=test-session' },
    history: { replaceState: (_state, _title, value) => { cleanUrl = value } },
    setTimeout: () => 1,
    clearTimeout() {},
    __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({})) } },
  }
  vm.runInNewContext(readFileSync(new URL('../packages/dsh-copy-link-sesi/lib/client.js', import.meta.url), 'utf8'), { window, URL, URLSearchParams })
  client.apply({
    slots: { inject: (_name, callback) => callback(), register() {} },
    sessions: { list: {
      getSnapshot: () => ({ ids: ['test-session'] }),
      subscribe: (fn) => { listener = fn; return () => { listener = undefined } },
    } },
    uiWorkspace: { openSession(id) {
      assert.equal(id, 'test-session')
      assert.ok(++opened < 3, 'navigation recursed')
      listener?.()
    } },
    effect: (fn) => fn(),
  })
  assert.equal(opened, 1)
  assert.equal(listener, undefined)
  assert.equal(cleanUrl, '/')
})
