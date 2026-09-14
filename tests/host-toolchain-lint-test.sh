#!/usr/bin/env bash
# Can tests/host-toolchain-lint.sh fail?
#
# A lint that has only ever been run against a clean tree has been observed to
# exit 0 and nothing else. Every case below plants ONE defect in a fixture
# checkout and requires the lint to go red naming it -- and two cases plant
# something that is NOT a defect and require green, because a rule whose
# findings are false positives teaches people to ignore it, which is the failure
# mode tests/shell-pipefail-lint.sh's header spends a paragraph on.
#
# The fixtures are throwaway git repositories, because the lint takes its file
# list from `git ls-files` and a fixture that is not one would exercise a
# different code path from the real run. `mktemp -d` is safe here where it is
# not for a container test: nothing below mounts anything into docker, so
# mica:docs/design/build-harness.md section 4's empty-mount trap cannot apply.
#
#   bash tests/host-toolchain-lint-test.sh     (or: make os-host-toolchain-lint-test)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINT="${REPO}/tests/host-toolchain-lint.sh"
[ -x "${LINT}" ] || { echo "error: ${LINT} is not there; this test has nothing to drive" >&2; exit 1; }

PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# A fixture checkout: an empty git repository, one per case. `mktemp -d -p`
# and not a counter -- this runs in a command substitution, so a counter
# incremented here would be incremented in a subshell and every case would land
# in the same directory, carrying the previous case's defect into the next.
new_fixture() { # -> prints the directory
    local d
    d="$(mktemp -d -p "${WORK}")"
    git -C "${d}" init -q
    # Every fixture carries one ordinary command line, so that the "not one
    # command line was examined" control -- which is about a scan that elided
    # the whole tree -- does not fire on a fixture that is simply small, and
    # mask the case actually under test.
    printf '%s\n' '#!/bin/sh' 'set -eu' 'true' >"${d}/plain.sh"
    printf '%s\n' "${d}"
}

track() { git -C "$1" add -A; }

# Run the lint against a fixture and require a colour. `want` is `green` or
# `red`; `needle` is a fragment the output must contain, so that a case cannot
# be satisfied by the lint failing for some unrelated reason -- which is how a
# negative test comes to assert nothing.
expect() { # what dir green|red needle
    local what="$1" dir="$2" want="$3" needle="$4" out rc=0
    out="$(LINT_QUIET=1 bash "${LINT}" --root "${dir}" 2>&1)" || rc=$?
    if [ "${want}" = green ] && [ "${rc}" -ne 0 ]; then
        fail "${what}: expected green, got exit ${rc}"
        printf '        %s\n' "${out}" >&2
        return
    fi
    if [ "${want}" = red ] && [ "${rc}" -eq 0 ]; then
        fail "${what}: expected red, the lint exited 0"
        printf '        %s\n' "${out}" >&2
        return
    fi
    case "${out}" in
    *"${needle}"*) pass "${what}" ;;
    *)
        fail "${what}: ${want} as expected, but the output does not mention '${needle}', so this case is not testing what it says"
        printf '        %s\n' "${out}" >&2
        ;;
    esac
}

# Every green fixture needs one container declaration, because the lint refuses
# a run that found none -- see case 12, which is that control driven directly.
DECL='# mica-build-side: container -- fixture: pretend this runs in an image'

# ---------------------------------------------------------------------------
# 1. The real tree. The control for everything below: if this is not green, the
#    red cases prove nothing, because they would be red anyway.
# ---------------------------------------------------------------------------
out="$(LINT_QUIET=1 bash "${LINT}" 2>&1)" && rc=0 || rc=$?
if [ "${rc}" -eq 0 ]; then pass "the lint is green on this tree"; else
    fail "the lint is RED on this tree, so every case below is meaningless"
    printf '        %s\n' "${out}" >&2
fi

# ---------------------------------------------------------------------------
# 2. A host filesystem maker.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '#!/bin/sh\nmkfs.ext4 -F disk.img\n' >"${d}/assemble.sh"
track "${d}"
expect "a host mkfs.ext4 is found" "${d}" red 'assemble.sh:2: `mkfs.ext4` runs on the host'

