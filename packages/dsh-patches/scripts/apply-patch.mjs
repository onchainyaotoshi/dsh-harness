#!/usr/bin/env node
/**
 * CLI manual untuk SEMUA patch deploy yang dikelola plugin `dsh-patches`.
 * Logika patch ada di patch-core.mjs (sumber tunggal — host half plugin
 * memakai core yang sama untuk auto-repair saat boot, jadi tidak ada
 * duplikasi yang bisa melenceng).
 *
 * Pemakaian:
 *   node scripts/apply-patch.mjs               # pasang semua patch (idempoten)
 *   node scripts/apply-patch.mjs --check       # cek saja (0 = semua terpasang, 1 = ada yang belum)
 *   node scripts/apply-patch.mjs <id>          # satu patch saja (mis. ws-heartbeat-connection)
 *   node scripts/apply-patch.mjs --profile <dir>  # base profil selain default (~/.dsh/profiles/web)
 *
 * Resolusi default: <HOME>/.dsh/profiles/web/package.json — bekerja untuk
 * paket framework global MAUPUN paket profil berkat node_modules bersama
 * (~/.dsh/profiles/node_modules yang di-link ke tree global dsh).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PATCHES, STATUS, inspectPatch } from './patch-core.mjs'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
let only
let profileDir = join(homedir(), '.dsh/profiles/web')
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--profile') {
    profileDir = args[i + 1] ?? profileDir
    i += 1
  } else if (args[i] !== '--check' && only === undefined) {
    only = args[i]
  }
}

const baseUrl = join(profileDir, 'package.json')

let exitCode = 0
const report = []
for (const patch of PATCHES) {
  if (only !== undefined && patch.id !== only) continue
  const inspection = inspectPatch(patch, baseUrl, readFileSync)
  if (!inspection.exists) {
    report.push({ id: patch.id, status: 'NOT_FOUND', path: inspection.path ?? '(resolve gagal)', changed: false })
    exitCode = 1
    continue
  }
  if (inspection.status === STATUS.ANCHOR_MISSING) {
    report.push({ id: patch.id, status: 'ANCHOR_MISSING', path: inspection.path, changed: false })
    exitCode = 1
    continue
  }
  if (inspection.status === STATUS.INSTALLED) {
    report.push({ id: patch.id, status: 'installed', path: inspection.path, changed: false })
    continue
  }
  if (checkOnly) {
    report.push({ id: patch.id, status: 'pending', path: inspection.path, changed: false })
    exitCode = 1
    continue
  }
  writeFileSync(inspection.path, inspection.source)
  report.push({ id: patch.id, status: 'applied', path: inspection.path, changed: true })
}

for (const row of report) {
  const mark = row.changed ? 'APPLIED' : row.status === 'installed' ? '  ok  ' : row.status
  console.log(`${mark}  ${row.id.padEnd(28)} ${row.path}`)
}
if (report.length === 0) {
  console.log('Tidak ada patch yang cocok dengan filter.')
  exitCode = 1
}
if (exitCode === 0 && !checkOnly && report.some((r) => r.changed)) {
  console.log('\nPatch dipasang. RESTART dsh untuk mengaktifkan (bundle dibaca saat boot).')
} else if (exitCode === 0 && checkOnly) {
  console.log('\nSemua patch terpasang.')
}
process.exit(exitCode)
