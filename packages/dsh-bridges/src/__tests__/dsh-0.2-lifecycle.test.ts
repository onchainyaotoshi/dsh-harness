import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createPermissionsBridge } from '../agents/codex/permissions.js'
import { createHookBridge } from '../agents/codex/hooks/bridge.js'
import type { CodexSettingsLoader } from '../agents/codex/settings.js'
import { createMcpBridge, type McpManager } from '../mcp-bridge.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

function harness() {
  const handlers = new Map<string, Function[]>()
  const ctx = {
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    effect() {},
  } as unknown as Context
  return {
    ctx,
    handlers,
    async emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler(payload)
    },
  }
}

function agent() {
  const append = vi.fn()
  const inject = vi.fn()
  const steer = vi.fn()
  return {
    value: { session: { id: 'mock-session', header: { cwd: process.cwd() }, append }, inject, steer } as unknown as Agent,
    append, inject, steer,
  }
}

describe('DSH 0.2 initialization and turn boundaries', () => {
  it('applies sandbox and approval policy before agent creation completes', async () => {
    const bus = harness()
    const a = agent()
    const loader = { load: async () => {
      await Promise.resolve()
      return { sandboxMode: 'read-only', approvalPolicy: { kind: 'never' } }
    } } as unknown as CodexSettingsLoader
    createPermissionsBridge(bus.ctx, logger, loader)
    expect(bus.handlers.has('agent/session-start')).toBe(false)
    await bus.emit('agent/created', { agent: a.value, source: 'startup' })
    expect(a.append.mock.calls).toEqual([
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'never' }],
    ])
  })

  it('waits for SessionStart context and Stop continuation from controlled local hooks', async () => {
    const bus = harness()
    const a = agent()
    const loader = { load: async () => ({
      hooksDisabled: false,
      byEvent: new Map([
        ['SessionStart', [{ hooks: [{ type: 'command', command: `node -e "console.log('fixture context')"` }] }]],
        ['Stop', [{ hooks: [{ type: 'command', command: `node -e "console.log(JSON.stringify({decision:'block',reason:'fixture continuation'}))"` }] }]],
      ]),
    }) } as unknown as CodexSettingsLoader
    createHookBridge(bus.ctx, logger, loader, { hookTimeoutMs: 5000, maxHookOutputChars: 1000 })
    await bus.emit('agent/created', { agent: a.value, source: 'startup' })
    expect(a.inject).toHaveBeenCalledOnce()
    expect(a.inject.mock.calls[0]![0].source).toEqual({ kind: 'dsh-bridges', plugin: 'dsh-bridges:codex-hooks/SessionStart' })
    await bus.emit('agent/turn-stopping', { agent: a.value, signal: new AbortController().signal })
    expect(a.steer).toHaveBeenCalledOnce()
  })

  it('finishes mocked MCP reconciliation before creation completes', async () => {
    const bus = harness()
    const reconciled: string[] = []
    const manager = { reconcile: async (cwd: string) => {
      await Promise.resolve()
      reconciled.push(cwd)
    } } as unknown as McpManager
    createMcpBridge(bus.ctx, manager)
    await bus.emit('agent/created', { agent: agent().value })
    expect(reconciled).toEqual([process.cwd()])
  })
})
