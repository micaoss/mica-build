// `bash verify/run.sh --smoke [--product NAME]` -- the entry point.
//
// Prints one line per artifact and one RESULT line, which is the
// shape `src/verify-cli.ts` already established for the image contract, so a
// reader of one run knows how to read the other.
//
// The argument parser refuses what it does not know, deliberately and for the
// reason run.sh's "has to be the FIRST argument" refusal gives about `--lint`:
// an unknown option that is accepted and ignored turns a request for one thing
// into a green about another. There is no `--opt=value` form for the same
// reason -- values come from the next argv element, so `--board=x64` is an
// error that names itself rather than a board called `=x64`.
//
// Cited by content and not by line number, which this file got wrong once: the
// citation said `run.sh:98`, and adding `--smoke` to run.sh moved that refusal
// to line 127. A reference that the referring change itself invalidates is the
// reference rot this tree keeps having to repair.

import { readProductEnv } from './product-env.ts'
import { smokeRun, type SmokeResult } from './smoke.ts'
import { ARTIFACTS } from './smoke-register.ts'

const USAGE = `usage: bun run src/smoke-cli.ts [--product NAME]

Executes every self-built artifact inside that board's factory root and requires
the version it reports to equal the version pinned in this repository.

  --product NAME   which product's _out/products/<product>/build/factory-root.oci to smoke.
                 Defaults to MICA_PRODUCT; there is no default product.
  --builder NAME the buildx builder to execute inside when this host's daemon
                 cannot execute the image's platform. Defaults to mica-<arch>
                 when such a builder exists; with neither, the run refuses.
  --help         this.

It refuses rather than skipping when the image is absent, when the register and
the version pins disagree, and when this host cannot execute the image at all.
`

function parse(argv: readonly string[]): { product?: string; builder?: string; help: boolean } {
  let product: string | undefined
  let builder: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--product' || arg === '--builder') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} needs a name after it; got ${value === undefined ? 'nothing' : `'${value}'`}.`)
      }
      if (arg === '--product') product = value
      else builder = value
      i += 1
      continue
    }
    throw new Error(
      `unknown option '${arg}'. Accepting and ignoring it would turn this into a green run about `
      + `something other than what was asked for.`,
    )
  }
  return { product, builder, help: false }
}

/** The tag column's width: the longest verdict spelling, so no row reflows the table. */
const TAG_WIDTH = 'EXECUTOR-LIMITED'.length

/** `PASS name  message`, at a width that keeps the messages aligned. */
export function formatResult(r: SmokeResult): string {
  // Spelled out rather than shortened. `LIMITED` alone would read as a property
  // of the artifact; the row has to say whose limit it was, and the message
  // beside it names the executor and the reason.
  const tag = r.verdict === 'pass'
    ? 'PASS'
    : r.verdict === 'fail'
      ? 'FAIL'
      : r.verdict === 'executor-limited' ? 'EXECUTOR-LIMITED' : 'UNCLAIMED'
  return `${tag.padEnd(TAG_WIDTH)} ${r.name.padEnd(16)} ${r.path.padEnd(34)} ${r.message}`
}

/**
 * Greedy word wrap, so a paragraph of reasoning is readable in a terminal.
 *
 * A word longer than `width` is emitted on its own line rather than split: the
 * long words here are file paths and flag names, and a path broken across two
 * lines is a path nobody can copy.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(w => w !== '')) {
    if (current === '') current = word
    else if (current.length + 1 + word.length <= width) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

async function main(): Promise<number> {
  let opts: { product?: string; builder?: string; help: boolean }
  try {
    opts = parse(process.argv.slice(2))
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    console.error(USAGE)
    return 2
  }
  if (opts.help) {
    console.log(USAGE)
    return 0
  }

  // MICA_PRODUCT is how every other build entry point is told which product it
  // is working on, and a default that ignored it would smoke one product while
  // the caller's whole session was about another.
  const product = opts.product ?? process.env['MICA_PRODUCT']
  if (product === undefined) throw new Error('--product (or MICA_PRODUCT) names the product whose factory root is smoked; there is no default')
  let board: string
  try {
    board = readProductEnv(product).board
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 2
  }

  let run
  try {
    run = await smokeRun({ product, board, builder: opts.builder })
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 1
  }

  for (const r of run.results) console.log(formatResult(r))

  // The long reasons, BELOW the table and not in it. An unclaimed artifact's
  // `detail` is the measurement that says why no version could be asked for,
  // and it is the thing a reader most needs and most easily skims past -- so it
  // gets its own block with the artifact named again, rather than a paragraph
  // wedged into a column that twelve other rows have to stay aligned with.
  const detailed = run.results.filter(r => r.detail !== undefined)
  if (detailed.length > 0) {
    console.log('')
    console.log(`WHY ${detailed.length} ARTIFACT(S) COULD NOT BE ASKED:`)
    for (const r of detailed) {
      console.log('')
      console.log(`  ${r.name} (${r.path})`)
      for (const line of wrap(r.detail!, 92)) console.log(`    ${line}`)
    }
    console.log('')
  }

  console.log(
    `verify smoke: ${run.results.length} artifacts from the register (${ARTIFACTS.length} shipped), `
    + `board ${board}`,
  )
  console.log(run.conclusion.line)
  return run.conclusion.exitCode
}

process.exit(await main())
