import { builderImagesAt } from '../../build/src/images.ts'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalJson } from '../../build/src/components.ts'
import { assembleRelease, fileSha256, gateRelease, type ReleaseInputs } from '../../build/src/release-manifest.ts'
import { sourceIdentity } from '../../build/src/release-cli.ts'
import { REPO_ROOT } from '../../build/src/paths.ts'
import { loadBoardFacts } from '../../build/src/board-facts.ts'

// This consumer records artifact checks only. Guest, hardware and publication
// qualification remain separate; the normal release CLI retains its policy.
export async function acceptProvenance(inputs: ReleaseInputs, checkout = REPO_ROOT) {
  if (loadBoardFacts(inputs.board).releaseTarget || inputs.channel !== 'development' || inputs.profile !== 'dev') {
    throw new Error('Non-publication acceptance requires a board that is not a release target, on development/dev')
  }
  const out = resolve(inputs.out)
  const recordPath = `${out}.acceptance.json`
  if (lstatSync(out, { throwIfNoEntry: false }) || lstatSync(recordPath, { throwIfNoEntry: false })) {
    throw new Error('Acceptance output or evidence already exists')
  }
  const source = await sourceIdentity(checkout)
  if (source.dirty || canonicalJson(source) !== canonicalJson(inputs.source)) {
    throw new Error('Acceptance inputs must match the actual clean frozen source')
  }
  const boardEnv = readFileSync(join(checkout, `_out/boards/${inputs.board}/board.env`), 'utf8')
  if (!/^BOARD_RELEASE_TARGET=0$/m.test(boardEnv)) throw new Error('Expected the committed non-publication board policy')
  if (!readFileSync(inputs.evidence).equals(readFileSync(join(checkout, `_out/boards/${inputs.board}/evidence.json`)))) {
    throw new Error('Acceptance must preserve the committed board evidence bytes')
  }
  const builderImages = builderImagesAt(checkout)
  if (canonicalJson(builderImages) !== canonicalJson(inputs.builderImages)) throw new Error('Acceptance builder image inputs differ from frozen source')
  assembleRelease({ ...inputs, out, source, builderImages })
  const report = gateRelease(out, inputs.keys)
  if (canonicalJson(await sourceIdentity(checkout)) !== canonicalJson(source)) throw new Error('Frozen source changed during acceptance')
  const record = {
    schema: 'mica/non-publication-artifact-acceptance/v1', result: 'NON_PUBLICATION_ARTIFACT_ACCEPTANCE',
    publicationEligible: false, board: inputs.board, channel: inputs.channel, profile: inputs.profile,
    source, artifactDirectory: out, manifestSha256: fileSha256(join(out, 'manifest.json')),
    artifacts: report.manifest.artifacts,
    metadataPublicKeySha256: inputs.keys.map(key => createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')),
    checkedAt: new Date().toISOString(),
  }
  // Keep this record outside the gate's strictly enumerated artifact directory.
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  console.log(`${record.result} board=${record.board} publicationEligible=false source=${record.source.commit}`)
  return record
}

if (import.meta.main) {
  try {
    const [input, ...extra] = Bun.argv.slice(2)
    if (!input || extra.length) throw new Error('Usage: tests/lifecycle-uefi/bun.sh tests/lifecycle-uefi/provenance-acceptance.ts INPUTS_JSON')
    await acceptProvenance(JSON.parse(readFileSync(resolve(input), 'utf8')))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
