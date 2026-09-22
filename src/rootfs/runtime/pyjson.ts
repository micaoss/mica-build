// JSON as Python's json module writes it, so that a record the Python composer wrote and one this port writes
// are the same bytes: `json.dumps(v, indent=2, sort_keys=True)` for the reports, `json.dumps(v, sort_keys=True,
// separators=(',', ':'), ensure_ascii=True)` for the canonical source lineage. Integers are exact (a bigint is
// written as its digits, which JSON.stringify refuses), non-ASCII is escaped as \uXXXX, and a reader that needs
// the integers back parses with `parse` below, which keeps every integer as a bigint.

export type Value = null | boolean | number | bigint | string | Value[] | { [key: string]: Value }

function escape(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x0d) out += '\\r'
    else if (c === 0x09) out += '\\t'
    else if (c === 0x08) out += '\\b'
    else if (c === 0x0c) out += '\\f'
    else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0')
    else out += s[i]
  }
  return out + '"'
}

function scalar(v: Value): string | undefined {
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('pyjson: non-finite number')
    return Number.isInteger(v) ? v.toString() : String(v)
  }
  if (typeof v === 'string') return escape(v)
  return undefined
}

type Obj = { [key: string]: Value }
function isObj(v: Value): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Python's sort_keys order: code point order of the keys. */
function sortedKeys(o: Obj): string[] {
  return Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** json.dumps(v, indent=2, sort_keys=True) -- pretty, keys sorted, ", " and ": " never trailing. */
export function pretty(v: Value, indent = 2): string {
  const walk = (x: Value, depth: number): string => {
    const s = scalar(x)
    if (s !== undefined) return s
    const pad = ' '.repeat(indent * (depth + 1)), end = ' '.repeat(indent * depth)
    if (Array.isArray(x)) {
      if (x.length === 0) return '[]'
      return '[\n' + x.map(e => pad + walk(e, depth + 1)).join(',\n') + '\n' + end + ']'
    }
    if (!isObj(x)) throw new Error('pyjson: unsupported value')
    const keys = sortedKeys(x)
    if (keys.length === 0) return '{}'
    return '{\n' + keys.map(k => pad + escape(k) + ': ' + walk(x[k]!, depth + 1)).join(',\n') + '\n' + end + '}'
  }
  return walk(v, 0)
}

/** json.dumps(v, sort_keys=True, separators=(',', ':')) -- compact, keys sorted. */
export function compact(v: Value): string {
  const s = scalar(v)
  if (s !== undefined) return s
  if (Array.isArray(v)) return '[' + v.map(compact).join(',') + ']'
  if (!isObj(v)) throw new Error('pyjson: unsupported value')
  return '{' + sortedKeys(v).map(k => escape(k) + ':' + compact(v[k]!)).join(',') + '}'
}

/** JSON.parse with every integer literal kept exact as a bigint (json.loads keeps them as int). */
export function parse(text: string, options: { duplicate?: (key: string) => void } = {}): Value {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++ }
  const fail = (m: string): never => { throw new SyntaxError(`pyjson: ${m} at ${i}`) }
  const value = (): Value => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++; const o: { [key: string]: Value } = {}
      ws(); if (text[i] === '}') { i++; return o }
      for (;;) {
        ws(); if (text[i] !== '"') fail('key expected')
        const k = str(); ws(); if (text[i] !== ':') fail(': expected'); i++
        if (k in o && options.duplicate) options.duplicate(k)
        o[k] = value(); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return o }
        fail(', or } expected')
      }
    }
    if (c === '[') {
      i++; const a: Value[] = []
      ws(); if (text[i] === ']') { i++; return a }
      for (;;) {
        a.push(value()); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return a }
        fail(', or ] expected')
      }
    }
    if (c === '"') return str()
    if (text.startsWith('true', i)) { i += 4; return true }
    if (text.startsWith('false', i)) { i += 5; return false }
    if (text.startsWith('null', i)) { i += 4; return null }
    const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(text.slice(i))
    if (!m) return fail('value expected')
    i += m[0].length
    return m[1] === undefined && m[2] === undefined ? BigInt(m[0]) : Number(m[0])
  }
  const str = (): string => {
    i++; let out = ''
    for (;;) {
      const c = text[i]
      if (c === undefined) fail('unterminated string')
      if (c === '"') { i++; return out }
      if (c === '\\') {
        const e = text[i + 1]
        if (e === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue }
        out += ({ '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' } as Record<string, string>)[e!] ?? fail('bad escape')
        i += 2; continue
      }
      out += c; i++
    }
  }
  const v = value(); ws()
  if (i !== text.length) fail('trailing data')
  return v
}

/** Deep equality of two values as Python compares dicts, lists and scalars (an int and a float compare by value). */
export function equal(a: Value, b: Value): boolean {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) return BigInt(a) === BigInt(b) && (typeof a === 'bigint' || Number.isInteger(a)) && (typeof b === 'bigint' || Number.isInteger(b))
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]!))
  if (isObj(a) && isObj(b)) {
    const ka = sortedKeys(a), kb = sortedKeys(b)
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && equal(a[k]!, b[k]!))
  }
  return a === b
}
