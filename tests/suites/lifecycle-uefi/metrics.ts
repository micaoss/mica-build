// Extract measured early-init process cost and Linux startup time from a boot log.
//
//   bash bin/bun.sh tests/suites/lifecycle-uefi/metrics.ts <boot log>
//
// Prints one JSON record. Refuses a log without exactly one `mica-init: metrics` record. The port of
// metrics.py (deleted 2026-09-22); the record's keys and the scope note are its.
import { readFileSync } from 'node:fs'

const log = readFileSync(Bun.argv[2]!, 'utf8')
const metrics = [...log.matchAll(/mica-init: metrics elapsedMs=(\d+) peakRssKiB=(\d+)/g)]
if (metrics.length !== 1) throw new Error('expected exactly one measured early-init record')
const elapsed = Number(metrics[0]![1]), rss = Number(metrics[0]![2])
if (!(elapsed > 0 && rss > 0)) throw new Error('AssertionError')
const wall = [...log.matchAll(/FILE_AB_BOOT_WALL_MS: (\d+)/g)]
const startup = [...log.matchAll(/\[\s*([0-9.]+)\].*Startup finished in/g)]
const record = {
  earlyInitElapsedMs: elapsed, earlyInitPeakRssKiB: rss,
  runtimeAcceptanceWallMs: wall.length > 0 ? Number(wall[wall.length - 1]![1]) : null,
  linuxStartupSeconds: startup.length > 0 ? Number(startup[startup.length - 1]![1]) : null,
  scope: 'early-init process RSS; excludes kernel and initramfs backing memory',
}
console.log(JSON.stringify(record, null, 2))
