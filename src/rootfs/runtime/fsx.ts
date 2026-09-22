// The filesystem facts and operations the runtime selection needs that Node's fs does not expose: extended
// attributes (the file capabilities a privileged binary carries), a chown that does not follow a symlink, and
// a utime with nanoseconds on a symlink. They are libc calls through bun:ffi -- the composer runs where glibc
// is, in the pack stage and on the build host -- and every failure is a refusal by errno.
import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, type BigIntStats } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export class Refusal extends Error {}

export function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refusal(message)
}

const libc = dlopen('libc.so.6', {
  llistxattr: { args: [FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  lgetxattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  lsetxattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  lremovexattr: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
  lchown: { args: [FFIType.cstring, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  utimensat: { args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
})
const AT_FDCWD = -100
const AT_SYMLINK_NOFOLLOW = 0x100

function cstr(s: string): Buffer {
  return Buffer.from(s + '\0')
}
function errno(): number {
  const p = libc.symbols.__errno_location()
  return p === null ? 0 : read.i32(p, 0)
}

/** The names of a path's extended attributes, without following a symlink, sorted as Python's os.listxattr callers sort them. */
export function listxattr(path: string): string[] {
  const p = cstr(path)
  let size = 1024
  for (;;) {
    const buf = new Uint8Array(size)
    const n = Number(libc.symbols.llistxattr(ptr(p), ptr(buf), BigInt(size)))
    if (n >= 0) return new TextDecoder().decode(buf.subarray(0, n)).split('\0').filter(name => name !== '')
    const e = errno()
    if (e === 34 /* ERANGE */) { size *= 4; continue }
    if (e === 61 /* ENODATA */ || e === 95 /* ENOTSUP */) return []
    throw new Refusal(`listxattr ${path}: errno ${e}`)
  }
}

export function getxattr(path: string, name: string): Uint8Array {
  const p = cstr(path), nm = cstr(name)
  let size = 256
  for (;;) {
    const buf = new Uint8Array(size)
    const n = Number(libc.symbols.lgetxattr(ptr(p), ptr(nm), ptr(buf), BigInt(size)))
    if (n >= 0) return buf.slice(0, n)
    const e = errno()
    if (e === 34) { size *= 4; continue }
    throw new Refusal(`getxattr ${path} ${name}: errno ${e}`)
  }
}

export function setxattr(path: string, name: string, value: Uint8Array): void {
  const v = Buffer.from(value)
  if (libc.symbols.lsetxattr(ptr(cstr(path)), ptr(cstr(name)), ptr(v), BigInt(v.length), 0) !== 0) throw new Refusal(`setxattr ${path} ${name}: errno ${errno()}`)
}

export function removexattr(path: string, name: string): void {
  if (libc.symbols.lremovexattr(ptr(cstr(path)), ptr(cstr(name))) !== 0) throw new Refusal(`removexattr ${path} ${name}: errno ${errno()}`)
}

export function lchown(path: string, uid: number, gid: number): void {
  if (libc.symbols.lchown(ptr(cstr(path)), uid, gid) !== 0) throw new Refusal(`lchown ${path}: errno ${errno()}`)
}

/** Both times of a path set to one nanosecond epoch, the symlink itself when it is one. */
export function lutimesNs(path: string, ns: bigint): void {
  const ts = new BigInt64Array(4)
  ts[0] = ns / 1000000000n; ts[1] = ns % 1000000000n; ts[2] = ts[0]; ts[3] = ts[1]
  if (libc.symbols.utimensat(AT_FDCWD, ptr(cstr(path)), ptr(ts), AT_SYMLINK_NOFOLLOW) !== 0) throw new Refusal(`utimensat ${path}: errno ${errno()}`)
}

/** The hex of every extended attribute of a path, keyed by name, sorted by name. */
export function xattrsOf(path: string): Record<string, string> {
  return Object.fromEntries(listxattr(path).sort().map(name => [name, Buffer.from(getxattr(path, name)).toString('hex')]))
}

export function normalized(path: unknown): string {
  require(typeof path === 'string' && path.startsWith('/') && !/[\0\n\r\t]/.test(path), `invalid absolute path: ${pyRepr(path)}`)
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') {
      require(parts.length > 0, `path escape: ${path}`)
      parts.pop()
    }
    else if (part !== '' && part !== '.') { parts.push(part) }
  }
  return '/' + parts.join('/')
}

/** Python's repr of a value, for the messages that quote one. */
export function pyRepr(value: unknown): string {
  if (typeof value !== 'string') return String(value)
  const q = value.includes('\'') && !value.includes('"') ? '"' : '\''
  let body = ''
  for (const ch of value) {
    const c = ch.codePointAt(0)!
    if (ch === '\\') body += '\\\\'
    else if (ch === '\n') body += '\\n'
    else if (ch === '\r') body += '\\r'
    else if (ch === '\t') body += '\\t'
    else if (ch === q) body += '\\' + q
    else if (c < 0x20 || c === 0x7f) body += '\\x' + c.toString(16).padStart(2, '0')
    else body += ch
  }
  return q + body + q
}

/** Do not let an input/output ancestor symlink redirect a host operation. */
export function hostPath(path: string): string {
  const result = resolve(path)
  require(result !== '/', 'host root is not a runtime input/output')
  const parts = result.split('/').filter(p => p !== '')
  for (let i = 1; i <= parts.length; i++) {
    const parent = '/' + parts.slice(0, i).join('/')
    require(!isSymlink(parent), `host path contains symlink: ${parent}`)
  }
  return result
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() }
  catch { return false }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// mtime_ns is a bigint: a nanosecond epoch does not fit a JavaScript number exactly, and the report records it
// as Python's exact integer (src/rootfs/runtime/pyjson.ts writes it back the same way).
export type Node = {
  type: 'file' | 'directory' | 'symlink'
  mode: number, uid: number, gid: number, mtime_ns: bigint, xattrs: Record<string, string>
  sha256?: string, size?: number, target?: string
}

export function lstatBig(path: string): BigIntStats {
  return lstatSync(path, { bigint: true })
}

const S_IFMT = 0o170000n, S_IFREG = 0o100000n, S_IFDIR = 0o040000n, S_IFLNK = 0o120000n, S_IFCHR = 0o020000n
export const kinds = { isReg: (m: bigint) => (m & S_IFMT) === S_IFREG, isDir: (m: bigint) => (m & S_IFMT) === S_IFDIR, isLnk: (m: bigint) => (m & S_IFMT) === S_IFLNK, isChr: (m: bigint) => (m & S_IFMT) === S_IFCHR }

/** The metadata row of a node: what the report records and what a copy must reproduce. */
export function metadata(path: string): Node {
  const st = lstatBig(path)
  const kind = kinds.isReg(st.mode) ? 'file' : kinds.isDir(st.mode) ? 'directory' : kinds.isLnk(st.mode) ? 'symlink' : undefined
  require(kind !== undefined, `unsupported node: ${path}`)
  const result: Node = { type: kind, mode: Number(st.mode & 0o7777n), uid: Number(st.uid), gid: Number(st.gid), mtime_ns: st.mtimeNs, xattrs: xattrsOf(path) }
  if (kind === 'file') { result.sha256 = sha256File(path); result.size = Number(st.size) }
  if (kind === 'symlink') result.target = readlinkSync(path)
  return result
}

/** setuid, setgid or a file capability on a path, as a comma-separated tag; '' for anything that is not a regular file. */
export function privilege(path: string): string {
  try {
    const st = lstatBig(path)
    if (!kinds.isReg(st.mode)) return ''
    const tags: string[] = []
    if (st.mode & 0o4000n) tags.push('setuid')
    if (st.mode & 0o2000n) tags.push('setgid')
    if (listxattr(path).some(name => name.includes('capability'))) tags.push('capability')
    return tags.join(',')
  }
  catch { return '' }
}

/** Every path of a tree, '/' first, sorted as strings, symlinks never followed. */
export function treePaths(root: string): string[] {
  const result = ['/']
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    const dirs: string[] = [], files: string[] = []
    for (const e of entries) (e.isDirectory() && !e.isSymbolicLink() ? dirs : files).push(e.name)
    for (const name of [...dirs, ...files]) result.push(rel + '/' + name)
    for (const name of dirs) walk(dir + '/' + name, rel + '/' + name)
  }
  walk(root, '')
  return result.sort(cmpStr)
}

/** Python's default string order: by code point. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function exists(path: string): boolean {
  return existsSync(path)
}

export function isAbs(path: string): boolean {
  return isAbsolute(path)
}

/**
 * An error as Python printed it: an OSError as `[Errno N] Strerror: 'path'` (Node spells the same libc
 * strerror in lower case and leads with the code), anything else by its message. The refusals name the
 * failing path the way the Python composer named it, and its tests read them.
 */
export function pyError(e: unknown): string {
  if (e instanceof Error && 'code' in e && typeof (e as { errno?: unknown }).errno === 'number') {
    const n = e as unknown as Error & { errno: number, path?: string, dest?: string, syscall?: string }
    const m = /^[A-Z]+: (.*?), [a-z_0-9]+(?: |$)/.exec(n.message)
    const desc = m ? m[1]! : n.message
    const where = n.path !== undefined ? `: '${n.path}'` + (n.dest !== undefined ? ` -> '${n.dest}'` : '') : ''
    return `[Errno ${-n.errno}] ${desc.charAt(0).toUpperCase()}${desc.slice(1)}${where}`
  }
  return e instanceof Error ? e.message : String(e)
}
