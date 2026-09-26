#!/usr/bin/env bash
# tests/suites/bare-host-gate/gate.sh runs this inside the pinned upstream:docker:28-cli
# plus `apk add bash make`; it IS the constrained host, so every command below
# is a host command by construction. No `# mica-build-side: container` marker for
# the reason substrate.sh states: nothing here is a producer, and declaring a
# file elides it from the lint's scan rather than exempting anything.
#
# RUNGS 1-3 of PLAN-080 section 4.2's ladder, re-climbed on demand.
#
# THE CEILING, and it is below section 4's. This climbs:
#
#   rung 1  bash bin/bun.sh tests/gates/host-toolchain-lint.ts  -- bash runs a gate, make unreachable
#   rung 2  make docs-verify                       -- make alone runs five
#           make os-host-toolchain-lint            -- and the policy's own check
#   rung 3  make os-layout-lint                    -- bun, out of a container
#           make os-verify-test                    -- 1270 tests, no host bun
#
# It does NOT climb rung 4 -- `bash bin/bun.sh src/cli.ts components image --board <board> [explicit component inputs]` and then
# `bash bin/bun.sh src/cli.ts verify --board uefi-x64`, which section 4 ran by hand to
# `PASS (313/313)`. Assembling an image needs the amd64 package pool and a
# composed rootfs; a fresh clone has neither and making them costs tens of
# minutes. PLAN-080 section 10 predicted exactly this when it sized B6: it
# "needs a pool or a cached rootfs to be worth running". A cheap gate that runs
# beats an exhaustive one somebody turns off, so the ceiling is here and the
# rungs above it are named rather than implied.
#
# WHAT THE LOWER CEILING STOPS COVERING -- the part that must not be left to be
# discovered:
#
#   - Every host tool reachable only from the assembly path. src/rootfs/build.ts,
#     src/image/toolbox.ts's toolsets, pkgs/*/build.sh, the
#     board bsp Makefiles: nothing here EXECUTES any of them.
#   - `bash bin/bun.sh src/cli.ts build-rootfs`. Section 4.4 measured it refusing on
#     the container route for want of one COPY of the buildx plugin into
#     verify/Dockerfile; RFCT-347 landed that COPY, so the refusal is gone and
#     the mode composes there -- an uefi-x64 root, then an image, then
#     `verify --verify` at 315/315, all with bun out of the pinned image. What
#     stops THIS gate climbing to it is unchanged and is the pool, not the
#     plugin: a `--depth 1` clone inside the CLI image has no _out/debs, and
#     building one is the tens of minutes the ceiling exists to avoid.
#   - `make os-build-test`, the first rung above this ceiling and the one worth
#     adding next: it opens the assemblers' toolboxes for real, which is the
#     closest thing to rung 4 that needs no pool. Section 8 measured two of its
#     files alone at ~118 s, so it is affordable but not free, and it is left
#     out rather than added without the run that prices the whole suite.
#
# The half of that gap which can be closed WITHOUT executing anything is closed
# at rung 2, and that is the reason the lint runs in here rather than only on
# the host: tests/gates/host-toolchain-lint.ts reads every tracked script, including
# all the ones this ladder never runs, so a producer that starts reaching for a
# host tool inside src/rootfs/build.ts is still a finding. What neither half sees is
# section 6's own stated residue -- a binary behind a variable, a heredoc body,
# and a `# mica-build-side: container` declaration that is simply wrong.
set -euo pipefail

CLONE="${MICA_BARE_HOST_CLONE:?the gate passes the clone path in; without it the paths below are guesses}"
cd "${CLONE}"

LOGDIR="$(mktemp -d)"
trap 'rm -rf "${LOGDIR}"' EXIT

# ---------------------------------------------------------------------------
# The surface, re-measured after the two packages arrived.
#
# substrate.sh asserted this image carries the permitted set and neither bash
# nor make. This asserts that the add did what it said and NOTHING ELSE: `apk
# add bash make` pulls dependencies, and a gate whose constraint quietly widened
# because a dependency dragged a compiler in would keep reporting green while
# testing a host nobody described.
# ---------------------------------------------------------------------------
echo "=== rungs 1-3: the constrained host, measured before it is used ==="
for t in bash make; do
    p="$(command -v "${t}" 2>/dev/null || true)"
    [ -n "${p}" ] || {
        echo "error: ${t} is still not on PATH after \`apk add --no-cache bash make\`." >&2
        echo "       Rungs 1 and 2 exist to run it; there is nothing to climb." >&2
        exit 1
    }
    # `awk NR==1` and not `head -1`: head closes the pipe at the first line and
    # this script runs under pipefail, so a version banner longer than the pipe
    # buffer would come back as a SIGPIPE failure on a line that is only saying
    # which bash arrived.
    ver="$("${t}" --version 2>/dev/null | awk 'NR==1')"
    echo "PASS: added and present: ${t} at ${p} (${ver})"
