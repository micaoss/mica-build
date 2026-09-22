// The seam: how an external tool is run, and the only place in build that
// decides.
//
// verify has one of these for bun (bin/bun.sh src/cli.ts's run_bun: two routes,
// one function, callers that cannot tell which answered). This is the same
// shape one level down, for the toolset the assemblers drive -- sgdisk, mtools,
// dd, mkimage, veritysetup and e2fsprogs.
//
// Nothing here swallows a failure. run() returns the exit status, stdout and
// stderr, and decides nothing; must() throws a ToolError carrying all of it
// plus the argv and the route. A tool whose failure signal is NOT its exit
// status -- debugfs exits 0 and writes to stderr -- is handled by its own
// wrapper in src/tools/, which is why this layer refuses to interpret.

import { $ } from 'bun'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolveImage } from './images.ts'

// THERE IS ONE ROUTE, AND IT IS THE CONTAINER. Every tool this file runs is a
// producer by mica:docs/design/build.md section 0 -- sgdisk, mtools, mke2fs,
// mkimage, veritysetup -- so its own build decides the bytes of the
// image, and the image is what ships. A host route would make "which tool
// wrote these bytes" a property of the machine that happened to run the build.
//
// It used to measure the host and prefer it when the whole toolset was there.
// Three things in the tree say why that was the wrong default, and one of them
// is this host:
//
//   - `command -v mkfs.vfat` here answers /build/bin/busybox/mkfs.vfat --
//     BusyBox v1.37.0, which does not know `--invariant`, the flag both
//     assemblers pass to make FAT reproducible. The presence check the host
//     route was guarded by says yes to it. (Measured 2026-09-04.)
//   - this host's e2fsprogs is 1.46.5, too old for `-O ^orphan_file`, which is
//     the measured reason pin_seeded_times has always run container-side.
//   - src/toolsets.ts: "which package provided mkfs.vfat or mksquashfs is
//     exactly the kind of thing that decides bytes".
//
// So `MICA_BUILD_TOOLBOX=host` and `route: 'host'` are REFUSALS now rather than
// instructions, and they name the policy. A route that is ignored teaches
// nothing; a route that refuses says where the rule is written.
//
// A toolbox is opened once -- image resolved, container started, packages
// installed, every tool asserted present -- and each call is a `docker exec`
// into it. Measured on this host, 2026-08-25: `docker run --rm <alpine> true`
// is ~320 ms and `docker exec <running> true` ~40 ms, with the apk that
// provides the toolset ~1.3 s on top of every run. An assembler makes tens of
// calls, so a container per call would spend more time starting containers than
// writing filesystems and would reinstall the toolset from the network each
// time. It also makes container-side steps ordinary: pin_seeded_times' dumpe2fs
// and debugfs are two more calls into the same session.

export type RouteKind = 'host' | 'container'

/** How a toolset's packages are installed, which differs by base image family. */
export type PackageManager = 'apk' | 'apt'

export interface Toolset {
  /** Short name, used in the announce line and in container names. */
  readonly key: string
  /** The image key naming the base image. Never a literal reference. */
  readonly imageKey: string
  readonly manager: PackageManager
  /** Exactly the packages the shell installs today. See each toolset's note in src/toolsets.ts. */
  readonly packages: readonly string[]
  /** Every binary this toolset must provide, asserted inside the container after open(). */
  readonly tools: readonly string[]
  /** Environment every call in this toolset gets, e.g. E2FSPROGS_FAKE_TIME. */
  readonly env?: Readonly<Record<string, string>>

}

export interface ToolResult {
  readonly argv: readonly string[]
  readonly route: RouteKind
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly ok: boolean
}

/** A tool that failed, with everything needed to see why -- and nothing dropped. */
export class ToolError extends Error {
  readonly argv: readonly string[]
  readonly route: RouteKind
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(result: ToolResult, note?: string) {
    const head = note ?? `${result.argv[0] ?? '(no argv)'} failed with exit ${result.exitCode}`
    super(
      `${head}\n`
      + `  route:  ${result.route}\n`
      + `  argv:   ${result.argv.map(quoteForMessage).join(' ')}\n`
      + `  stderr: ${indent(result.stderr) || '(empty)'}\n`
      + `  stdout: ${indent(result.stdout) || '(empty)'}`,
    )
    this.name = 'ToolError'
    this.argv = result.argv
    this.route = result.route
    this.exitCode = result.exitCode
    this.stdout = result.stdout
    this.stderr = result.stderr
  }
}

