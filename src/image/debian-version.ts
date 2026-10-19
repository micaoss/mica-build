// Debian package versions, `[epoch:]upstream[-revision]`, in dpkg's order: the versions a root `provides` and a core
// component `requires` (mica-core:docs/mica-core.md 6.2). mica-core's reader (mica_deploy::debian_version), ported.

/** The longest version read. */
const MAX_LEN = 64

type Parts = { epoch: number, upstream: string, revision: string }

function parts(version: string): Parts | undefined {
  if (version.length === 0 || version.length > MAX_LEN) return undefined
  let epoch = 0, rest = version
  const colon = version.indexOf(':')
  if (colon >= 0) {
    const e = version.slice(0, colon)
    if (!/^[0-9]{1,9}$/.test(e)) return undefined
    epoch = Number(e)
    rest = version.slice(colon + 1)
  }
  const dash = rest.lastIndexOf('-')
  const upstream = dash < 0 ? rest : rest.slice(0, dash), revision = dash < 0 ? '' : rest.slice(dash + 1)
  const upstreamOk = /^[0-9][A-Za-z0-9.+~-]*$/.test(upstream)
  const revisionOk = dash < 0 || /^[A-Za-z0-9.+~]+$/.test(revision)
  return upstreamOk && revisionOk ? { epoch, upstream, revision } : undefined
}

/** Whether `version` is a Debian version this reader orders. */
export function validDebianVersion(version: unknown): version is string {
  return typeof version === 'string' && parts(version) !== undefined
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

/** dpkg's weight of one character of a non-digit run: `~` before the end, the end before letters, letters before
 * everything else. */
function weight(c: string | undefined): number {
  if (c === undefined) return 0
  if (c === '~') return -1
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0)
  return c.charCodeAt(0) + 256
}

/** dpkg's `verrevcmp`: alternating non-digit and digit runs. */
function comparePart(a: string, b: string): number {
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    for (;;) {
      const x = a[i], y = b[j]
      const xText = x !== undefined && !isDigit(x), yText = y !== undefined && !isDigit(y)
      if (!xText && !yText) break
      const wx = weight(xText ? x : undefined), wy = weight(yText ? y : undefined)
      if (wx !== wy) return wx - wy
      if (xText) i++
      if (yText) j++
    }
    let ni = i, nj = j
    while (isDigit(a[ni])) ni++
    while (isDigit(b[nj])) nj++
    const da = a.slice(i, ni).replace(/^0+/, ''), db = b.slice(j, nj).replace(/^0+/, '')
    if (da.length !== db.length) return da.length - db.length
    if (da !== db) return da < db ? -1 : 1
    i = ni; j = nj
  }
  return 0
}

/** `a` against `b` in dpkg's order (negative, zero, positive); undefined when either is not a version. */
export function compareDebianVersions(a: string, b: string): number | undefined {
  const x = parts(a), y = parts(b)
  if (x === undefined || y === undefined) return undefined
  return Math.sign(x.epoch - y.epoch || comparePart(x.upstream, y.upstream) || comparePart(x.revision, y.revision))
}
