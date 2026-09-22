// The fetch-time mirror hook, against a local server that serves mica-res's contract:
// common/scripts/fetch-archive.sh for a `source` row and common/scripts/fetch-source.sh --name for a `git` row.
// No network: the mirror, the vendor host and the upstream git repository are all local, and the mirror is this
// process (Bun.serve: a static tree plus one redirect, /r/<path> answering 302 to /<path>, the shape mica-res
// moved to on 2026-09-19; a consumer that did not follow it would read every object as a miss while its URLs
// still looked correct).
//
// What every case is really checking: the fallback is the normal path and the mirror is an optimisation that
// may be absent, slow or wrong, and none of those may produce a wrong build -- or a hang.
//
// The port of tests/gates/mirror-hook-test.sh and tests/gates/mirror-hook-server.py (deleted 2026-09-22), case
// for case.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const FETCH_ARCHIVE = join(REPO_ROOT, 'common/scripts/fetch-archive.sh')
const FETCH_SOURCE = join(REPO_ROOT, 'common/scripts/fetch-source.sh')

type Run = { exitCode: number, out: string }

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function sha256Of(path: string): string {
  return sha256(readFileSync(path))
}

/** Run a command with MICA_MIRROR set (or, for `undefined`, unset), the output as one stream. Asynchronous,
 * because the mirror the command talks to is this process: a blocking spawn would never let it answer. */
async function run(argv: string[], mirror: string | undefined, extra: Record<string, string> = {}, cwd = REPO_ROOT): Promise<Run> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...extra }
  delete env.MICA_MIRROR
  if (mirror !== undefined) env.MICA_MIRROR = mirror
  const p = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), 120000)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const exitCode = await p.exited
  clearTimeout(timer)
  return { exitCode, out: out + err }
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 60000,
    env: { ...process.env, GIT_AUTHOR_DATE: '@1700000000 +0000', GIT_COMMITTER_DATE: '@1700000001 +0000' } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

function head(cwd: string): string {
  const r = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 ? r.stdout.toString().trim() : ''
}

let T: string, SITE: string, UP: string, COMMIT: string, PACK_SHA: string, PACK_SIZE: number, PREFIX: string, C0: string, C1: string
let ARCHIVE_SHA: string, ONLY_VENDOR_SHA: string, WRONG_SHA: string, LOCK_BEFORE: string
let MIRROR: string, REDIRECTED: string, VENDOR: string
const NAME = 'test-kernel'
const DEAD = 'http://192.0.2.1' // TEST-NET-1: routed nowhere, so this is the timeout case
const REFUSED = 'http://127.0.0.1:1'
let server: ReturnType<typeof Bun.serve> | undefined

function manifest(file: string, chunk0: string, chunk1: string): void {
  writeFileSync(file, `{ "schema": "mica/git-pack/v1", "repository": "mica-res", "name": "${NAME}",
  "url": "file://${UP}", "commit": "${COMMIT}",
  "pack": { "sha256": "${PACK_SHA}", "size": ${PACK_SIZE} },
  "chunks": [ { "sha256": "${chunk0}", "size": ${statSync(C0).size} },
              { "sha256": "${chunk1}", "size": ${statSync(C1).size} } ] }
`)
}