# ---------------------------------------------------------------------------
# 3. A host compiler. Separate from case 2 because the two arms of the policy
#    -- no assembly, no compilation -- are separate claims, and a table that
#    lost its toolchain half would still pass case 2.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '#!/bin/sh\ncargo build --release\n' >"${d}/compile.sh"
track "${d}"
expect "a host cargo build is found" "${d}" red 'compile.sh:2: `cargo` runs on the host'

# ---------------------------------------------------------------------------
# 4. THE FALSE-POSITIVE CONTROL. A producer inside a declared container block
#    is not a finding. Without this, the cheapest way to make cases 2 and 3
#    pass is a rule that flags every occurrence everywhere.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
cat >"${d}/blocked.sh" <<'EOF'
#!/bin/sh
echo host side
# mica-build-side: container-block -- fixture: the lines below are a container's
docker run --rm alpine sh -c '
    mkfs.ext4 -F /w/disk.img
    sgdisk --clear /w/disk.img
'
# mica-build-side: host
echo host side again
EOF
track "${d}"
expect "a producer inside a declared container block is not a finding" "${d}" green 'RESULT: PASS'

# ---------------------------------------------------------------------------
# 5 and 6. THE MUTATION. The whole-file declaration is what makes case 5 green;
#    removing it must turn the same bytes red. A declaration nobody reads would
#    pass case 5 just as well.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' '#!/bin/sh' "${DECL}" 'mksquashfs /rootfs /out/rootfs.squashfs' >"${d}/pack.sh"
track "${d}"
expect "a whole-file declaration covers the file" "${d}" green 'RESULT: PASS'

d="$(new_fixture)"
printf '%s\n' '#!/bin/sh' 'mksquashfs /rootfs /out/rootfs.squashfs' >"${d}/pack.sh"
printf '%s\n' "${DECL}" 'mkimage -T script' >"${d}/other.sh"
track "${d}"
expect "removing that declaration turns the same file red" "${d}" red 'pack.sh:2: `mksquashfs` runs on the host'

# ---------------------------------------------------------------------------
# 7. An unclosed container block. This is the dangerous shape: everything after
#    it is skipped, so the failure mode is a file that stops being scanned and
#    still reports clean.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
cat >"${d}/unclosed.sh" <<'EOF'
#!/bin/sh
# mica-build-side: container-block -- fixture: opened and never closed
docker run --rm alpine true
mkfs.ext4 -F disk.img
EOF
track "${d}"
expect "an unclosed container block is a failure, not a silent skip" "${d}" red 'is never closed'

# ---------------------------------------------------------------------------
# 8. A close with no open.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' '#!/bin/sh' '# mica-build-side: host' 'true' >"${d}/stray.sh"
track "${d}"
expect "a host marker closing nothing is a failure" "${d}" red 'never opened'

# ---------------------------------------------------------------------------
# 9. A marker with no reason. `# mica-build-side: container` on its own is a
#    rubber stamp, and silently treating it as "not a marker" would leave the
#    author believing the file was declared.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' '#!/bin/sh' '# mica-build-side: container' 'mkfs.ext4 -F disk.img' >"${d}/stamped.sh"
track "${d}"
expect "a marker with no reason is refused by name" "${d}" red 'malformed `mica-build-side:` marker'

# ---------------------------------------------------------------------------
# 10. A whole-file declaration after code. It would otherwise read as covering
#     lines that ran before it.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' '#!/bin/sh' 'echo work' 'true' "${DECL}" 'mkfs.ext4 -F disk.img' >"${d}/late.sh"
track "${d}"
expect "a whole-file declaration after code is refused" "${d}" red 'must come before any code'

# ---------------------------------------------------------------------------
# 11. A LIVE exemption silences its finding, and a STALE one is a failure.
#     Both directions, because a register that silenced everything and a
#     register that was never read produce the same green on the first.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
mkdir -p "${d}/tests"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '#!/bin/sh\nopenssl genpkey -out k\n' >"${d}/keys.sh"
printf 'keys.sh\topenssl\tfixture: registered, with a reason\n' >"${d}/tests/host-toolchain-exemptions"
track "${d}"
expect "a registered exemption silences its finding" "${d}" green 'RESULT: PASS'

