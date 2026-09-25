// No toolchain on the host. No compilation on the host. No assembly on the host.
//
//   bun tests/gates/host-toolchain-lint.ts                 (or: make os-host-toolchain-lint)
//   bun tests/gates/host-toolchain-lint.ts --root DIR      scan another checkout (tests/gates/host-toolchain-lint.test.ts)
//   bun tests/gates/host-toolchain-lint.ts --print-tools   the table below, one tool per line, and nothing else
//                                                          (tests/suites/bare-host-gate/ladder.sh)
//
// The policy is mica:docs/design/build.md section 0, and this is what makes it fail. It exists because that page has
// carried the claim -- "no toolchain is installed on the host, and every compiler comes out of a builder image pinned
// by digest" -- for as long as it has existed, while paths that contradict it sat in the tree with nothing going red.
//
// WHAT IT LOOKS FOR. Three shapes over two surfaces. In shell: one producer binary in command position, in a file
// that has not declared itself container-side -- and one PATH assignment that prepends a directory under $HOME, which
// is how a script reaches for a toolchain that is not on the machine's PATH at all (micad:hack/check.sh finds a cargo
// only because its line 8 puts $HOME/.cargo/bin in front). In TypeScript: one producer binary NAMED by a process
// launch -- a bun shell template or an argv-taking spawn. A producer is a tool whose own build can change the bytes
// it writes: a compiler, a filesystem maker, an image assembler, a packer, a signer. mica:docs/design/build.md
// section 0 states the test that decides whether a new tool belongs in the table below; this file is the table, not
// the rule.
//
// WHAT IT CANNOT SEE, said here rather than discovered later:
//
//   - A binary invoked through a VARIABLE. `"${MKIMAGE}" -T script` is a real mkimage call and nothing here matches
//     it; a file of that shape is covered only if it declares its side.
//   - A HEREDOC BODY. Bodies are skipped whole. (A comment that merely MENTIONS one does not open it: comments are
//     looked at first, or a `# ... <<EOF` in prose would elide the rest of the file and still report it clean.)
//     Every heredoc in this tree that carries a producer carries a CONTAINER script.
//   - A STRING THAT SPANS LINES. What a quoted string makes literal is not a command position, so quoted spans are
//     blanked before a producer is looked for. That is done a line at a time, so a quote opened on one line and
//     closed on another leaves the first line unbalanced, and an unbalanced line is matched exactly as it came: the
//     cost is a false positive and never a missed one. A COMMAND SUBSTITUTION IS NOT LITERAL and stays visible
//     wherever it sits: `"$(cargo build)"` is a finding.
//   - A SCRIPT WRITTEN INTO A QUOTED ARGUMENT, for the same reason and with the same answer as a heredoc body:
//     `bash -c 'cd x && cargo build'` is not seen, because nothing here can tell it from `docker run ... sh -c
//     'mkfs.ext4 ...'`, which is the toolbox.
//   - A DECLARATION THAT IS WRONG. `# mica-build-side: container` is a claim by whoever wrote it. This counts the
//     claims and refuses a run that found none; it cannot check one.
//   - A TYPESCRIPT LAUNCH THROUGH A VARIABLE. `$`${docker} exec ...`` and `Bun.spawn(argv)` resolve at runtime; they
//     are counted and reported as unresolved rather than passed over silently.
//   - A TYPESCRIPT WHOLE-FILE MARKER ONLY. `// mica-build-side: container -- <why>` in a file's leading comment
//     declares the whole file, as `#` does for shell. No block form: a TypeScript file runs on one side.
//
// DECLARING A SIDE. Two markers, both requiring a reason after `--`:
//
//   # mica-build-side: container -- <why>          the whole FILE runs in an image; must appear before any code
//   # mica-build-side: container-block -- <why>    the lines BELOW run in an image
//   # mica-build-side: host                        ...and here they stop
//
// EXEMPTIONS live in tests/fixtures/host-toolchain-exemptions, one `path<TAB>tool<TAB>reason` per site, and an
// exemption that matches NOTHING is a failure -- a rename must not leave a rule behind about a file that has moved,
// and a path that stops violating the policy must not keep a silent waiver.
//
// The port of tests/gates/host-toolchain-lint.sh (deleted 2026-09-25) and its two awk scanners, rule for rule and
// message for message; the RESULT line over this tree was the same when it moved.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

