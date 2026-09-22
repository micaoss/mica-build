// Record QMP events while running the existing complete-image boot harness.
//
//   bun /harness/qmp-boot.ts <events.jsonl> <boot command...>
//
// The boot command starts QEMU with `-qmp unix:/w/boot-events.sock,server=on,wait=off`; this process connects,
// negotiates capabilities and appends every event to the log until QEMU exits. Runs in the lab image
// (tests/suites/signed-boot-lab/Dockerfile.lab). Event semantics: https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html
// The port of qmp-boot.py (deleted 2026-09-22): the command runs in its own session (setsid), so that a
// timeout kills the whole QEMU process group and not only the shell that started it.
import { existsSync, openSync, closeSync, rmSync, writeSync } from 'node:fs'

const [output, ...command] = Bun.argv.slice(2)
if (output === undefined || command.length === 0) throw new Error('boot command required')
const endpoint = '/w/boot-events.sock'
rmSync(endpoint, { force: true })
const child = Bun.spawn(['setsid', ...command], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
let exited = false
void child.exited.then(() => { exited = true })

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function killGroup(signal: NodeJS.Signals): void {
  try { process.kill(-child.pid, signal) }
  catch { /* already gone */ }
}

let closed = false
let failure: Error | undefined
let pending = Buffer.alloc(0)
let log = -1

function receive(data: Buffer): void {
  pending = Buffer.concat([pending, data])
  let at: number
  while ((at = pending.indexOf(0x0a)) >= 0) {
    const line = pending.subarray(0, at)
    pending = pending.subarray(at + 1)
    const record = JSON.parse(line.toString()) as Record<string, unknown>
    if ('error' in record) { failure = new Error(JSON.stringify(record)); return }
    if ('event' in record) writeSync(log, JSON.stringify(record) + '\n')
  }
}

async function connect(): Promise<Bun.Socket<undefined>> {
  const deadline = Date.now() + 60000
  for (;;) {
    if (existsSync(endpoint)) {
      try {
        return await Bun.connect({
          unix: endpoint,
          socket: {
            data(_socket, data) { receive(data) },
            close() { closed = true },
            error(_socket, error) { failure = error },
          },
        })
      }
      catch { /* not listening yet */ }
    }
    if (exited || Date.now() >= deadline) throw new Error('QMP connection failed')
    await sleep(50)
  }
}

let status = 1
try {
  const socket = await connect()
  log = openSync(output, 'wx')
  socket.write('{"execute":"qmp_capabilities"}\r\n')
  while (!closed && !exited) {
    if (failure) throw failure
    await sleep(500)
  }
  if (failure) throw failure
  closeSync(log)
  status = await Promise.race([child.exited, sleep(10000).then(() => { throw new Error('the boot command did not exit') })])
}
finally {
  if (!exited) {
    killGroup('SIGTERM')
    const ended = await Promise.race([child.exited.then(() => true), sleep(10000).then(() => false)])
    if (!ended) { killGroup('SIGKILL'); await child.exited }
  }
}
process.exit(status)
