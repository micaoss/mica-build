// Measure host wall time from QEMU harness start to full runtime acceptance.
//
//   bun /harness/timed-boot.ts <boot command...>
//
// The command's output passes through line by line; the line `FILE_AB_RUNTIME_PASS` stops the clock, and the
// measurement is printed after the command as `FILE_AB_BOOT_WALL_MS: <ms>`. Runs in the lab image. The port of
// timed-boot.py (deleted 2026-09-22).
const start = Bun.nanoseconds()
let reached: number | undefined
const child = Bun.spawn(Bun.argv.slice(2), { stdout: 'pipe', stderr: 'pipe', stdin: 'inherit' })
const merged = new TransformStream<Uint8Array, Uint8Array>()
const writer = merged.writable.getWriter()
async function pump(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of stream) await writer.write(chunk)
}
const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]).then(() => writer.close())
let pending = ''
for await (const chunk of merged.readable) {
  pending += new TextDecoder().decode(chunk)
  let at: number
  while ((at = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, at + 1)
    pending = pending.slice(at + 1)
    await Bun.write(Bun.stdout, line)
    if (line.trim() === 'FILE_AB_RUNTIME_PASS' && reached === undefined) reached = Math.floor((Bun.nanoseconds() - start) / 1_000_000)
  }
}
if (pending !== '') await Bun.write(Bun.stdout, pending)
await pumps
const result = await child.exited
if (reached !== undefined) await Bun.write(Bun.stdout, `FILE_AB_BOOT_WALL_MS: ${reached}\n`)
process.exit(result)