function indent(s: string): string {
  const t = s.trimEnd()
  return t === '' ? '' : t.split('\n').join('\n          ')
}

/** For the MESSAGE only. Nothing built here is ever handed to a shell. */
function quoteForMessage(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll('\'', `'\\''`)}'`
}

export interface OpenOptions {
  /**
   * Host directories the container must see, each mounted at its own path.
   *
   * Identity mounts, not /w or /work. bin/bun.sh src/cli.ts states the rule --
   * short names for containers that run a script and build their paths inside,
   * identity for containers handed paths from outside -- and every tool here is
   * the second kind: the caller passes absolute host paths and reads absolute
   * host paths back out. It matters twice over when bun is itself in a
   * container: a sibling container's -v is resolved by the daemon against the
   * host filesystem, so a translated path would name the wrong thing, and a
   * bind mount of a path the daemon cannot see succeeds and delivers an empty
   * directory.
   */
  readonly mounts?: readonly string[]
  /**
   * Read-only identity mounts, resolved to real paths along with their writable
   * peers. Protection takes precedence over duplicate/descendant declarations.
   */
  readonly readOnlyMounts?: readonly string[]
  /**
   * Kept so that `'host'` is a refusal that names the policy rather than a
   * value nothing reads. `'container'` is the only route there is.
   */
  readonly route?: RouteKind
  /** Where each call runs unless it says otherwise. */
  readonly cwd?: string
  /** Called once with the announce line, so a run is never ambiguous about which tools answered. */
  readonly announce?: (line: string) => void
}

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

// NO STDIN. Every tool in this toolset takes its input as a FILE and says so on
// its command line -- dd's if=, mkimage's -d, debugfs's -f and mcopy's source. Offering a stdin here would add a second way to hand
// a tool its input, and the one place it looks tempting (debugfs, which reads a
// command script) is exactly where the shell writes a file too: pin_seeded_times
// builds "${img}.times" and passes `-f`. A path is also the only form that
// survives the container boundary unchanged.

/** The docker client. run.sh passes the one it checked; a bare `docker` otherwise. */
function dockerBin(): string {
  return process.env.MICA_BUILD_DOCKER || 'docker'
}

export class Toolbox {
  readonly toolset: Toolset
  readonly route: RouteKind
  readonly image: string
  readonly announceLine: string
  private readonly container: string
  private readonly defaultCwd: string | undefined
  private closed = false

  private constructor(init: {
    toolset: Toolset
    route: RouteKind
    image: string
    container: string
    defaultCwd: string | undefined
    announceLine: string
  }) {
    this.toolset = init.toolset
    this.route = init.route
    this.image = init.image
    this.container = init.container
    this.defaultCwd = init.defaultCwd
    this.announceLine = init.announceLine
  }