// THE TABLE, by kind, with the reason each kind is in it. It is not the policy -- mica:docs/design/build.md section 0
// is -- but a reader adding a row should be able to see which arm of that test the row belongs to.
//
//   toolchain   a compiler decides the bytes even when the binary is discarded: `cargo clippy -- -D warnings` turns
//               a toolchain difference into red or green (mica:docs/design/build-harness.md section 3 measured a
//               1.96 rustc ahead of the image's 1.98 reporting `can't find crate for std`).
//   filesystem  which e2fsprogs, which mkfs.vfat. This host's mkfs.vfat is BusyBox's and does not know `--invariant`.
//   assembly    which sgdisk, which grub-efi-amd64-bin. BOOTX64.EFI is only as reproducible as its container's.
//   package     which dpkg, which rauc. A bundle built by rauc 1.8 was refused by a device's 1.13 (commit 9a43a59).
//   signing     what openssl writes into a certificate is openssl's decision.
//
// NOT in the table, deliberately: `cc`, `ld`, `go`, `make`, `tar`, `install`. Each is either a word that appears
// constantly in prose and in paths, or orchestration by the section-0 test. A rule whose findings are mostly false
// positives teaches people to ignore it, which is worse than no rule. `jq` is orchestration nearly everywhere here,
// and the table cannot tell its one producing use from its verdicts by the binary's name.
//
// ONE TABLE, TWO READERS: tests/suites/bare-host-gate/ladder.sh asserts that none of these is reachable inside the
// container standing in for the criterion's host, and reads them from --print-tools rather than keeping its own list.
export const TOOLS = [
  'cargo', 'rustc', 'gcc', 'g++', 'tsc', 'bun',
  'mkfs.vfat', 'mkfs.ext4', 'mkfs.fat', 'mke2fs', 'mksquashfs', 'unsquashfs', 'debugfs', 'dumpe2fs', 'e2fsck', 'resize2fs', 'tune2fs',
  'sgdisk', 'sfdisk', 'parted', 'mcopy', 'mmd', 'mkimage', 'mkenvimage', 'veritysetup', 'grub-mkstandalone', 'grub-install', 'grub-editenv',
  'dpkg-deb', 'dpkg-buildpackage', 'dpkg-scanpackages', 'apt-ftparchive', 'rauc',
  'openssl', 'gpg',
]
const ALTERNATION = TOOLS.map(t => t.replace(/[.+]/g, '\\$&')).join('|')
const SHELL_TOOL = new RegExp(`(^|[;&|(]|&&|\\|\\|)\\s*(${ALTERNATION})(\\s|$)`)
const IS_TOOL = new RegExp(`^(${ALTERNATION})$`)
const EXEMPTIONS = 'tests/fixtures/host-toolchain-exemptions'

export type Line = { stream: 'out' | 'err', text: string }
type Record = { kind: 'hit' | 'err' | 'stat', line: number, a: string, b: string }

