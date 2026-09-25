// The kernel symbols netavark needs, asserted against the BUILT config every board's bundle carries (make
// os-netavark-kernel-test fetches the bundles and the mica-podman pins first).
//
// WHY. podman bridge networking on cx3576 was unusable because the board kernel was built with
// `# CONFIG_NFT_FIB_IPV4 is not set`: netavark opens its port-forwarding path with `fib daddr type local jump
// <dnat_chain>` in its inet table, so on a kernel with no fib expression setup_network fails and every container
// on a bridge network fails with it. Nothing required the symbols, so the gap was invisible to every gate.
//
// WHAT IS PROVED. 1: every symbol is =y (not =m: a dm-verity root with no initramfs cannot load a module before
// the root is up) in every board's built config, one per profile on a FIT board. 3: the netavark the citations
// were read against is still the one mica-podman pins -- a citation into a version nobody ships is decoration. 4:
// the shared floor (common/kernel/mica-required.fragment, which every board merges) states each symbol it mentions
// as =y too, and mentions at least 15 of them, so the two floors cannot quietly disagree. (2, the post-olddefconfig
// loops, is checked where the kernel trees live: common/kernel/kernel-config-test.sh.)
//
// ONE LIST. The symbols and their citations are common/kernel/kernel-config-test.sh's REQUIRED list, read from it
// here. The shell gate carried a second copy of the same seventeen lines; the port reads the one the kernel builds'
// own floor check uses. The port of tests/gates/netavark-kernel-config-test.sh (deleted 2026-09-25).
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { boards } from '../../src/boards/boards.ts'
import { kernelDir } from '../../src/boards/board-pool.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const FRAGMENT = join(REPO_ROOT, 'common/kernel/mica-required.fragment')
const PODMAN_LOCK = join(REPO_ROOT, '_out/debs/mica-podman/upstream.lock')
// The netavark the citations were read against.
const CITED_NETAVARK = 'v2.1.0'

/** SYMBOL and the netavark line that needs it, out of the kernel floor check's heredoc. */
function required(): [string, string][] {
  const script = readFileSync(join(REPO_ROOT, 'common/kernel/kernel-config-test.sh'), 'utf8')
  const body = /^REQUIRED=\$\(cat <<'LIST'\n([\s\S]*?)\nLIST\n\)/m.exec(script)?.[1]
  if (body === undefined) throw new Error('common/kernel/kernel-config-test.sh carries no REQUIRED list; the floor moved and this gate with it')
  return body.split('\n').filter(l => l.trim() !== '').map((l) => { const [sym = '', ...why] = l.split(/\s+/); return [sym, why.join(' ')] })
}

const SYMBOLS = required()
const statedIn = (text: string, sym: string) => text.split('\n').find(l => l.startsWith(`CONFIG_${sym}=`) || l === `# CONFIG_${sym} is not set`)

test('the requirement list did not empty itself: it held 17 symbols when written', () => {
  expect(SYMBOLS.length).toBeGreaterThanOrEqual(17)
})

// Every board's built config, one per profile where the backend packs one per profile.
const configs = [...new Set(boards().flatMap(b => ['dev', 'prod'].map(p => `${b.name}\t${relative(REPO_ROOT, kernelDir(b.name, p))}/config`)))].map(r => r.split('\t') as [string, string])

test('there are boards to check, and every built config was fetched', () => {
  expect(configs.length).toBeGreaterThan(0)
  for (const [board, cfg] of configs) expect(existsSync(join(REPO_ROOT, cfg)), `${cfg} does not exist, so ${board}'s config would be checked by nothing (make os-netavark-kernel-test fetches the bundles)`).toBe(true)
})

test.each(configs)('1. %s: every netavark symbol is =y in %s', (_board, cfg) => {
  const text = readFileSync(join(REPO_ROOT, cfg), 'utf8')
  const missing = SYMBOLS.filter(([sym]) => !text.split('\n').includes(`CONFIG_${sym}=y`))
    .map(([sym, why]) => `CONFIG_${sym} is not =y in ${cfg} (found: ${statedIn(text, sym) ?? 'nothing'}). netavark needs it: ${why}`)
  expect(missing).toEqual([])
})

test('3. the citations point at the netavark mica-podman pins', () => {
  expect(existsSync(PODMAN_LOCK), `${PODMAN_LOCK} not found; there is nothing to check`).toBe(true)
  const pinned = readFileSync(PODMAN_LOCK, 'utf8').split('\n').map(l => l.split('\t')).find(r => r[0] === 'git' && r[1] === 'netavark')?.[3]
  expect(pinned, `mica-podman:upstream.lock pins netavark ${pinned ?? 'nothing'}, but the citations were read from ${CITED_NETAVARK}. Re-read src/firewall/nft.rs at the new tag and move the list and CITED_NETAVARK together.`).toBe(CITED_NETAVARK)
})

test('4. the shared floor states every symbol it mentions as =y, and mentions at least 15', () => {
  const fragment = readFileSync(FRAGMENT, 'utf8')
  const stated = SYMBOLS.map(([sym]) => [sym, statedIn(fragment, sym)] as const).filter(([, s]) => s !== undefined)
  expect(stated.filter(([sym, s]) => s !== `CONFIG_${sym}=y`).map(([sym, s]) => `the shared fragment states CONFIG_${sym} as '${s}', not =y`)).toEqual([])
  expect(stated.length).toBeGreaterThanOrEqual(15)
})
