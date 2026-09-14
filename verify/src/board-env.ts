// A board definition, read as DATA.
//
// `_out/boards/<board>/board.env`, out of the fetched board bundle, is the single source of truth for a board and
// every other consumer reads it by `source`-ing it, which executes it: a key
// whose value is `$(rm -rf /)` is not a lint finding, it is a command that has
// already run by the time a checker looks at the parsed result. Nothing here
// ever hands the file to a shell.
//
// So this parses the dialect the real board definitions are written in --
// assignments, comments, quotes, `${NAME}`, `$((arithmetic))` -- and refuses
// everything else that would have been shell, by name. A parser that quietly
// skipped a line it did not understand would produce a definition missing a key.
//
// What it accepts, and every one of these shapes is in a real board.env today:
//
//   `KEY=value` bare; `KEY="two words, and an ="` double quoted, expansions
//   active; `KEY='literal $NOT_EXPANDED'` single quoted, nothing is;
//   `KEY="${OTHER}"` a reference to a key declared above it;
//   `KEY="lit ${OTHER} @SLOT@"` interpolation mixed with literal text;
//   `KEY=$((A * B / C))` integer arithmetic over earlier keys; `KEY=""`
//   declared and empty, NOT the same as absent; `# a comment` whole-line or
//   trailing after a value.
//
// What it refuses, each with its own message naming the construct:
// command substitution in either spelling, backticks, every parameter
// expansion operator (`${X:-y}` and friends), the shell special parameters,
// unquoted whitespace, unquoted metacharacters and globs, line continuations,
// `export`/`local`/`readonly` prefixes, an unterminated quote, a reference to
// a key this file does not define, and anything in `$(( ))` outside integer
// arithmetic.
//
// The default-value refusal is the subtle one. `${BOARD_FIRMWARE_FILES:-}` is the idiom
// every consumer of these files uses and is exactly what makes a shell reader
// unable to tell "declared empty" from "not declared": x64 declares
// BOARD_FIRMWARE_FILES="" and BOARD_HWINIT_CONFS="" on purpose, and `${X:-}`
// renders that identical to a board that forgot them.

/** Where in the file something went wrong, and what was there. */
export class BoardEnvError extends Error {
  readonly path: string
  readonly line: number
  readonly column: number
  /** The offending line, verbatim, so the message stands on its own. */
  readonly sourceLine: string

  constructor(reason: string, where: { path: string, line: number, column: number, sourceLine: string }) {
    super(`${where.path}:${where.line}:${where.column}: ${reason}\n    ${where.sourceLine}`)
    this.name = 'BoardEnvError'
    this.path = where.path
    this.line = where.line
    this.column = where.column
    this.sourceLine = where.sourceLine
  }
}

export interface Assignment {
  readonly key: string
  /** The value after quotes are removed and `${}` / `$(())` are resolved. */
  readonly value: string
  /** The value exactly as written, before any of that. */
  readonly raw: string
  readonly line: number
}

export interface DuplicateAssignment {
  readonly key: string
  /** Line of the assignment that won -- the last one, as a shell would. */
  readonly winner: number
  /** Lines of every assignment it overrode, in file order. */
  readonly overridden: readonly number[]
}

export interface BoardEnvFile {
  readonly path: string
  /** Every assignment, in file order, duplicates included. */
  readonly assignments: readonly Assignment[]
  /** Last-wins, the way a shell would leave the environment. */
  readonly values: ReadonlyMap<string, string>
  /**
   * Keys assigned more than once. Not an error here -- a shell would accept
   * it -- but never silent either: a board definition that says a thing twice
   * is reported so a checker can decide.
   */
  readonly duplicates: readonly DuplicateAssignment[]
}

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/

/** Prefixes that are commands rather than assignments, refused by name. */
const COMMAND_PREFIXES = new Set(['export', 'local', 'readonly', 'declare', 'typeset', 'set', 'source', 'eval', 'unset'])

/**
 * Read a board definition.
 *
 * `text` is the file's contents and `path` is only ever used to build error
 * messages -- nothing here touches the filesystem, so every negative fixture
 * in the test suite is a string literal rather than a temporary file.
 *
 * @throws BoardEnvError on anything it cannot read faithfully.
 */
export function parseBoardEnv(text: string, path: string): BoardEnvFile {
  return new Parser(text, path).parse()
}

