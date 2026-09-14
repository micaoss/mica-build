import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const releases = sqliteTable('releases', {
  id: text('id').primaryKey(),
  board: text('board').notNull(),
  arch: text('arch').notNull(),
  channel: text('channel').notNull(),
  version: text('version').notNull(),
  generation: integer('generation').notNull(),
  deploymentId: text('deployment_id').notNull(),
  deployment: text('deployment').notNull(),
  notes: text('notes').notNull(),
  status: text('status', { enum: ['draft', 'published', 'withdrawn'] }).notNull(),
  createdAt: text('created_at').notNull(),
  publishedAt: text('published_at'),
}, table => [uniqueIndex('release_identity').on(table.board, table.channel, table.generation)])

export const objects = sqliteTable('objects', {
  sha256: text('sha256').primaryKey(),
  bytes: integer('bytes').notNull(),
  createdAt: text('created_at').notNull(),
})

export const firmware = sqliteTable('firmware', {
  id: text('id').primaryKey(),
  board: text('board').notNull(),
  arch: text('arch').notNull(),
  channel: text('channel').notNull(),
  version: text('version').notNull(),
  generation: integer('generation').notNull(),
  firmwareId: text('firmware_id').notNull(),
  firmware: text('firmware').notNull(),
  artifactSha256: text('artifact_sha256').notNull(),
  artifactBytes: integer('artifact_bytes').notNull(),
  notes: text('notes').notNull(),
  status: text('status', { enum: ['draft', 'published', 'withdrawn'] }).notNull(),
  createdAt: text('created_at').notNull(),
  publishedAt: text('published_at'),
}, table => [uniqueIndex('firmware_identity').on(table.board, table.channel, table.generation)])

export const releaseObjects = sqliteTable('release_objects', {
  releaseId: text('release_id').notNull().references(() => releases.id),
  sha256: text('sha256').notNull(),
  bytes: integer('bytes').notNull(),
}, table => [primaryKey({ columns: [table.releaseId, table.sha256] })])

export const catalogs = sqliteTable('catalogs', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull(),
  envelope: text('envelope').notNull(),
  issuedAt: text('issued_at').notNull(),
  expiresAt: text('expires_at').notNull(),
})

export const audit = sqliteTable('audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  action: text('action').notNull(),
  releaseId: text('release_id'),
  detail: text('detail').notNull(),
  createdAt: text('created_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  hash: text('hash').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
})

export type Release = typeof releases.$inferSelect
export type FirmwareRelease = typeof firmware.$inferSelect
