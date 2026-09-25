// Every example in tests/fixtures/quadlet-doc/containers.md (the executed copy of mica:docs/design/containers.md),
// fed to the Quadlet generator the image ships (make os-quadlet-doc-test).
//
// A document full of configuration examples rots silently: Quadlet gains a key, drops one, renames a section, and
// the examples go on looking correct to every reader, because nothing in a markdown file can fail. So the examples
// are extracted from the document and run through the real generator -- the arm64 binary in mica-podman:out-arm64,
// under emulation, the one the device runs.
//
// The marker is an HTML comment, `<!-- quadlet: NAME -->`, immediately before the fenced block. Invisible when the
// document is rendered, unambiguous to parse, and it names the file the block is, because Quadlet's behaviour
// depends on the extension: a `.network` and a `.container` holding identical bytes generate different units.
// The port of tests/gates/quadlet-doc-test.sh (deleted 2026-09-25) and its two inline Python extractors, check for
// check.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildArgs } from '../../src/locks/from.ts'
import { inputs } from '../../src/locks/locks.ts'
import { dockerBin } from '../../src/shared/docker.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
// The executed specimen of mica:docs/design/containers.md, kept beside the test because the documentation lives in
// micaoss/mica; a drift between the two is a diff to review, not a silent divergence.
const DOC = join(REPO_ROOT, 'tests/fixtures/quadlet-doc/containers.md')
const QUADLET = process.env.MICA_QUADLET_BIN || join(REPO_ROOT, '_out/debs/arm64/mica-podman/quadlet')
mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, '_out/.quadlet-doc.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

const EXAMPLE = /<!--\s*quadlet:\s*(?<name>[A-Za-z0-9._-]+)\s*-->\s*\n```[a-z]*\n(?<body>.*?)```/gs
const examples = [...readFileSync(DOC, 'utf8').matchAll(EXAMPLE)].map(m => [m.groups!.name!, m.groups!.body!] as const)
const markers = [...readFileSync(DOC, 'utf8').matchAll(/<!--\s*quadlet:\s*([A-Za-z0-9._-]+)\s*-->/g)].map(m => m[1]!)

test('every marker opens a fenced block, and there are at least nine', () => {
  // An extractor that finds nothing makes every assertion below pass over an empty set.
  expect(examples.map(([n]) => n)).toEqual(markers)
  // The floor moves with the document. It was five when the guide covered interconnection, dependency and
  // persistence; PLAN-051 added a health-checked unit, a hardened one carrying a dedicated user, a named device node
  // and the four resource controllers, and a digest-pinned private image -- three files whose loss the old floor
  // would not have noticed, because six examples is still more than five.
  expect(examples.length, `only ${examples.length} examples were extracted. mica:docs/design/containers.md is the integrator's guide to interconnection, dependency, persistence, health, identity, hardware and resource ceilings, and it cannot demonstrate those in fewer than nine files`).toBeGreaterThanOrEqual(9)
})

// The generator's output over the document's files; empty until beforeAll ran it.
let generated = ''

beforeAll(() => {
  if (!existsSync(QUADLET)) throw new Error(`${QUADLET} not found. This test runs the generator the image ships, not a description of it; 'make os-pool' extracts it from the pinned mica-podman archive`)
  const units = join(WORK, 'units')
  mkdirSync(units, { recursive: true })
  for (const [name, body] of examples) writeFileSync(join(units, name), body)
  copyFileSync(QUADLET, join(WORK, 'quadlet'))
  // The base from locks/mica-build-env.lock: the binary is dynamically linked, so the base decides the glibc it
  // loads against, and a base that drifted would surface as this test failing about unit content.
  writeFileSync(join(WORK, 'Dockerfile'), `ARG MICA_IMAGE_DEBIAN_TRIXIE
FROM \${MICA_IMAGE_DEBIAN_TRIXIE} AS run
COPY quadlet /usr/libexec/podman/quadlet
COPY units/ /etc/containers/systemd/
RUN set -eu; \\
    out="$(/usr/libexec/podman/quadlet --dryrun 2>&1)"; \\
    printf '%s\\n' "\${out}" >/generated.txt; \\
    printf '%s\\n' "\${out}"
FROM scratch AS artifact
COPY --from=run /generated.txt /
`)
  // In a container, because the binary is aarch64 and this host is not. Same builder selection as
  // mica-podman:build.sh: buildx's docker-container driver bundles QEMU, so no host binfmt registration is needed.
  // The context and -o are the client's paths, not the daemon's.
  const docker = dockerBin(), builder: string[] = []
  const quiet = { stdout: 'pipe', stderr: 'pipe' } as const
  if (!process.env.BUILDX_BUILDER && !Bun.spawnSync([docker, 'buildx', 'inspect'], quiet).stdout.toString().includes('linux/arm64')) {
    if (Bun.spawnSync([docker, 'buildx', 'inspect', 'mica-arm64'], quiet).exitCode !== 0)
      expect(Bun.spawnSync([docker, 'buildx', 'create', '--name', 'mica-arm64', '--driver', 'docker-container'], quiet).exitCode).toBe(0)
    builder.push('--builder', 'mica-arm64')
  }
  const r = Bun.spawnSync([docker, 'buildx', 'build', ...builder, ...buildArgs(['MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim'], inputs()),
    '--platform', 'linux/arm64', '-f', join(WORK, 'Dockerfile'), '-o', join(WORK, 'out'), WORK], quiet)
  if (r.exitCode !== 0) throw new Error(`the Quadlet generator failed on the document's examples:\n${r.stderr.toString().split('\n').slice(-40).join('\n')}`)
  generated = readFileSync(join(WORK, 'out/generated.txt'), 'utf8')
}, 900_000)

