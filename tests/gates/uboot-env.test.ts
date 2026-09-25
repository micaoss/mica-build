// mica-build-side: container -- gcc compiles and runs the test in the mica-build-env c image, never on the host
// The FIT loaders' redundant-environment entry (common/uboot/mica-records.h): common/uboot/tests/env-test.c
// compiled with sanitizers and run in the mica-build-env c image (make uboot-env-test; docker). The port of
// tests/gates/uboot-env-test.sh (deleted 2026-09-25).
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { resolve as fromRef } from '../../src/locks/from.ts'
import { inputs } from '../../src/locks/locks.ts'
import { dockerBin } from '../../src/shared/docker.ts'
import { hostPath } from '../../src/shared/host-path.ts'

const UBOOT = resolve(import.meta.dir, '../../common/uboot')

test('the record parser compiles clean under -Werror and passes its cases under ASan and UBSan', () => {
  const image = fromRef('mica-build-env:c', inputs())
  const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${hostPath(UBOOT)}:/src:ro`, image,
    'sh', '-ec', 'gcc -std=gnu11 -Wall -Wextra -Werror -fsanitize=address,undefined -o /tmp/env-test /src/tests/env-test.c && /tmp/env-test'],
  { stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode, r.stdout.toString() + r.stderr.toString()).toBe(0)
}, 600000)