// WHAT A QUOTED STRING MAKES LITERAL IS NOT A COMMAND POSITION. The line with those spans blanked to `Q`, so the
// match reads only what the shell would run: `operator_step "install the GOOD bundle (rauc install <bundle>), ..."`
// is one English sentence, and its `(` read as a command separator was a registered false positive. A COMMAND
// SUBSTITUTION IS STILL CODE, wherever it sits: `$( )` and backticks are handed back untouched, including from inside a
// double-quoted string, and a `'...'` span is blanked whole because nothing expands in one. A LINE THAT ENDS INSIDE A
// QUOTE IS RETURNED AS IT CAME.
function codeOnly(s: string): string {
  if (!s.includes('"') && !s.includes('\'')) return s
  const stack: string[] = []
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!, st = stack.at(-1) ?? ''
    if (st === '\'') { out += 'Q'; if (c === '\'') stack.pop(); continue }
    if (c === '\\') { out += st === '"' ? 'QQ' : s.slice(i, i + 2); i++; continue }
    if (c === '$' && s[i + 1] === '(') { stack.push('('); out += '$('; i++; continue }
    if (c === '`') { if (st === '`') stack.pop(); else stack.push('`'); out += '`'; continue }
    if (st === '(' && c === ')') { stack.pop(); out += ')'; continue }
    if (st === '"') { out += 'Q'; if (c === '"') stack.pop(); continue }
    if (c === '"' || c === '\'') { stack.push(c); out += 'Q'; continue }
    out += c
  }
  return stack.length > 0 ? s : out
}