class Parser {
  private i = 0
  private readonly lineStarts: number[]

  constructor(private readonly text: string, private readonly path: string) {
    this.lineStarts = [0]
    for (let k = 0; k < text.length; k++) {
      if (text[k] === '\n') this.lineStarts.push(k + 1)
    }
  }

  parse(): BoardEnvFile {
    // CRLF, refused before anything else is read. A shell sourcing a file with
    // DOS line endings puts the carriage return INSIDE every value, so
    // `MICA_ARCH` becomes "arm64\r", which compares unequal to "arm64"
    // while appearing identical in a terminal. Refuse that ambiguity once.
    const cr = this.text.indexOf('\r')
    if (cr !== -1) {
      throw this.errorAt(cr, 'a carriage return: this file has DOS line endings. A shell would make the return part of the value, so every key here would end in an invisible character that compares unequal to what it prints as')
    }

    const assignments: Assignment[] = []
    const values = new Map<string, string>()
    const seen = new Map<string, number[]>()

    for (;;) {
      this.skipInlineSpace()
      if (this.i >= this.text.length) break
      const c = this.text[this.i]!
      if (c === '\n') { this.i++; continue }
      if (c === '#') { this.skipToEndOfLine(); continue }

      const a = this.assignment(values)
      assignments.push(a)
      values.set(a.key, a.value)
      const lines = seen.get(a.key)
      if (lines) lines.push(a.line)
      else seen.set(a.key, [a.line])
    }

    const duplicates: DuplicateAssignment[] = []
    for (const [key, lines] of seen) {
      if (lines.length > 1) {
        duplicates.push({ key, winner: lines[lines.length - 1]!, overridden: lines.slice(0, -1) })
      }
    }

    return { path: this.path, assignments, values, duplicates }
  }

  // one assignment

  private assignment(defined: ReadonlyMap<string, string>): Assignment {
    const startLine = this.lineOf(this.i)
    const nameAt = this.i
    const key = this.readName()

    if (key === '') {
      throw this.errorAt(this.i, `expected NAME=value. A board definition is a list of assignments and comments, and nothing else; ${describe(this.text[this.i])} starts neither`)
    }

    if (this.text[this.i] !== '=') {
      const next = this.text[this.i]
      if ((next === ' ' || next === '\t') && COMMAND_PREFIXES.has(key)) {
        throw this.errorAt(nameAt, `\`${key}\` is a command, not an assignment. This file is never sourced, so the prefix would not run -- write the bare \`NAME=value\` instead of leaving a word here that only means something to a shell`)
      }
      throw this.errorAt(this.i, `\`${key}\` is followed by ${describe(next)}, not \`=\`. Every line here is either NAME=value or a comment`)
    }
    this.i++ // the '='

    const rawFrom = this.i
    const value = this.value(defined, key)
    const raw = this.text.slice(rawFrom, this.i)

    // What follows a value must be nothing, a comment, or the next line. In a
    // shell, `KEY=a b` assigns `a` and then RUNS `b`; a parser that silently
    // took `a` would hand back a value the file does not mean.
    this.skipInlineSpace()
    const after = this.text[this.i]
    if (after !== undefined && after !== '\n' && after !== '#') {
      throw this.errorAt(this.i, `${describe(after)} follows the value of \`${key}\`. Unquoted whitespace ends a value, so everything after it would be a separate word -- a command, if this file were ever sourced. Quote the value if the space belongs to it`)
    }
    if (after === '#') this.skipToEndOfLine()

    return { key, value, raw, line: startLine }
  }

  // a value, as a sequence of segments