// Asserted FIRST, because every other assertion is about the content of the output, and an empty output would make
// a search for an absent string look like a passing negative.
test('the generator parsed the document\'s files rather than reporting none', () => {
  expect(generated).not.toBe('')
  expect(generated).not.toContain('No files parsed from')
})

const UNIT_OF: Record<string, (stem: string) => string> = { container: s => `${s}.service`, volume: s => `${s}-volume.service`, network: s => `${s}-network.service` }

test.each(markers)('%s generates its unit', (name) => {
  const dot = name.lastIndexOf('.'), unit = UNIT_OF[name.slice(dot + 1)]
  expect(unit, `${name} has an extension this test does not map to a unit name`).toBeDefined()
  expect(generated).toContain(unit!(name.slice(0, dot)))
})

// The claims the document makes IN PROSE, checked against what the generator actually produced. These are the
// sentences an integrator acts on. A string is a literal, a RegExp a per-line pattern; `absent` inverts.
const CLAIMS: [string, string | RegExp, 'absent'?][] = [
  ['web.container\'s ExecStart invokes the podman this image installs', /ExecStart=\/usr\/bin\/podman/],
  ['api.service is ordered after db.service, as section 5 says', /After=.*db\.service/],
  // `db` alone was the first version of this and matched `db.service` -- it would have passed with NetworkAlias
  // silently dropped, which is precisely the failure section 5 tells the integrator cannot happen.
  ['section 5\'s promise that api reaches db BY NAME reaches podman as --network-alias', '--network-alias db'],
  ['db.container\'s volume dependency is wired without the document saying so', 'Requires=pgdata-volume.service'],
  ['joining a .network wires the network unit dependency too', 'Requires=app-network.service'],
  // Section 7: health. `Notify=healthy` is two generated facts, not one -- the unit has to become Type=notify AND
  // podman has to be told which notification to wait for. Either alone is a unit that starts when the container
  // process exists, which is the failure section 5 describes.
  ['section 7\'s Notify=healthy makes the unit wait: Type=notify', /^Type=notify/m],
  ['section 7\'s Notify=healthy makes the unit wait: --sdnotify=healthy', '--sdnotify=healthy'],
  ['the health check itself reaches podman, with its timeout', /--health-cmd .*--health-timeout 5s/],
  // Without this one, an unhealthy container is marked and left running; the document says HealthOnFailure closes it.
  ['section 7\'s HealthOnFailure turns unhealthy into an exit Restart= can see', '--health-on-failure kill'],
  ['LogDriver=journald in the unit reaches podman rather than relying on containers.conf', '--log-driver journald'],
  // Section 8: identity, hardware, ceilings. The uid assertion is exact because Quadlet CONCATENATES User= and
  // Group=, so the defect this catches is a third field appended silently.
  ['section 8\'s dedicated user reaches podman as exactly uid:gid', /--user 10001:10001( |$)/m],
  ['section 8\'s capability drop reaches podman', '--cap-drop all'],
  ['the named device node reaches podman as --device', '--device /dev/ttyS3:/dev/ttyS3:rw'],
  ['ConditionPathExists survives into the unit, so an absent node skips rather than fails', /^ConditionPathExists=\/dev\/ttyS3/m],
  // The ceilings are only ceilings if the container is inside the unit's cgroup; without --cgroups=split the keys
  // below are systemd limiting the podman client and nothing else.
  ['the container shares the unit\'s cgroup, which is what makes the ceilings bind it', '--cgroups=split'],
  ...['CPUQuota=40%', 'MemoryHigh=192M', 'MemoryMax=256M', 'TasksMax=128', 'IOReadBandwidthMax=/dev/mmcblk0 8M', 'IOWriteBandwidthMax=/dev/mmcblk0 4M']
    .map(key => [`section 8's ${key} reaches the generated unit`, key] as [string, string]),
  // Section 9: the digest-pinned private image. --pull never is the claim that "the unit runs the image already on
  // the device, or it does not start"; the digest says which image that is.
  ['section 9\'s Pull=never reaches podman as --pull never', '--pull never'],
  ['section 9\'s image is pinned by digest, not by a tag someone can move', /registry\.example\.com\/acme\/app@sha256:[0-9a-f]{64}/],
  // REGISTRY_AUTH_FILE is read by the podman PROCESS; [Container]'s Environment= would put it inside the container
  // instead, where nothing reads it -- so it must land in [Service] as a unit Environment= line, not as --env.
  ['section 9\'s credential path is the podman process\'s environment, not the container\'s', /^Environment=REGISTRY_AUTH_FILE=\/var\/lib\/mica\/containers-auth\.json/m],
  ['and it is NOT handed to the container as --env', /--env REGISTRY_AUTH_FILE/, 'absent'],
]

// Every row padded to three: bun hands a shorter row's missing parameter a done callback.
test.each(CLAIMS.map(([claim, pattern, absent]) => [claim, pattern, absent ?? 'present'] as const))('%s', (_claim, pattern, expected) => {
  const found = typeof pattern === 'string' ? generated.includes(pattern) : pattern.test(generated)
  expect(found, `generator output:\n${generated}`).toBe(expected === 'present')
})