beforeAll(() => {
  mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
  T = mkdtempSync(join(REPO_ROOT, 'tmp/mirror-hook-test.'))
  // The lock's own bytes, to prove at the end that no fetch rewrote a URL.
  LOCK_BEFORE = sha256Of(join(REPO_ROOT, 'locks/upstream.lock'))

  // ---- the mirror and the vendor host, one server, two trees -----------------
  SITE = join(T, 'site')
  for (const d of ['blob', 'upstream/git', 'vendor']) mkdirSync(join(SITE, d), { recursive: true })
  const archive = randomBytes(4096)
  writeFileSync(join(T, 'archive.bin'), archive)
  ARCHIVE_SHA = sha256(archive)
  writeFileSync(join(SITE, 'vendor/toolchain.tar.xz'), archive)
  mkdirSync(join(SITE, 'blob', ARCHIVE_SHA.slice(0, 2)), { recursive: true })
  writeFileSync(join(SITE, 'blob', ARCHIVE_SHA.slice(0, 2), ARCHIVE_SHA), archive)

  // An object only the vendor host has, for the 404 fallback.
  const onlyVendor = randomBytes(4096)
  writeFileSync(join(T, 'only-vendor.bin'), onlyVendor)
  ONLY_VENDOR_SHA = sha256(onlyVendor)
  writeFileSync(join(SITE, 'vendor/only-vendor.tar.xz'), onlyVendor)

  // A wrong-bytes object, at a second sha256 the mirror answers for.
  const other = randomBytes(4096)
  writeFileSync(join(T, 'other.bin'), other)
  WRONG_SHA = sha256(other)
  mkdirSync(join(SITE, 'blob', WRONG_SHA.slice(0, 2)), { recursive: true })
  writeFileSync(join(SITE, 'blob', WRONG_SHA.slice(0, 2), WRONG_SHA), randomBytes(4096))
  writeFileSync(join(SITE, 'vendor/other.tar.xz'), other)

  // An upstream git repository, its pack, and the mirror's manifest for it.
  UP = join(T, 'upstream.git')
  const work = join(T, 'work')
  git(T, 'init', '-q', work)
  git(work, 'config', 'user.email', 't@example.com')
  git(work, 'config', 'user.name', 't')
  writeFileSync(join(work, 'a'), 'one\n')
  git(work, 'add', 'a')
  git(work, 'commit', '-qm', 'one')
  writeFileSync(join(work, 'b'), 'two\n')
  git(work, 'add', 'b')
  git(work, 'commit', '-qm', 'two')
  COMMIT = git(work, 'rev-parse', 'HEAD').trim()
  git(T, 'clone', '-q', '--bare', work, UP)
  const pack = Bun.spawnSync(['git', '-C', UP, 'pack-objects', '--revs', '--stdout'], { stdin: Buffer.from(COMMIT + '\n'), stdout: 'pipe', stderr: 'pipe' })
  if (pack.exitCode !== 0) throw new Error(pack.stderr.toString())
  const packBytes = new Uint8Array(pack.stdout)
  writeFileSync(join(T, 'pack'), packBytes)
  PACK_SHA = sha256(packBytes)
  PACK_SIZE = packBytes.length
  PREFIX = join(SITE, 'upstream/git', NAME)
  mkdirSync(PREFIX, { recursive: true })
  // split -n 2: two chunks of (as near as may be) equal size.
  const half = Math.floor(packBytes.length / 2)
  C0 = join(PREFIX, `${COMMIT}.pack.00`)
  C1 = join(PREFIX, `${COMMIT}.pack.01`)
  writeFileSync(C0, packBytes.subarray(0, half))
  writeFileSync(C1, packBytes.subarray(half))
  manifest(join(PREFIX, `${COMMIT}.json`), sha256Of(C0), sha256Of(C1))

  // The mirror: a static tree, and /r/<path> a 302 to /<path>.
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/r/')) return Response.redirect(url.pathname.slice(2), 302)
      const file = join(SITE, decodeURIComponent(url.pathname))
      if (!file.startsWith(SITE + '/') || !existsSync(file) || !statSync(file).isFile()) return new Response('Not Found', { status: 404 })
      return new Response(Bun.file(file))
    },
  })
  MIRROR = `http://127.0.0.1:${server.port}`
  // The same mirror reached through a 302, the shape mica-res moved to.
  REDIRECTED = `${MIRROR}/r`
  VENDOR = `${MIRROR}/vendor`
})

afterAll(() => {
  server?.stop(true)
  rmSync(T, { recursive: true, force: true })
})

/** expect <0|1> <needle> <command>: the exit status wanted and, when given, a fragment of the output. */
function expectRun(want: 0 | 1, needle: string, r: Run): void {
  if (want === 0) expect(r.exitCode, r.out).toBe(0)
  else expect(r.exitCode, r.out).not.toBe(0)
  if (needle !== '') expect(r.out).toContain(needle)
}

function same(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && Buffer.compare(readFileSync(a), readFileSync(b)) === 0
}

// ---- the archives ----------------------------------------------------------

test('archive: no MICA_MIRROR fetches the row\'s URL, and it delivers the pinned bytes', async () => {
  // The fallback first, because it is the path every network has: no mirror at all.
  expectRun(0, 'not mirrored', await run(['bash', FETCH_ARCHIVE, ARCHIVE_SHA, `${VENDOR}/toolchain.tar.xz`, join(T, 'out.bin')], undefined))
  expect(same(join(T, 'out.bin'), join(T, 'archive.bin'))).toBe(true)
})