done

# The forbidden set is NOT a list kept here. It is
# tests/gates/host-toolchain-lint.ts's producer table, read out of the tree under
# test -- one table, two readers. A second copy would agree with the first
# right up until somebody added a row to one of them, and then this gate would
# be checking a policy the tree had already moved past.
mapfile -t PRODUCERS < <(bash bin/bun.sh tests/gates/host-toolchain-lint.ts --print-tools)
[ "${#PRODUCERS[@]}" -gt 0 ] || {
    echo "error: tests/gates/host-toolchain-lint.ts --print-tools listed no producers." >&2
    echo "       Every absence assertion below would then pass over an empty set, which is a" >&2
    echo "       green report about nothing." >&2
    exit 1
}
# One of them IS reachable, and finding that out is what this assertion is for.
# Measured 2026-09-05: `command -v mkfs.vfat` answers /sbin/mkfs.vfat in this
# image, and `readlink -f` says /bin/busybox -- the multi-call binary answers to
# `mkdosfs` and `mkfs.vfat` as well as to sh, awk and sed. Section 1 permits a
# busybox userland, so this is not an image that grew a toolchain; it is the one
# binary that was already permitted, wearing another of its names.
#
# It is recorded rather than waived. A busybox applet is not a toolchain and
# using it is not a route anything here can take -- section 0.1 gives every
# producer a container with no host route, and section 0.2's first measurement
# is precisely that this mkfs.vfat does not know `--invariant` -- but a producer
# that is REACHABLE is worth a line in the transcript rather than silence.
#
# Anything reachable that is NOT busybox is fatal, and that is the assertion
# with the teeth: a cargo, an mksquashfs, an sgdisk or an openssl in here would
# mean the rungs below passed because of it.
applets=()
toolchain=()
for t in "${PRODUCERS[@]}"; do
    p="$(command -v "${t}" 2>/dev/null || true)"
    [ -n "${p}" ] || continue
    real="$(readlink -f "${p}" 2>/dev/null || printf '%s' "${p}")"
    if [ "$(basename "${real}")" = busybox ]; then
        applets+=("${t} at ${p} -> ${real}")
    else
        toolchain+=("${t} at ${p} -> ${real}")
    fi
done
if [ "${#toolchain[@]}" -gt 0 ]; then
    echo "error: this container can reach ${#toolchain[@]} producer(s) the criterion's host must not have:" >&2
    printf '         %s\n' "${toolchain[@]}" >&2
    echo "       None of them is busybox wearing another name, so this is a real toolchain, and" >&2
    echo "       whatever passes below would have passed BECAUSE of it rather than despite it." >&2
    echo "       Either upstream:docker:28-cli moved to a fatter image, or \`apk add bash make\` now" >&2
    echo "       drags one in." >&2
    exit 1
fi
echo "PASS: no producer in tests/gates/host-toolchain-lint.ts's ${#PRODUCERS[@]}-row table is reachable except as a busybox applet"
if [ "${#applets[@]}" -gt 0 ]; then
    printf 'NOTE: reachable, and busybox: %s\n' "${applets[@]}"
fi