  /**
   * Start the container, install the toolset, and prove every tool is there.
   *
   * @throws Error naming the toolset and the missing tool. A toolbox that
   *   opened without its tools would hand every later failure a "command not
   *   found" attributed to the step that happened to run first.
   */
  static async open(toolset: Toolset, options: OpenOptions = {}): Promise<Toolbox> {
    // Two ways to ask for the host, one refusal. Neither is ignored: a caller
    // who set MICA_BUILD_TOOLBOX=host meant something by it, and being quietly
    // overridden would leave them believing the host tools ran.
    if (options.route === 'host') refuseHostRoute(toolset, 'the caller asked for it')
    if (forcedRoute() === 'host') refuseHostRoute(toolset, 'MICA_BUILD_TOOLBOX=host asked for it')

    const route: RouteKind = 'container'
    const why = 'every tool here writes bytes that ship'

    const image = await resolveImage(toolset.imageKey)
    const docker = dockerBin()
    const container = `mica-build-${toolset.key}-${randomUUID().slice(0, 8)}`

    const mountArgs: string[] = []
    if (options.readOnlyMounts?.length) {
      const modes = new Map<string, boolean>()
      for (const path of options.mounts ?? []) modes.set(realpathSync(path), false)
      for (const path of options.readOnlyMounts) modes.set(realpathSync(path), true)
      const protectedParents: string[] = []
      // Emit parents first. A read-only parent already covers all descendants;
      // never remount a writable descendant over that protection.
      for (const [path, readOnly] of [...modes].sort(([a], [b]) => a.length - b.length)) {
        if (protectedParents.some(parent => path.startsWith(parent))) continue
        mountArgs.push('-v', `${path}:${path}${readOnly ? ':ro' : ''}`)
        if (readOnly) protectedParents.push(path.endsWith('/') ? path : `${path}/`)
      }
    }
    else {
      for (const m of options.mounts ?? []) mountArgs.push('-v', `${m}:${m}`)
    }

    // --rm with -d so a container this process never gets to close is removed
    // when its sleep ends; the sleep is BOUNDED for the same reason. `sleep
    // infinity` would outlive a SIGKILLed session forever, and this campaign's
    // sessions are killed by account limits often enough to have a rule about
    // committing in stages.
    const start = await $`${docker} run -d --rm --label ai-agent=true --network traefik --name ${container} ${mountArgs} --entrypoint sleep ${image} 3600`
      .nothrow().quiet()
    if (start.exitCode !== 0) {
      throw new Error(
        `could not start the ${toolset.key} toolbox container from ${image} (exit ${start.exitCode}):\n`
        + `${start.stderr.toString().trimEnd()}`,
      )
    }

    try {
      if (toolset.packages.length > 0) {
        const install = toolset.manager === 'apk'
          ? ['sh', '-c', `apk add --no-cache -q ${toolset.packages.join(' ')}`]
          : [
              'sh',
              '-c',
              `apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq `
              + `--no-install-recommends ${toolset.packages.join(' ')} >/dev/null`,
            ]

        // Retried, because the index is fetched over the network and apk lies
        // about losing it. Measured on this host, 2026-08-25: of 40 consecutive
        // `apk add --no-cache -q e2fsprogs e2fsprogs-extra` runs in the pinned
        // alpine, 3 failed, reading
        //
        //     ERROR: unable to select packages:
        //       e2fsprogs (no such package):
        //
        // about a package that is unquestionably in that image, because the
        // index fetch failed and apk describes an empty index as an empty
        // repository. A fourth shape appeared once: exit 6 naming a
        // half-resolved e2fsprogs-libs, the same fetch failing further along.
        // At ~7% per install and eight toolbox opens in a suite run that is a
        // red run every other time, for a reason unrelated to what is under
        // test. Three attempts: a package that genuinely does not exist fails
        // identically three times, so this hides no real failure.
        const attempts = 3
        let installed: ToolResult | undefined
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const r = await $`${docker} exec ${container} ${install}`.nothrow().quiet()
          if (r.exitCode === 0) { installed = undefined; break }
          installed = {
            argv: install, route: 'container', exitCode: r.exitCode,
            stdout: r.stdout.toString(), stderr: r.stderr.toString(), ok: false,
          }
          if (attempt < attempts) await Bun.sleep(1000 * attempt)
        }
        if (installed !== undefined) {
          throw new Error(
            `the ${toolset.key} toolset could not be installed in ${image}, in ${attempts} attempts `
            + `(last exit ${installed.exitCode}):\n`
            + `  packages: ${toolset.packages.join(' ')}\n`
            + `  stderr:   ${installed.stderr.trimEnd() || '(empty)'}\n`
            + `  stdout:   ${installed.stdout.trimEnd() || '(empty)'}\n`
            + `  note:     apk reports a failed index FETCH as "no such package", so that sentence is `
            + `not evidence the package is absent -- three attempts are.`,
          )
        }
      }

      // Every tool, asserted. An apk or apt that reports success and provides
      // one binary fewer than asked is not hypothetical -- alpine splits
      // debugfs and dumpe2fs into e2fsprogs-extra, so `apk add e2fsprogs` alone
      // installs an e2fsprogs with no debugfs in it and says nothing. Without
      // this the gap surfaces as "debugfs: not found" from pin_seeded_times,
      // forty steps into an assembly.
      const probe = [
        'sh', '-c',
        'for t in "$@"; do command -v -- "$t" >/dev/null 2>&1 || printf "missing:%s\\n" "$t"; done',
        'sh',
        ...toolset.tools,
      ]
      const seen = await $`${docker} exec ${container} ${probe}`.nothrow().quiet()
      const missing = seen.stdout.toString().split('\n')
        .filter(l => l.startsWith('missing:')).map(l => l.slice('missing:'.length))
      if (seen.exitCode !== 0 || missing.length > 0) {
        throw new Error(
          `the ${toolset.key} toolbox came up without every tool it declares.\n`
          + `  image:    ${image}\n`
          + `  packages: ${toolset.packages.join(' ') || '(none)'}\n`
          + `  missing:  ${missing.join(', ') || '(the probe itself failed)'}\n`
          + `  stderr:   ${seen.stderr.toString().trimEnd() || '(empty)'}`,
        )
      }
    }
    catch (e) {
      await $`${docker} rm -f ${container}`.nothrow().quiet()
      throw e
    }

