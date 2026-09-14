// `bash verify/run.sh --smoke-negative [--product NAME]` -- the entry point for
// the three negative tests.
//
// Same argv discipline as `src/smoke-cli.ts`, and for the same
// reason it gives: an unknown option that is accepted and ignored turns a
// request for one thing into a green about another. There is no `--opt=value`
// form here either.
//
// SEPARATE FROM `--smoke` RATHER THAN A FLAG ON IT. The smoke run is what the
// build path executes on every rootfs build; this BREAKS the root three times
// over and is a check on the checker. Folding them together would put three
// image builds and three deliberate defects into every build of every image,
// and would make "the smoke run passed" mean two different things depending on
// a flag.

import { readProductEnv } from './product-env.ts'
import { CASES, negativeRun } from './smoke-negative.ts'

const USAGE = `usage: bun run src/smoke-negative-cli.ts [--product NAME]

the three negative tests. Each one really makes its defect -- a
wrong-arch binary, a missing soname, a version-skewed binary -- in a real image
built from that board's real factory root, and requires the smoke run to go red
naming the right cause.

  --product NAME   which product's _out/products/<product>/build/factory-root.oci to break.
                 Defaults to MICA_PRODUCT; there is no default product.
  --help         this.

Needs docker. It refuses rather than skipping when the image is absent and when
this host cannot execute it, exactly as the smoke runner does.
`

function parse(argv: readonly string[]): { product?: string; help: boolean } {
  let product: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--product') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`--product needs a product name after it; got ${value === undefined ? 'nothing' : `'${value}'`}.`)
      }
      product = value
      i += 1
      continue
    }
    throw new Error(
      `unknown option '${arg}'. Accepting and ignoring it would turn this into a green run about `
      + `something other than what was asked for.`,
    )
  }
  return { product, help: false }
}

async function main(): Promise<number> {
  let opts: { product?: string; help: boolean }
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

  const product = opts.product ?? process.env['MICA_PRODUCT']
  if (product === undefined) throw new Error('--product (or MICA_PRODUCT) names the product whose factory root is broken; there is no default')
  let board: string
  try {
    board = readProductEnv(product).board
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 2
  }

  let run
  try {
    run = await negativeRun({ product, board })
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 1
  }

  console.log('')
  console.log(
    `verify negative: ${run.outcomes.length} cases (${CASES.length} declared), product ${product} on ${board}`,
  )
  console.log(run.line)
  return run.exitCode
}

process.exit(await main())