# ---------------------------------------------------------------------------
# Naming what broke.
#
# "The build failed on a bare host" is a dated observation with the date taken
# off. What a reader needs is the tool and the file, so a rung that goes red
# reads as a finding about ONE invocation instead of a report that something,
# somewhere, needs something.
#
# Four signatures, all of them measured in this image on 2026-09-05 rather than
# recalled:
#
#   bash        /tmp/b.sh: line 3: nosuchtool: command not found   <- file AND line
#   busybox sh  /tmp/s.sh: line 2: nosuchtool: not found
#               /bin/sh: nosuchtool: not found
#   make        make: nosuchtool: No such file or directory
#   this tree   error: <tool> is required and not on PATH          <- ten scripts
#
# The first two carry the file themselves. The last two do not, so every tool is
# ALSO located by a command-position grep over the tracked surface -- the same
# match shape tests/gates/host-toolchain-lint.ts uses, which is why a hit here reads
# the way a hit there does.
#
# AND THE TRANSCRIPT IS READ ON THE GREEN PATH TOO, which is not symmetry for
# its own sake. Measured 2026-09-05, by planting `jq -r .version package.json`
# into tools/docs/verify-index.sh above its `set -euo pipefail`: busybox printed
# `tools/docs/verify-index.sh: line 30: jq: not found`, the script carried on, the
# rung exited 0 and the gate reported PASS. A gate that watched only exit codes
# would have called a new host dependency green -- so a tool named in the output
# of a rung that SUCCEEDED is a finding as well, and it says which of the two
# shapes it is.
# ---------------------------------------------------------------------------
ere_quote() { printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g'; }

# 0 when it found nothing to say, 1 when it named at least one tool.
report_missing() {
    local log="$1" rung="$2" cmd="$3" mode="$4"

    mapfile -t records < <(awk '
        # bash and busybox sh, when a SCRIPT was running: the file and the line
        # are already in the message.
        /^[^ ]+: line [0-9]+: [^ :]+: (command )?not found$/ {
            n = split($0, p, ": "); sub(/^line /, "", p[2])
            print p[3] "\t" p[1] "\t" p[2]; next
        }
        # busybox sh at top level: `/bin/sh: <tool>: not found`.
        /^[^ ]+: [^ :]+: not found$/ { split($0, p, ": "); print p[2] "\t\t"; next }
        # make resolves a recipe first word itself and reports it its own way.
        /^make(\[[0-9]+\])?: [^ :]+: (No such file or directory|Command not found)$/ {
            split($0, p, ": "); print p[2] "\t\t"; next
        }
        # And this tree guards for itself in ten scripts, in one phrasing.
        /error: [^ ]+ is required and not on PATH/ {
            line = $0; sub(/^.*error: /, "", line); split(line, q, " ")
            print q[1] "\t\t"; next
        }
    ' "${log}" | sort -u)

    if [ "${#records[@]}" -eq 0 ]; then
        if [ "${mode}" = failed ]; then
            echo >&2
            echo "error: rung ${rung} failed -- \`${cmd}\` -- and nothing in its output looks like a" >&2
            echo "       missing host tool. As far as this gate can tell that is a broken build rather" >&2
            echo "       than a broken criterion, and the transcript above is the evidence either way." >&2
            echo "       If it IS a host tool in a shape this cannot read, that shape belongs beside" >&2
            echo "       the four signatures above." >&2
        fi
        return 0
    fi

    echo >&2
    if [ "${mode}" = failed ]; then
        echo "error: rung ${rung} went red on a MISSING HOST TOOL, which is the criterion breaking and" >&2
        echo "       not merely a build breaking. \`${cmd}\` needs something PLAN-080 section 1 does not" >&2
        echo "       permit on the host." >&2
    else
        echo "error: rung ${rung} REPORTED SUCCESS while reaching for a host tool that is not there." >&2
        echo "       \`${cmd}\` exited 0 -- the absence was tolerated, by a command ahead of \`set -e\`" >&2
        echo "       or a probe whose failure something swallowed -- so its status says nothing about" >&2
        echo "       this. The criterion is broken either way: a path here wants a tool PLAN-080" >&2
        echo "       section 1 does not permit on the host, and only the transcript shows it." >&2
    fi

    local seen="" tool file line q hits
    for rec in "${records[@]}"; do
        IFS=$'\t' read -r tool file line <<<"${rec}"
        [ -n "${tool}" ] || continue
        case " ${seen} " in *" ${tool} "*) ;; *) seen="${seen} ${tool}" ;; esac
        echo >&2
        echo "       tool: ${tool}" >&2
        if [ -n "${file}" ]; then
            echo "       named by the run: ${file}:${line}" >&2
        fi
        q="$(ere_quote "${tool}")"
        # Command position, the shape tests/gates/host-toolchain-lint.ts matches. `|| true`
        # because a tool with no call site in the tree is a real answer -- it means
        # something reached for it through a variable, or a Makefile recipe did.
        hits="$(git grep -n -E "(^|[;&|(]|&&|\|\|)[[:space:]]*${q}([[:space:]]|\$)" -- '*.sh' 'Makefile' '*/Makefile' '.github/workflows/*.yml' 2>/dev/null | head -8 || true)"
        if [ -n "${hits}" ]; then
            echo "       in command position in the tree:" >&2
            # Piped through sed rather than `printf '   %s\n'`: hits is ONE
            # multi-line string, so a printf format indents its first line and
            # leaves the rest flush against the margin.
            printf '%s\n' "${hits}" | sed 's/^/         /' >&2
        else
            echo "       no call site in command position; it is reached through a variable, a" >&2
            echo "       recipe, or a file this grep does not read." >&2
        fi
    done

    echo >&2
    echo "       PLAN-080 section 1 permits docker, git, bash, make and a busybox userland on the" >&2
    echo "       host and nothing else. Two ways out, and they are not the same decision:" >&2
    echo "         - move the invocation into a container, which is what section 3's boundary test" >&2
    echo "           asks of anything that can change a byte it writes; or" >&2
    echo "         - if it really is orchestration -- it produces nothing and only decides which" >&2
    echo "           container runs -- widen section 1's permitted set and substrate.sh's PERMITTED" >&2
    echo "           list with it, which is a decision that leaves a record." >&2

    # 1, and explicitly rather than by falling off the end: without this the
    # function returns the last echo's status, which is 0, and run_step's
    # `|| exit 1` never fires -- a finding printed and then walked past. That is
    # not hypothetical; it is what the first run of the green-path scan did.
    return 1
}

# ---------------------------------------------------------------------------
# The climb.
# ---------------------------------------------------------------------------
STEP=0
run_step() {
    local rung="$1"
    shift
    STEP=$((STEP + 1))
    local log="${LOGDIR}/step-${STEP}.log"
    local rc=0
    echo
    echo "--- rung ${rung}: $* ---"
    "$@" 2>&1 | tee "${log}" || rc=$?

    if [ "${rc}" != 0 ]; then
        report_missing "${log}" "${rung}" "$*" failed || true
        exit 1
    fi
    # Exit 0 is not the end of the question -- see the note above the signatures.
    report_missing "${log}" "${rung}" "$*" green || exit 1
    echo "--- rung ${rung}: PASS ---"
}

# Rung 1. One gate, run by bash, with make still unreachable to it. It is the
# smallest statement the ladder makes: this tree's entry point is bin/bun.sh, a
# bash script, and it runs a gate on a host with no bun (its container route).
# Since the host-side gates became TypeScript no gate needs nothing but bash.
run_step 1 bash bin/bun.sh tests/gates/host-toolchain-lint.ts

# Rung 2. The target names are the build's interface, so make running a gate
# is a different claim from bash running one; and the policy's own check is
# here because it is what covers everything above this ladder's ceiling.
run_step 2 make os-host-toolchain-lint

# Rung 3. Both of these reach for bun, which this host does not have and must
# not need: bin/bun.sh src/cli.ts takes its container route, and what runs is the bun
# pinned as mica-build-env:base. This is the rung that proves a judge's container route
# is sufficient on its own -- PLAN-080 section 3.1's ruling, executed.
run_step 3 make os-layout-lint
# The verify suite reads the engine's pins out of the pinned mica-podman archives, which a
# fresh clone does not hold: taken exactly as ci.yml takes them before the same suite.
run_step 3 bash bin/bun.sh src/cli.ts pool fetch --arch amd64 --packages mica-podman
run_step 3 bash bin/bun.sh src/cli.ts pool fetch --arch arm64 --packages mica-podman
run_step 3 bash bin/bun.sh src/cli.ts podman-pool --check
# And every board's bundle, which the verify suite reads out of _out/boards: `make board-fetch-all` as ci.yml
# runs it, against the certificate the gate was handed (MICA_VERITY_TRUST_CERT). A kernel is reused only from a
# release built from the same inputs, so between a change of kernel inputs and the next release this rung
# refuses by name rather than passing over no boards.
run_step 3 make board-fetch-all
run_step 3 make os-verify-test

echo
echo "rungs 1-3: ${STEP} steps, all green, on a host with docker, git, bash, make and busybox."
echo "NOT climbed, and stated so the record is not read as more than it is: rung 4 --"
echo "  \`bash bin/bun.sh src/cli.ts components image --board <board> [explicit component inputs]\` and \`bash bin/bun.sh src/cli.ts verify --board <board>\` --"
echo "  needs the amd64 package pool, and that is now the ONLY thing in the way: PLAN-080 B5's"
echo "  COPY landed, so \`--build-rootfs\` no longer refuses the pinned-container route."