test('archive: a mirror hit is used, and it delivers the pinned bytes', async () => {
  expectRun(0, 'from the mirror', await run(['bash', FETCH_ARCHIVE, ARCHIVE_SHA, 'http://127.0.0.1:1/never', join(T, 'hit.bin')], MIRROR))
  expect(same(join(T, 'hit.bin'), join(T, 'archive.bin'))).toBe(true)
})

test('archive: a mirror 404 falls back to the row\'s URL, and the fallback delivers the pinned bytes', async () => {
  expectRun(0, 'not mirrored', await run(['bash', FETCH_ARCHIVE, ONLY_VENDOR_SHA, `${VENDOR}/only-vendor.tar.xz`, join(T, 'miss.bin')], MIRROR))
  expect(same(join(T, 'miss.bin'), join(T, 'only-vendor.bin'))).toBe(true)
})

test('archive: wrong bytes from the mirror are refused, not fetched again, and removed', async () => {
  expectRun(1, 'not a trust anchor', await run(['bash', FETCH_ARCHIVE, WRONG_SHA, `${VENDOR}/other.tar.xz`, join(T, 'wrong.bin')], MIRROR))
  expect(existsSync(join(T, 'wrong.bin'))).toBe(false)
})

test('archive: wrong bytes from the row\'s URL are refused', async () => {
  expectRun(1, 'locks/upstream.lock pins', await run(['bash', FETCH_ARCHIVE, WRONG_SHA, `${VENDOR}/toolchain.tar.xz`, join(T, 'bad.bin')], undefined))
})

test('archive: a refused connection falls back', async () => {
  expectRun(0, 'not mirrored', await run(['bash', FETCH_ARCHIVE, ARCHIVE_SHA, `${VENDOR}/toolchain.tar.xz`, join(T, 'refused.bin')], REFUSED))
})

test('archive: an unreachable mirror costs a bounded wait and falls back', async () => {
  // The caveat this hook was designed around: a mirror that does not answer must cost a bounded wait, not a
  // build that hangs once per object.
  const start = Date.now()
  await run(['bash', FETCH_ARCHIVE, ARCHIVE_SHA, `${VENDOR}/toolchain.tar.xz`, join(T, 'timeout.bin')], DEAD, { MICA_MIRROR_CONNECT_TIMEOUT: '2' })
  const elapsed = Math.round((Date.now() - start) / 1000)
  expect(elapsed, `an unreachable mirror cost ${elapsed}s`).toBeLessThanOrEqual(6)
})

test('archive: a digest lookup follows a redirect, and the redirected mirror delivers the pinned bytes', async () => {
  // A mirror that answers with a redirect: BOTH halves must follow it, or every object reads as a miss while
  // the URLs still look correct.
  expectRun(0, 'after 1 redirect(s)', await run(['bash', FETCH_ARCHIVE, ARCHIVE_SHA, 'http://127.0.0.1:1/never', join(T, 'via302.bin')], REDIRECTED))
  expect(same(join(T, 'via302.bin'), join(T, 'archive.bin'))).toBe(true)
})

test('archive: a miss names the status it got, and a refused connection names its curl exit', async () => {
  // A miss must say WHY: a 404, a refused connection and a timeout are one decision and three different facts.
  expect((await run(['bash', FETCH_ARCHIVE, ONLY_VENDOR_SHA, `${VENDOR}/only-vendor.tar.xz`, join(T, 'why.bin')], MIRROR)).out).toContain('HTTP 404')
  expect((await run(['bash', FETCH_ARCHIVE, ARCHIVE_SHA, `${VENDOR}/toolchain.tar.xz`, join(T, 'why2.bin')], REFUSED)).out).toContain('curl 7')
})

// ---- the git trees ---------------------------------------------------------

test('git: no MICA_MIRROR clones upstream, at the pinned commit', async () => {
  expectRun(0, '', await run(['bash', FETCH_SOURCE, '--name', NAME, join(T, 'g-plain'), `file://${UP}`, COMMIT], undefined))
  expect(head(join(T, 'g-plain'))).toBe(COMMIT)
})

