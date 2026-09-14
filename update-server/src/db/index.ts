import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import migration from '../../drizzle/0000_initial.sql' with { type: 'text' }
import journal from '../../drizzle/meta/_journal.json'
import * as schema from './schema'

export function createDb(dataDir: string) {
  const path = join(dataDir, 'updates.sqlite')
  const sqlite = new Database(path, { create: true, strict: true })
  try {
    chmodSync(path, 0o600)
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const db = drizzle(sqlite, { schema })
    const migrationsFolder = mkdtempSync(join(dataDir, '.migrations-'))
    try {
      mkdirSync(join(migrationsFolder, 'meta'))
      writeFileSync(join(migrationsFolder, 'meta', '_journal.json'), JSON.stringify(journal))
      writeFileSync(join(migrationsFolder, '0000_initial.sql'), migration)
      migrate(db, { migrationsFolder })
    }
    finally {
      rmSync(migrationsFolder, { recursive: true })
    }
    return { db, close: () => sqlite.close() }
  }
  catch (error) {
    sqlite.close()
    throw error
  }
}

export type Store = ReturnType<typeof createDb>