  private value(defined: ReadonlyMap<string, string>, key: string): string {
    let out = ''
    for (;;) {
      const c = this.text[this.i]
      if (c === undefined || c === '\n' || c === ' ' || c === '\t') return out
      switch (c) {
        case '"':
          out += this.doubleQuoted(defined, key)
          break
        case '\'':
          out += this.singleQuoted()
          break
        case '$':
          out += this.expansion(defined, key)
          break
        case '`':
          throw this.errorAt(this.i, 'backtick command substitution. A board definition is data; this parser resolves values, it does not run them')
        case '\\':
          if (this.text[this.i + 1] === '\n') {
            throw this.errorAt(this.i, `a line continuation in the value of \`${key}\`. One assignment per line here -- a value spread over two lines reads, to anything scanning this file with grep or sed, as a key that is not set`)
          }
          throw this.errorAt(this.i, 'a backslash escape outside quotes. Quote the value; inside double quotes `\\$`, `\\"`, `\\\\` and `\\`` are the escapes this parser honours')
        case ';': case '&': case '|': case '<': case '>': case '(': case ')':
          throw this.errorAt(this.i, `the shell metacharacter ${describe(c)} outside quotes. Quote it if it is part of the value`)
        case '*': case '?': case '[':
          throw this.errorAt(this.i, `the glob character ${describe(c)} outside quotes. A board definition states values; it does not match filenames`)
        case '~':
          // A shell DOES expand this on the right of an assignment: `A=~/foo`
          // is `/root/foo`. Taking it literally here would be a silent
          // disagreement with every existing consumer of these files, which is
          // the one thing this parser must not be -- so it is refused instead.
          throw this.errorAt(this.i, 'a tilde. A shell expands `~` on the right of an assignment, so a value containing one means different things to different readers and to different users. Write the path out, or quote the tilde to mean it literally')
        default:
          out += c
          this.i++
      }
    }
  }

  private singleQuoted(): string {
    const openAt = this.i
    this.i++ // the opening quote
    const end = this.text.indexOf('\'', this.i)
    if (end === -1) throw this.errorAt(openAt, 'an unterminated single quote; the rest of the file was swallowed by it')
    const out = this.text.slice(this.i, end)
    this.i = end + 1
    return out
  }

  private doubleQuoted(defined: ReadonlyMap<string, string>, key: string): string {
    const openAt = this.i
    this.i++ // the opening quote
    let out = ''
    for (;;) {
      const c = this.text[this.i]
      if (c === undefined) throw this.errorAt(openAt, 'an unterminated double quote; the rest of the file was swallowed by it')
      if (c === '"') { this.i++; return out }
      if (c === '\\') {
        const n = this.text[this.i + 1]
        if (n === '\n') {
          throw this.errorAt(this.i, `a line continuation inside the value of \`${key}\`. One assignment per line here`)
        }
        // Shell honours exactly four escapes inside double quotes; before any
        // other character the backslash is itself literal, and copying that
        // rule is what keeps a path like C:\dir reading as it is written.
        if (n === '$' || n === '"' || n === '\\' || n === '`') { out += n; this.i += 2; continue }
        out += c
        this.i++
        continue
      }
      if (c === '`') throw this.errorAt(this.i, 'backtick command substitution inside a quoted value. Quoting does not disarm it in a shell, and it is refused here for the same reason')
      if (c === '$') { out += this.expansion(defined, key); continue }
      out += c
      this.i++
    }
  }

  // $

  private expansion(defined: ReadonlyMap<string, string>, key: string): string {
    const dollarAt = this.i
    const next = this.text[this.i + 1]

    if (next === '(') {
      if (this.text[this.i + 2] === '(') return this.arithmetic(defined, key)
      throw this.errorAt(dollarAt, 'command substitution `$(...)`. A board definition is data. Nothing here is ever handed to a shell, so this would not run -- it would silently become part of a value, which is worse')
    }

    if (next === '{') {
      this.i += 2
      const nameAt = this.i
      const name = this.readName()
      if (name === '') {
        const c = this.text[this.i]
        if (c === '#') throw this.errorAt(dollarAt, 'the length expansion `${#NAME}`. This parser resolves `${NAME}` and nothing else')
        if (c === '!') throw this.errorAt(dollarAt, 'the indirect expansion `${!NAME}`. This parser resolves `${NAME}` and nothing else')
        throw this.errorAt(nameAt, `\`\${\` is followed by ${describe(c)}, which cannot start a name`)
      }
      const close = this.text[this.i]
      if (close !== '}') {
        throw this.errorAt(this.i, `the parameter expansion operator \`\${${name}${close ?? ''}...}\`. Only \`\${${name}}\` is resolved here. A default, a substitution or a trim would put a value into the board definition that the board definition does not state -- and \`\${X:-}\` in particular is exactly what makes a shell reader unable to tell a key declared empty from a key that is absent`)
      }
      this.i++ // the '}'
      return this.lookup(name, defined, key, dollarAt)
    }

    if (next !== undefined && NAME_START.test(next)) {
      this.i++ // the '$'
      const name = this.readName()
      return this.lookup(name, defined, key, dollarAt)
    }

    if (next === '\'' || next === '"') {
      throw this.errorAt(dollarAt, `ANSI-C quoting \`$${next}...${next}\`, which turns backslash escapes into bytes. This parser resolves \`\${NAME}\` and \`$((arithmetic))\`; write the characters out`)
    }

    throw this.errorAt(dollarAt, `\`$${next ?? ''}\` -- ${next === undefined || next === '\n' || next === ' ' || next === '\t' ? 'a bare `$`' : 'a shell special parameter'}. This parser resolves \`\${NAME}\` and \`$((arithmetic))\`; write '\\$' inside double quotes, or single-quote the value, if the character is meant literally`)
  }

