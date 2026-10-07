import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { PATCHES, patchSource, STATUS } from '../packages/dsh-patches/scripts/patch-core.mjs'

test('legacy Claude source migration admits only audited coordinate-free metadata', () => {
  const patch = PATCHES.find(p => p.id === 'session-legacy-claude-source')
  // Isolate the upstream admission boundary: no real session, filesystem or API.
  const pristine = `function assertSource(message) {
\tconst source = record(message["source"], "message source");
    if (!SOURCE_KINDS.has(source.kind)) throw new Error('unclassified source');
  }`
  const result = patchSource(pristine, patch)
  assert.equal(result.status, STATUS.APPLIED)
  assert.equal(patchSource(result.source, patch).status, STATUS.INSTALLED)
  const context = vm.createContext({
    SOURCE_KINDS: new Set(['user', 'plugin', 'model', 'tool']),
    record(value) { assert.ok(value && typeof value === 'object'); return value },
  })
  vm.runInContext(result.source, context)
  const validate = source => context.assertSource({ source })
  for (const form of ['rules', 'hook-context']) {
    const source = { kind: 'claude-compat', form }
    validate(source)
    assert.deepEqual(source, { kind: 'claude-compat', form })
  }
  for (const source of [
    { kind: 'unreviewed-producer', form: 'rules' },
    { kind: 'claude-compat' },
    { kind: 'claude-compat', form: 'unreviewed-form' },
    { kind: 'claude-compat', form: 'rules', seq: 10 },
    { kind: 'claude-compat', form: 'rules', sourceEventSeqs: [10] },
  ]) assert.throws(() => validate(source), /unclassified source/)
  validate({ kind: 'user' })
  assert.equal(patchSource('changed upstream anchor', patch).status, STATUS.ANCHOR_MISSING)
})

test('Claude rules use a native producer and recognize historical attribution without reinjection', async () => {
  const patch = PATCHES.find(p => p.id === 'claude-compat-message-source')
  const pristine = `async function rules({ agent, messages }, next) {
    const decision = await next();
${patch.steps[0].old}
    const alreadyInjected = present(messages) || present(decision.messages)
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.eventAt(seq);
        return event?.type === 'user/message'
${patch.steps[1].old}
      });
    if (alreadyInjected) return decision;
    return { kind: 'enter', messages: [...decision.messages, {
      id: 'mock-rules', role: 'user', content: [{ type: 'text', text: 'fixture rules' }],
      ${patch.steps[2].old}
    }] };
  }`
  const result = patchSource(pristine, patch)
  assert.equal(result.status, STATUS.APPLIED)
  const context = vm.createContext({})
  vm.runInContext(result.source, context)
  const decision = { kind: 'enter', messages: [] }
  const event = { type: 'user/message', data: { source: undefined } }
  const agent = { session: { surface: { nodes: [0] }, eventAt: () => event } }
  for (const source of [
    { kind: 'claude-compat', form: 'rules' },
    { kind: 'plugin:dsh-claude-compat', form: 'rules' },
    { kind: 'plugin', plugin: 'dsh-claude-compat', form: 'rules' },
  ]) {
    event.data.source = source
    assert.equal(await context.rules({ agent, messages: [] }, async () => decision), decision)
  }
  event.data.source = { kind: 'user' }
  const injected = await context.rules({ agent, messages: [] }, async () => decision)
  assert.equal(injected.messages.length, 1)
  assert.equal(injected.messages[0].source.kind, 'claude-compat')
  assert.equal(injected.messages[0].source.form, 'rules')
  assert.equal(Object.hasOwn(injected.messages[0].source, 'plugin'), false)
})
