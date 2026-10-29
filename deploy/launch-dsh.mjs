// Run DSH unchanged while retaining its launch token independently of journal rotation.
import { spawn } from 'node:child_process'
import { writeFileSync, renameSync, rmSync } from 'node:fs'
import { Transform } from 'node:stream'

const tokenFile = process.env.DSH_LAUNCH_TOKEN_FILE
const invocationId = process.env.INVOCATION_ID
const [command, ...args] = process.argv.slice(2)
if (!tokenFile || !/^[a-f0-9]{32}$/.test(invocationId ?? '') || !command) {
  console.error('DSH launcher requires a private token file, systemd invocation ID, and command')
  process.exit(1)
}

let tail = '', recorded = false
const recorder = new Transform({
  transform(chunk, encoding, callback) {
    try {
      if (!recorded) {
        tail += chunk.toString('utf8')
        const token = /http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]{43})(?=[^A-Za-z0-9_-])/.exec(tail)?.[1]
        if (token) {
          const temporary = `${tokenFile}.${process.pid}.tmp`
          try {
            writeFileSync(temporary, JSON.stringify({ invocationId, token }), { mode: 0o600, flag: 'wx' })
            renameSync(temporary, tokenFile)
          } finally {
            rmSync(temporary, { force: true })
          }
          recorded = true
          tail = ''
        }
        tail = tail.slice(-4096)
      }
      callback(null, chunk)
    } catch {
      callback(new Error('DSH launch token could not be retained'))
    }
  },
})
const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'inherit'] })
child.stdout.pipe(recorder).pipe(process.stdout)
let failed = false
const fail = () => {
  failed = true
  console.error('DSH launcher failed; check command and private token directory')
  child.kill('SIGTERM')
  process.exitCode = 1
}
child.on('error', fail)
recorder.on('error', fail)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('close', code => { process.exitCode = failed ? 1 : (code ?? 1) })