  private lookup(name: string, defined: ReadonlyMap<string, string>, key: string, at: number): string {
    const v = defined.get(name)
    if (v === undefined) {
      // Deliberately NOT falling back to process.env. A board definition that
      // resolved differently depending on who ran the reader would not be a
      // definition. And an unset reference is the failure the retired shell
      // lint recorded: under `set -u` the shell died at the first line of the
      // file, the board contributed zero assertions, and the run reported PASS.
      throw this.errorAt(at, `\`\${${name}}\` is referenced by \`${key}\` but this file has not defined it above. A board definition is self-contained -- the process environment is not consulted, deliberately, because a definition that changes with the caller is not one`)
    }
    return v
  }

  // $(( ))

  private arithmetic(defined: ReadonlyMap<string, string>, key: string): string {
    const openAt = this.i
    this.i += 3 // '$(('
    let depth = 2
    const bodyFrom = this.i
    while (depth > 0) {
      const c = this.text[this.i]
      if (c === undefined) throw this.errorAt(openAt, 'an unterminated `$((` -- no matching `))` before the end of the file')
      if (c === '(') depth++
      else if (c === ')') depth--
      this.i++
    }
    const body = this.text.slice(bodyFrom, this.i - 2)
    const value = evaluateArithmetic(body, name => {
      const v = defined.get(name)
      if (v === undefined) {
        throw this.errorAt(openAt, `\`${name}\` appears in the arithmetic for \`${key}\` but this file has not defined it above. A shell would quietly call it zero; a size or an offset computed from an accidental zero is how a partition lands on top of another one`)
      }
      if (!/^[+-]?[0-9]+$/.test(v.trim())) {
        throw this.errorAt(openAt, `\`${name}\` is \`${v}\`, which is not an integer, and it appears in the arithmetic for \`${key}\``)
      }
      return BigInt(v.trim())
    }, (reason: string) => this.errorAt(openAt, `${reason}, in the arithmetic for \`${key}\``))
    return value.toString()
  }

  // scanning helpers

  private readName(): string {
    const from = this.i
    const first = this.text[this.i]
    if (first === undefined || !NAME_START.test(first)) return ''
    this.i++
    while (this.i < this.text.length && NAME_CHAR.test(this.text[this.i]!)) this.i++
    return this.text.slice(from, this.i)
  }

  private skipInlineSpace(): void {
    while (this.i < this.text.length) {
      const c = this.text[this.i]
      if (c === ' ' || c === '\t') this.i++
      else return
    }
  }

  private skipToEndOfLine(): void {
    const nl = this.text.indexOf('\n', this.i)
    this.i = nl === -1 ? this.text.length : nl + 1
  }

