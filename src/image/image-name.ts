import { existsSync } from 'node:fs'
import { boardEnvPath } from './paths.ts'

export function factoryImageFilename(board: string, builtAt: Date): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(board) || !existsSync(boardEnvPath(board))) throw new Error(`Invalid image board '${board}': not a pinned, fetched board`)
  if (!Number.isFinite(builtAt.getTime())) throw new Error('Invalid image build time')
  const iso = builtAt.toISOString()
  if (!/^\d{4}-/.test(iso)) throw new Error('Invalid image build time')
  return `mica-${board}-${iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.img`
}

export function isFactoryImageFilename(filename: string, board: string): boolean {
  const match = /^mica-([a-z0-9][a-z0-9-]{0,31})-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.img$/.exec(filename)
  if (!match || match[1] !== board) return false
  const time = new Date(`${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}Z`)
  return Number.isFinite(time.getTime()) && factoryImageFilename(board, time) === filename
}