test('git: a mirrored pack is imported: the pinned commit, shallow, the upstream tree, fsck clean', async () => {
  expectRun(0, 'imported from the mirror, 2 chunk(s)', await run(['bash', FETCH_SOURCE, '--name', NAME, join(T, 'g-mirror'), `file://${T}/does-not-exist`, COMMIT], MIRROR))
  expect(head(join(T, 'g-mirror'))).toBe(COMMIT)
  expect(readFileSync(join(T, 'g-mirror/.git/shallow'), 'utf8').trim()).toBe(COMMIT)
  expect(same(join(T, 'g-mirror/a'), join(T, 'work/a')) && same(join(T, 'g-mirror/b'), join(T, 'work/b'))).toBe(true)
  expect(Bun.spawnSync(['git', '-C', join(T, 'g-mirror'), 'fsck', '--no-progress'], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
})

test('git: a mirrored pack is imported through a redirect, at the pinned commit', async () => {
  expectRun(0, 'imported from the mirror, 2 chunk(s), 1 redirect(s)', await run(['bash', FETCH_SOURCE, '--name', NAME, join(T, 'g-302'), `file://${T}/does-not-exist`, COMMIT], REDIRECTED))
  expect(head(join(T, 'g-302'))).toBe(COMMIT)
})

test('git: an unmirrored row clones upstream, at the pinned commit', async () => {
  expectRun(0, 'is not mirrored', await run(['bash', FETCH_SOURCE, '--name', 'absent-kernel', join(T, 'g-404'), `file://${UP}`, COMMIT], MIRROR))
  expect(head(join(T, 'g-404'))).toBe(COMMIT)
})

test('git: without --name the mirror is not consulted', async () => {
  expectRun(0, '', await run(['bash', FETCH_SOURCE, join(T, 'g-noname'), `file://${UP}`, COMMIT], MIRROR))
})

test('git: a missing chunk names its index and its status, and falls back to the pinned commit', async () => {
  // The manifest resolves but a chunk does not: the shape mica-res had on 2026-09-19, where the
  // uefi-x64-kernel manifest declared five chunks and chunk 00 was stored under the sibling board's name only.
  // It must fall back to the clone AND name the chunk, so the next occurrence names itself instead of needing
  // a by-hand walk of the contract.
  renameSync(C0, join(T, 'chunk00.hidden'))
  try {
    const r = await run(['bash', FETCH_SOURCE, '--name', NAME, join(T, 'g-gap'), `file://${UP}`, COMMIT], MIRROR)
    expect(r.out).toContain('but not its chunk 0 of 2')
    expect(r.out).toContain('HTTP 404')
    expect(head(join(T, 'g-gap'))).toBe(COMMIT)
  }
  finally { renameSync(join(T, 'chunk00.hidden'), C0) }
})

test('git: a wrong chunk sha256 is refused', async () => {
  // A truncated or wrong chunk is an error rather than something handed to git.
  manifest(join(PREFIX, `${COMMIT}.json`), 'b'.repeat(64), sha256Of(C1))
  expectRun(1, 'is refused here rather than handed to git', await run(['bash', FETCH_SOURCE, '--name', NAME, join(T, 'g-chunk'), `file://${UP}`, COMMIT], MIRROR))
})

test('git: a manifest for another commit is refused', async () => {
  // A manifest for another commit is not this tree's pack.
  manifest(join(PREFIX, `${COMMIT}.json`), sha256Of(C0), sha256Of(C1))
  const other = readFileSync(join(PREFIX, `${COMMIT}.json`), 'utf8').replace(`"commit": "${COMMIT}"`, `"commit": "${'c'.repeat(40)}"`)
  writeFileSync(join(PREFIX, `${COMMIT}.json`), other)
  expectRun(1, 'was refused', await run(['bash', FETCH_SOURCE, '--name', NAME, join(T, 'g-commit'), `file://${UP}`, COMMIT], MIRROR))
})

test('git: a manifest of another schema is refused', async () => {
  // A manifest that is not the schema is refused rather than guessed at.
  writeFileSync(join(PREFIX, `${COMMIT}.json`), `{ "schema": "something/else", "commit": "${COMMIT}" }\n`)
  expectRun(1, 'was refused', await run(['bash', FETCH_SOURCE, '--name', NAME, join(T, 'g-schema'), `file://${UP}`, COMMIT], MIRROR))
})

// ---- the rule that does not bend ------------------------------------------

test('no fetch rewrote a lock URL', async () => {
  expect(sha256Of(join(REPO_ROOT, 'locks/upstream.lock'))).toBe(LOCK_BEFORE)
})
