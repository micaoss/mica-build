#!/bin/sh
# The assertion that the image standing in for the criterion's host really is
# that host. tests/bare-host-gate/gate.sh runs it inside the pinned
# IMAGE_DOCKER_CLI_28, before anything is added to it.
#
# No `# mica-build-side: container` marker, although this does run in one: it
# invokes no producer, so the marker would buy nothing and cost the scan --
# tests/host-toolchain-lint.sh elides a declared file WHOLE, so declaring this
# one would take it out of the 9371 command lines that check examines and
# enlarge the declared set PLAN-080 section 9 asks to be kept small enough to
# read.
#
# RUNG 0 of PLAN-080 section 4.2's ladder, and the control the rest of the gate
# rests on. Everything above it would still report green if this image quietly
# grew a compiler, so the first thing measured is the image itself.
#
# WHY THIS FILE IS `sh` AND NOT `bash`. Because at this rung there is no bash --
# that is the finding. Section 4.2 recorded `sh: bash: not found` and
# `sh: make: not found` here and used it to settle the `make` ruling in section
# 1: a host with literally only docker and git runs nothing in this tree, and
# bash and make are the smallest addition that changes it. This asserts the same
# two absences on every run, so the day the pin moves to an image that ships
# them, the ladder's own premise fails loudly instead of quietly becoming a
# weaker test.
set -eu

PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

# PLAN-080 section 1's permitted set, minus bash and make, which are the two
# this rung requires to be ABSENT. `sh`, `awk`, `sed`, `grep`, `sha256sum` and
# `tar` are the busybox userland that table names; docker and git are the two
# the criterion itself names.
PERMITTED="sh git docker awk sed grep sha256sum tar"
for t in ${PERMITTED}; do
    p="$(command -v "${t}" 2>/dev/null || true)"
    if [ -n "${p}" ]; then
        pass "permitted and present: ${t} at ${p}"
    else
        fail "permitted by PLAN-080 section 1 and MISSING from this image: ${t}. The gate's rungs assume it, so the pin and that table have gone out of step"
    fi
done

for t in bash make; do
    if command -v "${t}" >/dev/null 2>&1; then
        fail "${t} is already in ${0##*/}'s image. PLAN-080 section 4.2 measured it absent and the ladder ADDS it at the next rung; an image that ships it makes rungs 1 and 2 a test of nothing"
    else
        pass "absent, as section 4.2 measured: ${t}"
    fi
done

# The criterion names docker, and a docker with no daemon behind it is a
# binary. Asked here, where the answer is still about a socket mount.
if v="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" && [ -n "${v}" ]; then
    pass "the daemon answers: Server ${v}"
else
    fail "\`docker version\` got no server version. The socket is mounted; what is behind it did not reply, and every rung above this one either starts a container or drives something that does"
fi

# And it names git. `git ls-files` is where every gate in this tree gets its
# surface, so a clone that answers zero would make the whole ladder pass over
# nothing -- the same positive control tests/host-toolchain-lint.sh takes on its
# own file list.
sha="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -n "${sha}" ]; then
    pass "git reads the clone: HEAD ${sha}"
else
    fail "\`git rev-parse HEAD\` answered nothing inside the container. The clone is mounted at ${MICA_BARE_HOST_CLONE:-?}; either the mount carried nothing or git refused the checkout"
fi

n="$(git ls-files | wc -l | tr -d " " 2>/dev/null || echo 0)"
if [ "${n}" -gt 0 ]; then
    pass "the clone is populated: ${n} tracked files"
else
    fail "git ls-files listed 0 files. Every rung above reads its surface from this, so a gate that continued would report green having checked nothing"
fi

echo
echo "rung 0: ${PASS_N} passed, ${FAIL_N} failed"
[ "${FAIL_N}" -eq 0 ] || {
    echo "error: the substrate is not the host PLAN-080 section 1 describes, so nothing above this rung would mean what it says." >&2
    exit 1
}