  private lineOf(offset: number): number {
    // The line starts are ascending, so a binary search is exact; a linear
    // scan would be O(file x assignments) and these files are read often.
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  private errorAt(offset: number, reason: string): BoardEnvError {
    const at = Math.min(offset, this.text.length)
    const line = this.lineOf(at)
    const from = this.lineStarts[line - 1]!
    const nl = this.text.indexOf('\n', from)
    return new BoardEnvError(reason, {
      path: this.path,
      line,
      column: at - from + 1,
      sourceLine: this.text.slice(from, nl === -1 ? this.text.length : nl),
    })
  }
}

function describe(c: string | undefined): string {
  if (c === undefined) return 'the end of the file'
  if (c === '\n') return 'the end of the line'
  if (c === ' ') return 'a space'
  if (c === '\t') return 'a tab'
  return `\`${c}\``
}

// integer arithmetic, and nothing else
//
// `$(( ))` in a shell is a small imperative language: it assigns, it
// increments, it short-circuits, it indexes arrays. The board definitions use
// exactly five operators over earlier keys, so that is the whole grammar here,
// and everything else is refused by name rather than approximated.
//
// BigInt, not number, because these are byte offsets. A 64-bit disk offset
// exceeds what a double represents exactly, and a size that is silently one
// byte out is the class of defect this whole package exists to make visible.
// BigInt division truncates toward zero, which is what a shell does.

type NumberLookup = (name: string) => bigint
type Reject = (reason: string) => Error

export function evaluateArithmetic(body: string, lookup: NumberLookup, reject: Reject): bigint {
  let i = 0

  const skip = (): void => { while (i < body.length && /\s/.test(body[i]!)) i++ }

  const primary = (): bigint => {
    skip()
    const c = body[i]
    if (c === undefined) throw reject('the arithmetic ends where a value was expected')
    if (c === '(') { i++; const v = expression(0); skip(); if (body[i] !== ')') throw reject('an unclosed `(`'); i++; return v }
    if (c === '+') { i++; return primary() }
    if (c === '-') { i++; return -primary() }
    if (c === '$') {
      if (body[i + 1] === '(') throw reject('command substitution inside `$(( ))`')
      i++
      if (body[i] === '{') {
        i++
        const n = readName()
        if (body[i] !== '}') throw reject(`a parameter expansion operator in \`\${${n}...}\``)
        i++
        return lookup(n)
      }
      const n = readName()
      if (n === '') throw reject('a `$` that names nothing')
      return lookup(n)
    }
    if (c === '`') throw reject('backtick command substitution inside `$(( ))`')
    if (/[0-9]/.test(c)) {
      const from = i
      while (i < body.length && /[0-9a-zA-Z]/.test(body[i]!)) i++
      const lit = body.slice(from, i)
      if (/^0[xX]/.test(lit)) throw reject(`the hexadecimal literal \`${lit}\`; write it in decimal, so that every number in a board definition reads the same way`)
      if (!/^[0-9]+$/.test(lit)) throw reject(`\`${lit}\`, which is not a decimal integer`)
      if (lit.length > 1 && lit[0] === '0') throw reject(`\`${lit}\`: a leading zero means octal to a shell and decimal to a reader, and the two disagree from \`010\` onwards`)
      return BigInt(lit)
    }
    if (NAME_START.test(c)) return lookup(readName())
    throw reject(`${describe(c)}, which is not part of integer arithmetic`)
  }

  const readName = (): string => {
    const from = i
    const first = body[i]
    if (first === undefined || !NAME_START.test(first)) return ''
    i++
    while (i < body.length && NAME_CHAR.test(body[i]!)) i++
    return body.slice(from, i)
  }

  // Precedence climbing over the five operators the board definitions use.
  const BINARY: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 }

  const expression = (minPrec: number): bigint => {
    let left = primary()
    for (;;) {
      skip()
      const c = body[i]
      if (c === undefined || c === ')') return left
      if (c === '*' && body[i + 1] === '*') throw reject('exponentiation `**`; this grammar is `+ - * / %` over the keys above')
      const prec = BINARY[c]
      if (prec === undefined) {
        if (c === '=' || (body[i + 1] === '=' && '<>!'.includes(c))) throw reject(`the operator \`${c}${body[i + 1] === '=' ? '=' : ''}\`; a board definition states values, it does not compare or assign them`)
        throw reject(`${describe(c)}, which is not one of the operators \`+ - * / %\``)
      }
      // A LOWER-PRECEDENCE operator is not an error, it is the end of THIS
      // sub-expression: `A * B / C` reaches here at the `/` with minPrec set
      // by the `*`, and the caller's loop is what consumes it. Throwing here
      // instead -- which the first version did -- refused every board
      // definition that mixes two precedences, and x64 does, twice per
      // partition.
      if (prec < minPrec) return left
      i++
      const right = expression(prec + 1)
      if ((c === '/' || c === '%') && right === 0n) throw reject(`a division by zero (\`${c}\`)`)
      left = c === '+' ? left + right : c === '-' ? left - right : c === '*' ? left * right : c === '/' ? left / right : left % right
    }
  }

  const result = expression(0)
  skip()
  if (i < body.length) throw reject(`a trailing \`${body.slice(i)}\``)
  return result
}