    const line = `build: ${toolset.key} in ${image} (${why})`
    options.announce?.(line)
    return new Toolbox({
      toolset, route, image, container, defaultCwd: options.cwd, announceLine: line,
    })
  }

  /**
   * Run one argv. Returns what happened; decides nothing.
   *
   * The first element is the binary. Nothing is passed through a shell:
   * `docker exec` takes an argv, and Bun.$ interpolates an array as separate
   * arguments. A partition label containing a space, or a
   * board that ever declares one containing `;`, is an argument and not a
   * command -- which is the same property verify's parser exists to give
   * these files at rest.
   */
  async run(argv: readonly string[], options: RunOptions = {}): Promise<ToolResult> {
    this.refuseIfClosed(argv)
    if (argv.length === 0) {
      // An empty argv is not a tool call. Through docker exec it is a usage
      // error several sentences from the cause.
      throw new Error(`the ${this.toolset.key} toolbox was asked to run an empty argv, which is not a tool call`)
    }

    const env = { ...this.toolset.env, ...options.env }
    const cwd = options.cwd ?? this.defaultCwd

    const docker = dockerBin()
    const flags: string[] = []
    if (cwd !== undefined) flags.push('-w', cwd)
    for (const [k, v] of Object.entries(env)) flags.push('-e', `${k}=${v}`)
    const result = await $`${docker} exec ${flags} ${this.container} ${argv}`.nothrow().quiet()

    return {
      argv,
      route: this.route,
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      ok: result.exitCode === 0,
    }
  }

  /**
   * run(), and a nonzero exit is a ToolError rather than a value to ignore.
   *
   * Most tools here fail this way. The ones that do not -- debugfs exits 0 and
   * writes its failures to stderr; veritysetup format's answer is on stdout and
   * an unparseable one is a failure with exit 0 -- are handled in their own
   * wrapper, which calls run() and reads the result. That is the split: this
   * layer knows what "the process failed" means and nothing else.
   */
  async must(argv: readonly string[], options: RunOptions & { note?: string } = {}): Promise<ToolResult> {
    const r = await this.run(argv, options)
    if (!r.ok) throw new ToolError(r, options.note)
    return r
  }

  /** Tear the session down. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await $`${dockerBin()} rm -f ${this.container}`.nothrow().quiet()
  }

  /** The container's name, for a test that needs to look at it from outside. */
  get containerName(): string {
    return this.container
  }

  private refuseIfClosed(argv: readonly string[]): void {
    if (!this.closed) return
    // Left to docker this is "No such container", which names a random UUID
    // and not the mistake.
    throw new Error(
      `the ${this.toolset.key} toolbox was closed, and ${argv[0] ?? '(empty argv)'} was run through it `
      + `afterwards. A closed toolbox has no tools; reopen one.`,
    )
  }
}

function forcedRoute(): RouteKind | undefined {
  const v = process.env.MICA_BUILD_TOOLBOX
  if (v === undefined || v === '') return undefined
  if (v === 'host' || v === 'container') return v
  throw new Error(`MICA_BUILD_TOOLBOX=${v} is neither 'host' nor 'container'`)
}

/**
 * The one thing this file will not do, and why, at the point of asking.
 *
 * @throws Error always. It takes the toolset so the message can name what was
 *   about to be run on the host, which is more use than the rule alone.
 */
function refuseHostRoute(toolset: Toolset, who: string): never {
  throw new Error(
    `the ${toolset.key} toolset was asked to run on the host (${who}), and it will not.\n`
    + `  Every tool in it writes bytes that ship -- ${toolset.tools.slice(0, 4).join(', ')}`
    + `${toolset.tools.length > 4 ? ', ...' : ''} -- so its own build decides what the image\n`
    + `  contains. The rule is mica:docs/design/build.md section 0: no toolchain on the host, no\n`
    + `  compilation on the host, no assembly on the host.\n`
    + `  This is not a capability check that can be satisfied by installing the tools. The\n`
    + `  toolset runs in ${toolset.imageKey} through src/locks/from.ts, and that is the only route.`,
  )
}