/** One shell file's records: hits, errors and the counts, in line order, with the unclosed-block error last. */
function scanShell(text: string): Record[] {
  const out: Record[] = []
  const emit = (kind: Record['kind'], line: number, a: string, b = '') => out.push({ kind, line, a, b })
  let hd = '', code = 0, filedecl = false, block = false, examined = 0, elided = 0, blockline = 0
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  lines.forEach((raw, index) => {
    const nr = index + 1
    let line = raw
    // --- heredoc bodies, skipped whole ---
    if (hd !== '') {
      elided++
      if (new RegExp(`^\\s*${hd}\\s*$`).test(line)) hd = ''
      return
    }
    // COMMENTS FIRST, and the order is load-bearing: a comment that MENTIONS a heredoc would otherwise open one here
    // and elide every line until something matched the terminator.
    if (/^\s*#/.test(line)) {
      if (/^\s*#\s*mica-build-side:/.test(line)) {
        if (/^\s*#\s*mica-build-side:\s*container\s*--\s*\S/.test(line)) {
          if (code) { emit('err', nr, `a whole-file container declaration must come before any code; this one is after line ${code}`); return }
          filedecl = true
          emit('stat', nr, 'filedecl')
          return
        }
        if (/^\s*#\s*mica-build-side:\s*container-block\s*--\s*\S/.test(line)) {
          if (block) { emit('err', nr, `a container block opened at line ${blockline} is still open`); return }
          block = true
          blockline = nr
          emit('stat', nr, 'blockdecl')
          return
        }
        if (/^\s*#\s*mica-build-side:\s*host\s*$/.test(line)) {
          if (!block) { emit('err', nr, 'a `mica-build-side: host` closes a container block that was never opened'); return }
          block = false
          return
        }
        // A marker with no reason is a rubber stamp; refuse it by name rather than ignoring it.
        emit('err', nr, 'malformed `mica-build-side:` marker; the forms are `container -- <why>`, `container-block -- <why>` and `host`')
      }
      return
    }
    const heredoc = line.includes('<<<') ? null : /<<-?\s*["']?[A-Za-z_][A-Za-z0-9_]*["']?/.exec(line)
    if (heredoc !== null) hd = heredoc[0].replace(/^<<-?\s*/, '').replace(/["']/g, '')
    if (/^\s*$/.test(line)) return
    if (!code && !line.startsWith('#!')) code = nr
    if (filedecl || block) { elided++; return }
    // --- what is not a command position ---
    // A `case` label: strip up to the first `)` when nothing before it opens a substitution, so `rauc | updates) ;;`
    // is a pattern and `x509) text=$(openssl ...)` keeps its openssl.
    const label = /^\s*[^()$]*\)/.exec(line)
    if (label !== null) line = line.slice(label[0].length)
    line = line.replace(/^\s+/, '')
    // An echo/printf ARGUMENT. Prose naming a tool is not a call to it.
    if (/^(echo|printf)\s/.test(line)) return
    examined++
    // THE SECOND SHAPE, narrow to $HOME and ~, so that the fixture PATHs the test suites build out of a directory the
    // test just made are not findings.
    if (/(^|\s|;)(export\s+)?PATH=.*(\$HOME|\$\{HOME\}|~\/)/.test(line)) emit('hit', nr, 'host-toolchain-on-PATH', raw)
    const m = SHELL_TOOL.exec(codeOnly(line))
    if (m !== null) emit('hit', nr, m[2]!, raw)
  })
  if (block) emit('err', lines.length, `a container block opened at line ${blockline} is never closed; every line after it was skipped`)
  emit('stat', lines.length, 'examined', String(examined))
  emit('stat', lines.length, 'elided', String(elided))
  return out
}

/** The whole-file declaration of a TypeScript file: in its leading comment, before any code, with a reason. */
function tsDeclaration(text: string): 'declared' | 'malformed' | `late ${number}` | '' {
  let code = 0
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (/^\s*$/.test(line)) continue
    if (/^\s*\/\//.test(line)) {
      if (!/^\s*\/\/\s*mica-build-side:/.test(line)) continue
      if (!/^\s*\/\/\s*mica-build-side:\s*container\s*--\s*\S/.test(line)) return 'malformed'
      if (code) return `late ${code}`
      return 'declared'
    }
    if (!code) code = i + 1
  }
  return ''
}

// A small scanner rather than a grep, because the distinguishing feature is WHERE a backtick sits: `new
// RegExp(`^${k}=(.*)$`, 'm')` ends a template with a regex anchor immediately before the closing backtick, and a grep
// for `$` followed by a backtick calls that a bun shell call. A FILE THAT DOES NOT SCAN BACK TO CODE STATE IS A
// FINDING: an unterminated template or a misread regex would otherwise swallow the rest of the file and report it clean.
/** The launch sites of a TypeScript file -- [line, the command it names or ''] -- and the scanner's own error. */
function scanTypeScript(s: string): { sites: [number, string][], error?: [number, string] } {
  const sites: [number, string][] = []
  const n = s.length, stack: string[] = []
  let st = 'code', depth = 0, prev = '', line = 1, i = 0, inclass = false
  const ws = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  // The first word of a bun shell template, from just past the backtick.
  const tpl = (p: number, ln: number) => {
    let j = p
    while (j < n && (s[j] === ' ' || s[j] === '\t')) j++
    if (s.slice(j, j + 2) === '${') { sites.push([ln, '']); return }
    let w = ''
    while (j < n && !' \t\n`\\'.includes(s[j]!)) w += s[j++]
    sites.push([ln, w])
  }
  // The command an argv-taking launcher names, from just past its paren: an array, a bare string, or { cmd: [...] }.
  const spawn = (p: number, ln: number) => {
    let j = p
    while (j < n && ws(s[j])) j++
    let c = s[j]
    if (c === '{') {
      const m = /cmd[ \t\n]*:[ \t\n]*\[/.exec(s.slice(j, j + 400))
      if (m === null) { sites.push([ln, '']); return }
      j += m.index + m[0].length - 1
      c = '['
    }
    if (c === '[') {
      j++
      while (j < n && ws(s[j])) j++
      c = s[j]
    }
    if (c !== '\'' && c !== '"' && c !== '`') { sites.push([ln, '']); return }
    const q = c
    let w = ''
    for (j++; j < n; j++) {
      const d = s[j]!
      if (d === '\\') { j++; continue }
      if (d === q) break
      if (d === '$' && q === '`') { sites.push([ln, '']); return }
      w += d
    }
    sites.push([ln, w])
  }
  while (i < n) {
    const c = s[i]!
    if (c === '\n') line++
    if (st === 'lc') { if (c === '\n') st = 'code'; i++; continue }
    if (st === 'bc') { if (c === '*' && s[i + 1] === '/') { st = 'code'; i += 2; continue } i++; continue }
    if (st === 'sq' || st === 'dq' || st === 're') {
      if (c === '\\') { i += 2; continue }
      if (st === 're' && c === '[') { inclass = true; i++; continue }
      if (st === 're' && c === ']') { inclass = false; i++; continue }
      if (st === 'sq' && c === '\'') { st = 'code'; prev = '\'' }
      else if (st === 'dq' && c === '"') { st = 'code'; prev = '"' }
      else if (st === 're' && c === '/' && !inclass) { st = 'code'; prev = '/' }
      i++
      continue
    }
    if (st === 'tpl') {
      if (c === '\\') { i += 2; continue }
      // A ${ } is CODE again, and `prev` is reset with it: otherwise the tag's own $ would make an inner template
      // read as a second tagged call.
      if (c === '$' && s[i + 1] === '{') { stack.push('tpl'); st = 'code'; depth = 0; prev = ''; i += 2; continue }
      if (c === '`') { st = 'code'; prev = '`' }
      i++
      continue
    }
    // --- code ---
    if (ws(c)) { i++; continue }
    if (c === '/') {
      const d = s[i + 1]
      if (d === '/') { st = 'lc'; i += 2; continue }
      if (d === '*') { st = 'bc'; i += 2; continue }
      // Regex or division, decided by what came before -- the standard rule. It matters because a regex may hold
      // `//`, which read as a comment would elide the rest of the line.
      if (prev === '' || '([{,;:=!&|?+-*%~^<>'.includes(prev)) { st = 're'; inclass = false; i++; continue }
      prev = '/'
      i++
      continue
    }
    if (c === '\'') { st = 'sq'; i++; continue }
    if (c === '"') { st = 'dq'; i++; continue }
    if (c === '{') { if (stack.length > 0) depth++; prev = '{'; i++; continue }
    if (c === '}') {
      if (stack.length > 0 && depth === 0) { st = stack.pop()!; prev = '}'; i++; continue }
      if (stack.length > 0) depth--
      prev = '}'
      i++
      continue
    }
    if (c === '`') {
      if (prev === '$') tpl(i + 1, line) // bun's shell tag
      st = 'tpl'
      i++
      continue
    }
    if (c === '$') { prev = '$'; i++; continue }
    if (c === 's' || c === 'e' || c === 'B') {
      const m = /^(Bun\.)?(spawnSync|spawn|execFileSync|execFile)[ \t\n]*\(/.exec(s.slice(i, i + 40))
      // `.spawn` as a method on something else is not one of these; `Bun.spawn` is, and says so.
      if (m !== null && (prev !== '.' || m[1] !== undefined)) {
        spawn(i + m[0].length, line)
        i += m[0].length
        prev = '('
        continue
      }
    }
    prev = c
    i++
  }
  if (st !== 'code' || stack.length > 0) return { sites, error: [line, `this file did not scan back to code state (ended in '${st}'), so the scan cannot claim to have read it`] }
  return { sites }
}

const git = (root: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return [...new Set(r.stdout.toString().split('\n').filter(l => l !== ''))].sort()
}
const isFile = (p: string) => existsSync(p) && statSync(p).isFile()

/** The lint over one checkout: every line it prints, and its exit status. */
export function lint(root: string, quiet = false): { code: number, lines: Line[] } {
  const lines: Line[] = []
  const say = (text: string) => lines.push({ stream: 'out', text })
  const refuse = (...text: string[]) => { for (const t of text) lines.push({ stream: 'err', text: t }); return { code: 1, lines } }
  let passN = 0, failN = 0
  const pass = (m: string) => { passN++; if (!quiet) say(`PASS: ${m}`) }
  const fail = (m: string) => { failN++; say(`FAIL: ${m}`) }

  // AN UNRESOLVED MERGE IS REFUSED. git ls-files lists a path once per index stage, so every count below would be
  // inflated -- quietly, in the direction of "more files clean than the tree has".
  const unmerged = git(root, 'diff', '--name-only', '--diff-filter=U')
  if (unmerged.length > 0) return refuse(`error: this tree has ${unmerged.length} unresolved merge conflict(s), so the counts below would be wrong:`, ...unmerged.map(u => `         ${u}`))
  // The surface. DOCKERFILES ARE NOT SCANNED and that is not an oversight: a Dockerfile IS a container. The list
  // comes from git, so a script added to the tree is covered the day it lands.
  const files = git(root, 'ls-files', '*.sh', 'Makefile', '*/Makefile', '.github/workflows/*.yml')
  if (files.length === 0) return refuse('error: no shell scripts, Makefiles or workflows found; this lint would pass by finding nothing')

  // The exemption register. Absent means empty, which is the state a fixture checkout is in.
  const exemptReason = new Map<string, string>(), exemptHits = new Map<string, number>()
  let exemptN = 0
  if (isFile(join(root, EXEMPTIONS))) {
    for (const row of readFileSync(join(root, EXEMPTIONS), 'utf8').split('\n')) {
      const [epath = '', etool = '', ...rest] = row.split('\t')
      if (epath === '' || epath.startsWith('#')) continue
      const ereason = rest.join('\t')
      if (etool === '' || ereason === '') return refuse(`error: ${EXEMPTIONS}: '${epath}' has no tool or no reason. An exemption without a reason is a waiver nobody can review`)
      exemptReason.set(`${epath}|${etool}`, ereason)
      exemptHits.set(`${epath}|${etool}`, 0)
      exemptN++
    }
  }
  const exempt = (key: string) => {
    if (!exemptReason.has(key)) return false
    exemptHits.set(key, exemptHits.get(key)! + 1)
    return true
  }

  let scanned = 0, examined = 0, declaredFiles = 0, declaredBlocks = 0, elided = 0
  for (const f of files) {
    if (!isFile(join(root, f))) continue
    scanned++
    let hits = 0
    for (const r of scanShell(readFileSync(join(root, f), 'utf8'))) {
      if (r.kind === 'err') { fail(`${f}:${r.line}: ${r.a}`); hits++ }
      else if (r.kind === 'stat') {
        if (r.a === 'filedecl') declaredFiles++
        else if (r.a === 'blockdecl') declaredBlocks++
        else if (r.a === 'examined') examined += Number(r.b)
        else if (r.a === 'elided') elided += Number(r.b)
      }
      else {
        if (exempt(`${f}|${r.a}`)) continue
        hits++
        if (r.a === 'host-toolchain-on-PATH') fail(`${f}:${r.line}: this prepends a directory under $HOME to PATH, which is how a script reaches a toolchain the machine's package management never installed and nothing pins. See mica:docs/design/build.md section 0. Register it in ${EXEMPTIONS} as '${f}<TAB>host-toolchain-on-PATH<TAB><why>' if it cannot move yet.`)
        else fail(`${f}:${r.line}: \`${r.a}\` runs on the host. Producers run in a container pinned in locks/ (bin/bun.sh src/cli.ts from); see mica:docs/design/build.md section 0. If this line runs INSIDE an image, say so with \`# mica-build-side: container-block -- <why>\`; if it cannot move yet, register it in ${EXEMPTIONS} with the reason.`)
      }
    }
    if (hits === 0) pass(f)
  }

  // --- the second surface: TypeScript. The toolbox seams are closed in code and nothing stops another from being
  // written: a call site that names a producer directly, `$`mksquashfs ...`` or `Bun.spawn(['sgdisk', ...])`. THE
  // TABLE IS THE SAME TABLE, and this asks only what the FIRST WORD is, so a producer handed to `docker run` as an
  // argument -- which is the entire toolbox -- is not a finding.
  let tsFiles = 0, tsSites = 0, tsNamed = 0, tsVariable = 0
  for (const f of git(root, 'ls-files', '*.ts')) {
    if (!isFile(join(root, f))) continue
    tsFiles++
    const text = readFileSync(join(root, f), 'utf8')
    const decl = tsDeclaration(text)
    if (decl === 'malformed') { fail(`${f}: malformed \`mica-build-side:\` marker; the one TypeScript form is \`// mica-build-side: container -- <why>\``); scanned++; continue }
    if (decl.startsWith('late')) { fail(`${f}: a whole-file container declaration must come before any code; this one is after line ${decl.slice(5)}`); scanned++; continue }
    if (decl === 'declared') declaredFiles++
    let hits = 0
    const { sites, error } = scanTypeScript(text)
    for (const [line, named] of sites) {
      tsSites++
      if (named === '') { tsVariable++; continue }
      tsNamed++
      // A declared file launches its producers inside its image; the site is counted, not judged.
      if (decl === 'declared') continue
      // A path is still the binary it ends in.
      const tool = basename(named)
      if (!IS_TOOL.test(tool) || exempt(`${f}|${tool}`)) continue
      hits++
      fail(`${f}:${line}: this launches \`${tool}\` on the host. src/image and src/verify reach every producer through a container -- src/image/toolbox.ts and src/verify/tools.ts are the seams -- so a call site that names one directly is a fifth seam nobody declared. See mica:docs/design/build.md section 0.`)
    }
    if (error !== undefined) { fail(`${f}:${error[0]}: ${error[1]}`); hits++ }
    if (hits === 0) pass(f)
    scanned++
  }

  // --- the controls, so this cannot report clean over nothing ---
  if (examined === 0) return refuse(`error: ${files.length} shell file(s) were opened and not one command line was examined. The elisions above swallowed the whole tree, which is a broken scan and not a clean one`)
  // This tree's TypeScript launches processes, so a scan that opened .ts files and found no launch site has found a
  // scanner whose state machine stopped agreeing with the language, not a clean tree.
  if (tsFiles > 0 && tsSites === 0) return refuse(`error: ${tsFiles} TypeScript file(s) were scanned and not one process launch was found. src/image and src/verify drive docker; a scan that sees none of it is measuring nothing`)
  // THE POSITIVE CONTROL. This tree assembles images and compiles Rust, so a run that found no container-side
  // declaration at all has found a pattern that no longer matches, not the build.
  if (declaredFiles + declaredBlocks === 0) return refuse(`error: no container-side declaration was found in ${scanned} file(s). This repository builds images; a scan that sees no producer running in a container is measuring nothing`)
  // AN EXEMPTION THAT MATCHES NOTHING: the path moved and the rule was left behind, or the waiver outlived the fix.
  let exempted = 0
  for (const [key, hits] of exemptHits) {
    if (hits === 0) fail(`${EXEMPTIONS}: '${key.replace('|', ' ')}' matches nothing. Either the file moved and this rule was left behind, or the invocation is gone and the waiver outlived it; delete it or point it at what it means.`)
    exempted += hits
  }
  // The numbers are the point, and they are separate numbers on purpose: a file count alone cannot tell a clean tree
  // from a scan whose pattern stopped matching, and a finding count alone cannot tell "nothing wrong" from "nothing
  // looked at".
  say(`RESULT: ${failN === 0 ? 'PASS' : 'FAIL'} (${passN}/${scanned} files clean, ${failN} finding(s), ${examined} shell command lines examined, ${elided} elided, ${tsSites} TypeScript launch sites examined in ${tsFiles} file(s) (${tsNamed} naming a command, ${tsVariable} through a variable), ${declaredFiles} file + ${declaredBlocks} block container declarations, ${exempted} exempted invocation(s) under ${exemptN} rule(s))`)
  return { code: failN === 0 ? 0 : 1, lines }
}

function main(argv: string[]): number {
  let root = resolve(import.meta.dir, '../..')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--print-tools') { for (const t of TOOLS) console.log(t); return 0 }
    if (argv[i] === '--root') {
      if (!argv[i + 1]) { console.error('error: --root takes a directory'); return 1 }
      root = resolve(argv[++i]!)
      continue
    }
    console.error(`error: '${argv[i]}' is not an option this lint takes`)
    return 1
  }
  const r = lint(root, !!process.env.LINT_QUIET)
  for (const l of r.lines) (l.stream === 'out' ? console.log : console.error)(l.text)
  return r.code
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
