#!/usr/bin/env bun
// An isolated Docker boundary: never delegate any command to the real daemon.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const work = process.env.MICA_API_LAUNCHER_FIXTURE!
const args = Bun.argv.slice(2)
if (args[0] === 'info' || (args[0] === 'image' && args[1] === 'inspect') || args[0] === 'stop') process.exit(0)
if (args[0] === 'ps' && args[1] === '-q') process.exit(0)
if (args[0] === 'network') {
  if (args[1] === 'ls') { console.log('acceptance-fixture'); process.exit(0) }
  if (args[1] === 'inspect') { console.log('192.0.2.1/24'); process.exit(0) }
}
if (args[0] !== 'run') throw new Error(`Unexpected fixture Docker command: ${JSON.stringify(args)}`)

const env: Record<string, string> = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '-e') continue
  const pair = args[++i]!, equals = pair.indexOf('=')
  if (equals < 1) throw new Error('Fixture requires explicit container environment values')
  env[pair.slice(0, equals)] = pair.slice(equals + 1)
}
if (args.includes('src/qemu.ts')) {
  writeFileSync(join(work, 'outer.json'), JSON.stringify({ args, env }))
  // Preparation does not validate forwards. Exercise the real capture path on
  // an already existing tiny disk, using only the environment Docker received.
  const child = Bun.spawnSync([process.execPath, join(work, 'tests/suites/apid-api/src/qemu.ts'),
    '--capture', join(work, 'console.log')], {
    env: { PATH: process.env.PATH!, MICA_API_LAUNCHER_FIXTURE: work, ...env, MICA_QEMU_REUSE_DISK: '1' },
    timeout: 10000,
  })
  writeFileSync(join(work, 'engine.json'), JSON.stringify({ exitCode: child.exitCode, stderr: child.stderr.toString() }))
  console.error(child.stderr.toString())
  process.exit(73) // Stop the real launcher before preparation/guest/API work.
}
if (!args.includes('ai-agent/mica-p2-lab')) throw new Error('Unexpected Docker image at fixture boundary')
writeFileSync(join(work, 'inner.json'), JSON.stringify({ args, env }))
if (readFileSync(join(work, 'outer.json'), 'utf8').length === 0) throw new Error('Missing actual outer invocation')
process.exit(73)