d="$(new_fixture)"
mkdir -p "${d}/tests"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf 'gone.sh\topenssl\tfixture: points at a file that is not here\n' >"${d}/tests/host-toolchain-exemptions"
track "${d}"
expect "an exemption that matches nothing is a failure" "${d}" red 'matches nothing'

d="$(new_fixture)"
mkdir -p "${d}/tests"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf 'keys.sh\topenssl\n' >"${d}/tests/host-toolchain-exemptions"
printf '#!/bin/sh\nopenssl genpkey -out k\n' >"${d}/keys.sh"
track "${d}"
expect "an exemption with no reason is refused" "${d}" red 'no tool or no reason'

# ---------------------------------------------------------------------------
# 12. THE SECOND SHAPE: a script that REACHES for a host toolchain. The table of
#     binaries nearly missed the largest violation in the tree, because this
#     host has no cargo at all -- micad:hack/check.sh finds one only by
#     putting $HOME/.cargo/bin in front of PATH. And the negative half, which is
#     what keeps the rule narrow: a fixture PATH built out of a directory the
#     test just made is not a finding, and two suites here do exactly that.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' '#!/bin/sh' 'export PATH="$HOME/.cargo/bin:$PATH"' 'true' >"${d}/reaches.sh"
track "${d}"
expect "a PATH prepended with a directory under \$HOME is found" "${d}" red 'reaches.sh:2: this prepends a directory under $HOME to PATH'

d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' '#!/bin/sh' 'FAKEBIN=$(mktemp -d)' 'env PATH="${FAKEBIN}:$PATH" some-fixture' >"${d}/fixture.sh"
track "${d}"
expect "a fixture PATH built from a temp dir is NOT a finding" "${d}" green 'RESULT: PASS'

# ---------------------------------------------------------------------------
# 13. A COMMENT THAT MENTIONS A HEREDOC MUST NOT OPEN ONE. This was a real
#     defect: heredoc detection ran before the comment skip, so a line of prose
#     containing `<<EOF` elided every line after it until something matched the
#     terminator -- a file that silently stopped being scanned and still
#     reported clean. Measured on this repository when it was fixed: 152 command
#     lines that had never been examined came back.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
cat >"${d}/prose.sh" <<'EOF'
#!/bin/sh
# The producer below is a real one. This comment mentions a heredoc, <<EOF,
# because scripts explain themselves and prose talks about shell syntax.
mkfs.ext4 -F disk.img
EOF
track "${d}"
expect "a heredoc named in a COMMENT does not swallow the lines after it" "${d}" red 'prose.sh:4: `mkfs.ext4` runs on the host'

# ---------------------------------------------------------------------------
# 14. THE POSITIVE CONTROL, driven directly. A tree in which the scan found no
#     producer running in a container has not found this repository's build; it
#     has found a pattern that stopped matching. It must not report clean.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '#!/bin/sh\necho nothing interesting here\n' >"${d}/quiet.sh"
track "${d}"
expect "a scan that saw no container-side producer refuses to report clean" "${d}" red 'no container-side declaration was found'

# ---------------------------------------------------------------------------
# 15. And a tree with no scannable files at all.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
rm "${d}/plain.sh"   # this is the one case that wants an EMPTY surface
printf 'not a script\n' >"${d}/README.md"
track "${d}"
expect "an empty surface is a failure, not a pass" "${d}" red 'would pass by finding nothing'

# ---------------------------------------------------------------------------
# 16 and 17. THE SECOND SURFACE: a producer launched from TypeScript, in both
#     shapes the harness could use. Two cases and not one, because bun's shell
#     tag and an argv-taking spawn are resolved by different code and a scanner
#     that lost one of them would still pass the other.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
cat >"${d}/pack.ts" <<'EOF'
import { $ } from 'bun'
export async function pack(root: string, out: string) {
  await $`mksquashfs ${root} ${out} -comp zstd`
}
EOF
track "${d}"
expect "a producer launched from a bun shell template is found" "${d}" red 'pack.ts:3: this launches `mksquashfs` on the host'

d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
cat >"${d}/part.ts" <<'EOF'
export function part(img: string) {
  return Bun.spawnSync(['/usr/sbin/sgdisk', '--clear', img], { stdout: 'pipe' })
}
EOF
track "${d}"
expect "a producer launched through Bun.spawnSync is found, path and all" "${d}" red 'part.ts:2: this launches `sgdisk` on the host'

