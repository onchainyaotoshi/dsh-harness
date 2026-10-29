// Isolated child processes and temporary files; never starts DSH or reads its journal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { loadDshToken } from '../deploy/access-auth.mjs'

const invocationId = 'a'.repeat(32)
const token = 'A'.repeat(43)
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launch-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'launch.json')
}
const service = async (command, args) => {
  assert.equal(command, 'systemctl')
  assert.ok(args.includes('InvocationID'))
  return { stdout: `MainPID=123\nInvocationID=${invocationId}\n` }
}

test('launcher captures a split startup URL privately and preserves output and child exit status', async t => {
  const tokenFile = await fixture(t)
  const code = `process.stdout.write('ready http://127.0.0.1:3080/?to'); setTimeout(() => { process.stdout.write('ken=${token}\\n'); process.stderr.write('fixture diagnostic\\n'); process.exitCode = 7 }, 20)`
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../deploy/launch-dsh.mjs', import.meta.url)), process.execPath, '-e', code], {
    env: { ...process.env, DSH_LAUNCH_TOKEN_FILE: tokenFile, INVOCATION_ID: invocationId }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 7)
  assert.equal(result.stdout, `ready http://127.0.0.1:3080/?token=${token}\n`)
  assert.equal(result.stderr, 'fixture diagnostic\n')
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(tokenFile, 'utf8')), { invocationId, token })
})

test('current service token remains available when startup journal is unavailable', async t => {
  const tokenFile = await fixture(t)
  await writeFile(tokenFile, JSON.stringify({ invocationId, token }), { mode: 0o600 })
  assert.equal(await loadDshToken({ tokenFile, runCommand: service }), token)
})

test('token cache rejects previous service invocations, unsafe permissions, and malformed tokens', async t => {
  const tokenFile = await fixture(t)
  for (const [record, mode] of [
    [{ invocationId: 'b'.repeat(32), token }, 0o600],
    [{ invocationId, token }, 0o644],
    [{ invocationId, token: 'invalid' }, 0o600],
  ]) {
    await writeFile(tokenFile, JSON.stringify(record), { mode: 0o600 })
    await chmod(tokenFile, mode)
    await assert.rejects(loadDshToken({ tokenFile, runCommand: service }))
  }
  await chmod(tokenFile, 0o600)
  await writeFile(tokenFile, JSON.stringify({ invocationId, token }))
  const link = `${tokenFile}.link`
  await symlink(tokenFile, link)
  await assert.rejects(loadDshToken({ tokenFile: link, runCommand: service }))
  await assert.rejects(loadDshToken({ tokenFile, runCommand: async () => ({ stdout: `MainPID=0\nInvocationID=${invocationId}\n` }) }))
})

test('launcher retains the startup token even in a large output chunk', async t => {
  const tokenFile = await fixture(t)
  const code = `process.stdout.write('http://127.0.0.1:3080/?token=${token}\\n' + 'x'.repeat(10000))`
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../deploy/launch-dsh.mjs', import.meta.url)), process.execPath, '-e', code], {
    env: { ...process.env, DSH_LAUNCH_TOKEN_FILE: tokenFile, INVOCATION_ID: invocationId }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(await readFile(tokenFile, 'utf8')), { invocationId, token })
})

test('launcher forwards a termination signal once and waits for child cleanup', { timeout: 5000 }, async t => {
  const tokenFile = await fixture(t)
  const code = `let count=0; const keep=setInterval(()=>{},1000); process.on('SIGTERM',()=>{ count++; setTimeout(()=>{ console.log('cleanup:'+count); clearInterval(keep) },100) }); console.log('ready')`
  // KillMode=mixed delivers the initial signal only to the launcher.
  const child = spawn(process.execPath, [fileURLToPath(new URL('../deploy/launch-dsh.mjs', import.meta.url)), process.execPath, '-e', code], {
    env: { ...process.env, DSH_LAUNCH_TOKEN_FILE: tokenFile, INVOCATION_ID: invocationId }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  const closed = once(child, 'close')
  await once(child.stdout, 'data')
  assert.equal(stdout, 'ready\n')
  child.kill('SIGTERM')
  assert.deepEqual(await closed, [0, null])
  assert.equal(stdout, 'ready\ncleanup:1\n')
})
