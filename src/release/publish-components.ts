// Publish the release's board's components as OCI artifacts.
//
//   bun src/cli.ts publish-components     the board of the release tag <scope>.<YYYYMMDD-HHMM> HEAD carries
//
//   reads   _out/<board>/ and boards/<board>/ (src/boards/component.ts stages each component), the board's
//           latest published release (src/boards/reuse.ts)
//   writes  <registry>/mica-build:<component>.<board>.<YYYYMMDD-HHMM> for every built component of the board
//           (kernel, and uboot and firmware where it has them; the board component is source of the same
//           commit and is not published): one layer per file (application/vnd.mica.board.<kind>, titled with
//           its path; firmware/ as one firmware.tar), artifactType application/vnd.mica.board.<component>,
//           annotated with the source, mica.board, mica.arch, mica.component, mica.inputs and (kernel)
//           mica.verity-cert-sha256; the board rows of the release lock (LOCK_ROWS)
//
// A component whose inputs hash (src/boards/inputs.ts) equals the mica.inputs of the same component in the
// board's latest release is reused: that manifest is put under this release's tag unchanged, the same digest,
// and nothing is staged or built for it. A tag holding another digest is refused. Every manifest and layer is
// read back anonymously before its row is written. The port of tools/publish-components.sh (deleted
// 2026-09-23), message for message.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { board as findBoard } from '../boards/boards.ts'
import { list as componentList, stage } from '../boards/component.ts'
import { hash as inputsHash } from '../boards/inputs.ts'
import { reuse } from '../boards/reuse.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { artifactAnnotations, LOCK_ROWS, manifestDigest, Oci, registryLoad, registryToken, releaseLoad, repoName, type Layer } from '../pool/registry.ts'

export class PublishComponentsError extends Error {}

function die(message: string): never {
  throw new PublishComponentsError(`publish-components: error: ${message}`)
}

function kindOf(f: string): string {
  if (f === 'board.env') return 'env'
  if (f === 'evidence.json') return 'evidence'
  if (f.startsWith('manifests/')) return 'manifest'
  if (f.startsWith('kernel/')) return 'kernel'
  if (f.startsWith('uboot/') || f.startsWith('uboot-package/')) return 'uboot'
  if (f.startsWith('trust/')) return 'trust'
  return 'file'
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p, `${rel}${e}/`))
    else out.push(`${rel}${e}`)
  }
  return out
}

export async function publishComponents(): Promise<string> {
  const reg = registryLoad(), repo = repoName(), token = registryToken(reg, true)
  const oci = new Oci(reg, token), anonymous = new Oci(reg, '')
  const release = releaseLoad()
  const board = release.board, arch = findBoard(board).arch
  const artifact = oci.repo(repo)
  const verity = process.env.VERITY_TRUST_CERT || join(REPO_ROOT, 'meta/verity/signer.cert.pem')
  if (!existsSync(verity)) die(`${verity} does not exist; the verity certificate every component is annotated with`)
  const certSha = createHash('sha256').update(readFileSync(verity)).digest('hex')
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/.publish-components.'))
  try {
    mkdirSync(LOCK_ROWS, { recursive: true })
    writeFileSync(join(LOCK_ROWS, 'board.tsv'), '')
    let published = 0, reused = 0
    const rows: string[] = []
    for (const component of componentList(board)) {
      if (component === 'board') continue
      const tag = oci.tag(component, board, release.stamp)
      const inputs = inputsHash(board, component, undefined, { verity, fit: process.env.FIT_TRUST_CERT })
      const previous = await reuse(board, component, inputs, release.label)
      let line: string
      if (previous !== '') {
        const m = await anonymous.manifestGet(artifact, previous)
        if (m.status !== 200) die(`the reused ${component} manifest ${previous} does not read (HTTP ${m.status})`)
        line = await oci.tagManifest(artifact, tag, m.body)
        reused += 1
        console.log(`publish-components: ${component}: inputs ${inputs.slice(0, 12)} unchanged; ${reg.host}/${artifact}:${tag} is the published ${previous}`)
      }
      else {
        const staged = join(work, component)
        stage(board, component, staged, verity)
        // firmware/ as one reproducible tar: sorted, owned by root, epoch mtime.
        if (existsSync(join(staged, 'firmware'))) {
          const files = walk(join(staged, 'firmware'), 'firmware/').join('\n') + '\n'
          const t = Bun.spawnSync(['tar', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '--no-recursion', '-cf', 'firmware.tar', '-T', '-'], { cwd: staged, stdin: Buffer.from(files), stdout: 'pipe', stderr: 'pipe' })
          if (t.exitCode !== 0) die(`packing firmware.tar failed: ${t.stderr.toString().trim()}`)
          rmSync(join(staged, 'firmware'), { recursive: true, force: true })
        }
        const layers: Layer[] = walk(staged).map(f => ({ file: join(staged, f), mediaType: `application/vnd.mica.board.${kindOf(f)}`, title: f }))
        // The verity certificate annotates what embeds or carries it (its sha256 is in their inputs).
        const annotations = { ...artifactAnnotations(reg, repo, release.commit, release.created, release.label), 'mica.board': board, 'mica.arch': arch, 'mica.component': component, 'mica.inputs': inputs,
          ...(component === 'kernel' ? { 'mica.verity-cert-sha256': certSha } : {}) }
        line = await oci.publish(artifact, tag, `application/vnd.mica.board.${component}`, annotations, layers)
        published += 1
        console.log(`publish-components: ${component}: ${layers.length} layers ${line.slice(0, line.indexOf(' '))} as ${reg.host}/${artifact}:${tag} (${line.slice(line.indexOf(' ') + 1)})`)
      }
      const digest = line.slice(line.indexOf(' ') + 1)
      // Read back with no credential: the tag resolves to this manifest, every layer to its bytes.
      await oci.requirePublic(artifact, tag)
      const back = await anonymous.manifestGet(artifact, tag)
      if (back.status !== 200 || manifestDigest(back.body) !== digest) die(`${reg.host}/${artifact}:${tag} does not read back anonymously as ${digest} (HTTP ${back.status})`)
      const m = JSON.parse(new TextDecoder().decode(back.body)) as { annotations?: Record<string, string>, layers?: { digest: string }[] }
      if ((m.annotations?.['mica.inputs'] ?? '') !== inputs || `${m.annotations?.['mica.board']} ${m.annotations?.['mica.component']}` !== `${board} ${component}`) die(`${reg.host}/${artifact}:${tag} is not the ${board} ${component} with inputs ${inputs}`)
      for (const l of m.layers ?? []) {
        const b = await anonymous.blobGet(artifact, l.digest)
        if (b.status !== 200 || `sha256:${createHash('sha256').update(b.body).digest('hex')}` !== l.digest) die(`a layer of ${reg.host}/${artifact}:${tag} does not read back anonymously at ${l.digest} (HTTP ${b.status})`)
      }
      rows.push(`${board}\t${component}\t${arch}\t${tag}\t${digest}\n`)
      writeFileSync(join(LOCK_ROWS, 'board.tsv'), rows.join(''))
    }
    return `publish-components: ${board}: ${published} component(s) published, ${reused} reused`
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 0) die('usage: publish-components')
    console.log(await publishComponents())
    return 0
  }
  catch (e) {
    if (e instanceof PublishComponentsError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['RegistryError', 'BoardsError', 'ComponentError', 'InputsError', 'ReuseError', 'ProducersError', 'FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