# ---------------------------------------------------------------------------
# 18. THE FALSE-POSITIVE CONTROL FOR THAT SURFACE, and it carries the weight
#     here: `$` is used 21 times in this tree and every one is legitimate. Two
#     shapes that must stay green -- a producer handed to `docker` as an
#     ARGUMENT, which is what the whole toolbox is, and a regex anchor sitting
#     immediately before a template's closing backtick, which a grep for `$`
#     followed by a backtick reads as a shell call and which this tree has 22
#     of. Without this case the cheapest way to pass 16 and 17 is a rule that
#     flags the character.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
cat >"${d}/toolbox.ts" <<'EOF'
import { $ } from 'bun'
export const re = (name: string) => new RegExp(`^${name}=(.*)$`, 'gm')
export async function pack(docker: string, root: string, out: string) {
  await $`${docker} run --rm alpine mksquashfs ${root} ${out}`
  Bun.spawn(['docker', 'exec', 'c', 'mkfs.ext4', '-F', '/w/disk.img'])
}
EOF
track "${d}"
expect "a producer passed to docker, and a regex anchor, are NOT findings" "${d}" green 'RESULT: PASS'

# ---------------------------------------------------------------------------
# 19. THE SCANNER'S CONTROL ON ITSELF. An unterminated template means the
#     scanner's state machine and the file disagree, and everything after the
#     opening quote was read as string content -- the same silent-elision shape
#     case 13 fixed for heredocs. It must be a finding, not a clean file.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' 'export const oops = `an unterminated template' >"${d}/broken.ts"
track "${d}"
expect "a TypeScript file that does not scan back to code state is a finding" "${d}" red 'did not scan back to code state'

# ---------------------------------------------------------------------------
# 20. AND THE VACUITY CONTROL. TypeScript files scanned, no launch site found:
#     either the tree genuinely launches nothing, or the scanner stopped
#     recognising the language. The two look identical from the outside, so the
#     scan refuses rather than reporting the second as the first.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' 'export const answer = 42' >"${d}/quiet.ts"
track "${d}"
expect "TypeScript scanned with no launch site at all is refused" "${d}" red 'not one process launch was found'

# ---------------------------------------------------------------------------
# 21. PROSE INSIDE A QUOTED ARGUMENT IS NOT A COMMAND -- AND A COMMAND
#     SUBSTITUTION INSIDE ONE STILL IS. The first half is a defect this lint
#     carried rather than fixed: `operator_step "install the GOOD bundle (rauc
#     install <bundle>), ..."` in tests/cx3576-bench/collect.sh is one
#     English sentence, and its `(` read as a command separator to a scan that
#     did not track quoting. It was registered as a false positive, and every
#     false positive spends some of what makes a rule worth reading.
#
#     The second half is what the first must not cost. The distinction is
#     COMMAND SUBSTITUTION versus LITERAL PAREN, not quoted versus unquoted:
#     `"$(cargo build)"` compiles on this host and stays a finding. Without this
#     case the cheapest way to pass the first half is to drop every quoted span,
#     which would take a real invocation with it.
# ---------------------------------------------------------------------------
d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
cat >"${d}/prose-arg.sh" <<'EOF'
#!/bin/sh
step ab-update \
    "install the GOOD bundle (rauc install <bundle>), reboot, then confirm" \
    'and the same in single quotes (mkfs.ext4 -F disk.img) is prose too'
EOF
track "${d}"
expect "a producer named in prose inside a quoted argument is NOT a finding" "${d}" green 'RESULT: PASS'

d="$(new_fixture)"
printf '%s\n' "${DECL}" 'mksquashfs /a /b' >"${d}/declared.sh"
printf '%s\n' '#!/bin/sh' 'ver="$(cargo build --release)"' >"${d}/subst.sh"
track "${d}"
expect "a command substitution inside a double-quoted string is still a finding" "${d}" red 'subst.sh:2: `cargo` runs on the host'

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) cases)"
[ "${PASS_N}" -gt 0 ] || { echo "error: no case ran; this test would report the same green having asserted nothing" >&2; exit 1; }
[ "${FAIL_N}" -eq 0 ]
