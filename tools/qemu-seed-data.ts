// Seed regular test files into an offline copy of the current factory image.
import { seedArguments, seedDataImage } from '../build/src/seed-data.ts'

const [board, image, ...pairs] = Bun.argv.slice(2)
if (!board || !image || pairs.length === 0 || pairs.length % 2 !== 0) {
  throw new Error('Usage: qemu-seed-data.ts BOARD DISK SOURCE /state/TARGET [SOURCE /state/TARGET ...]')
}
const { files, enabled } = seedArguments(pairs)
await seedDataImage(board, image, files, enabled)
