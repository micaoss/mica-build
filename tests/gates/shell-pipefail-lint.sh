#!/usr/bin/env bash
# A pipeline whose reader exits early is a lie under `set -o pipefail`.
#
# `producer | grep -q PATTERN` looks like "did the producer say PATTERN?". It is
# not. -q makes grep exit at the FIRST match, which closes the pipe; the
# producer's next write dies of SIGPIPE (status 141); and pipefail defines the
# pipeline's status as that of the rightmost command to exit non-zero. So the
# pipeline reports FAILURE precisely when the pattern was FOUND -- the answer is
# inverted, and which way it lands depends on whether the producer still had
# bytes to write, which makes it a race rather than a reliable bug.
#
# The worst instance of it is a security assertion whose failure direction is
# green: "the MQTT bridge is granted none of Reboot, PowerOff, SetSettings or
# SetTransientRootPassword" reports PASS precisely because the grant is there.
#
# The rule is narrow on purpose, so that it has no false positives to teach
# anyone to ignore. Only -q is flagged: it prints NOTHING, so the exit status is
# the only thing a caller can want from it, and on the right of a pipe under
# pipefail that status is the one thing it gets wrong. `grep -c PATTERN
# >/dev/null` keeps the same exit status, reads to EOF, and hands nobody a
# closed pipe.
#
# `| head` is flagged too, and for the same reason with one twist: head PRINTS,
# so it is used for its output -- but under pipefail the pipeline's status is
# still the producer's SIGPIPE, and `x="$(producer | head -1)"` under `set -e`
# then kills the script. Which way it lands depends on whether the producer had
# more to write when head left, so it is the same race. `| sed -n '1p'` and
# `| awk 'NR == 1'` print the same line and read to EOF. A line that ends in
# `|| true` has already discarded the status and is not flagged.
#
# `| grep -m` and a quitting `| sed` are flagged on the same terms as head, and
# for the same reason; the `|| true` exemption is what keeps the honest uses of
# them green. tests/suites/apid-api/run.sh does `hit="$(console_since ... | grep -m1
# APID_LISTENING || true)"`, where the matched line is the point and the status
# is discarded, and it stays green.
#
# NOT matched, because no pattern tells them apart reliably: an `awk` that calls
# `exit` outside END (`| awk '{ print; exit }'` leaves early, `| awk 'END { exit
# bad }'` does not), and a `read` on the right of a pipe. Both are the same
# class. Write `awk 'NR == 1 { ... }'` and read the whole output.
#
# Comment lines are skipped, so prose describing the trap -- including the
# paragraph above -- is not reported as an instance of it.
set -euo pipefail

cd "$(dirname "$0")/../.."

PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); [ -n "${LINT_QUIET:-}" ] || echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

# AN UNRESOLVED MERGE IS REFUSED, not worked around, and the denominator is why.
#
# The file list below is `git ls-files`, which lists a path ONCE PER INDEX STAGE
# -- so during a conflicted merge a single conflicted file appears three times
# and is scanned three times. That inflates both halves of the count this script
# ends with, and the inflation is quiet: it reports more files clean than the
# tree has. Measured on this repository during a real merge -- one conflicted
# file containing `pipefail` turned 51/51 into 53/53, and the wrong figure was
# carried into two reports before anyone traced it.
#
# `sort -u` would fix the arithmetic and would be the WRONG fix. A conflicted
# file holds `<<<<<<<`, `=======` and `>>>>>>>` markers; it is not a shell script
# at all, and scanning it for a pipe into an early-exiting grep answers a
# question about a file nobody has yet written. A lint that quietly produces a
# plausible number on a tree in that state is worse than one that declines to
# answer, so this declines and says which paths are unmerged.
mapfile -t unmerged < <(git diff --name-only --diff-filter=U | sort -u)
if [ "${#unmerged[@]}" -gt 0 ]; then
    echo "error: this tree has ${#unmerged[@]} unresolved merge conflict(s), so the count below would be wrong in both halves:" >&2
    printf '         %s\n' "${unmerged[@]}" >&2
    echo "       git ls-files lists a conflicted path once per index stage, so each is scanned up to three" >&2
    echo "       times -- and a file still holding conflict markers is not a shell script to scan in the" >&2
    echo "       first place. Resolve the merge and run this again." >&2
    exit 1
fi

# The file list comes from git, so a script added to the tree is covered the day
# it lands. An untracked scratch file is deliberately out of scope. `sort -u`
# and not `sort`: the refusal above is what keeps a conflicted tree out, and this
# is the second half of the same statement -- one entry per path, whatever the
# index holds.
# *** THERE IS NO shellcheck IN THIS REPOSITORY, AND SEVEN FILES CARRY
# SUPPRESSIONS FOR IT. IF ANYBODY EVER WIRES IT UP, THOSE SUPPRESSIONS ARE PART
# OF THE PROPOSAL AND NOT AN INHERITANCE. ***
#
# Nothing here runs shellcheck -- no target, no workflow, no script. What exists
# is eleven `# shellcheck disable=` / `source=` directives across seven files
# (rootfs/build.sh, stages/compose/scripts/preset-enforce.sh,
# tests/suites/apid-api/run.sh, tests/suites/p1-writable-path-audit/{read,seed}-data.sh,
# tools/release.sh), suppressing SC2016, SC2046, SC2086, SC2116 and SC2254.
#
# A DEAD COMMENT IS INERT; A DEAD SUPPRESSION IS NOT. On the day the tool is
# added those eleven take effect immediately, against code that may have changed
# since they were written, AND THE FIRST RUN COMES BACK GREENER THAN THE TREE
# IS -- with nobody reviewing them, because they are already there and the run
# is already green. Each one must be re-justified against the code as it is
# then, not carried.
#
# AND DO NOT EXPECT shellcheck TO COVER THIS LINT'S SUBJECT OR THE ONE THAT
# KILLED tools/measure-rootfs.sh. Measured 2026-09-20 against the pre-fix file:
# `${BOARD}` used and never assigned, shellcheck EXIT 0, NO FINDINGS.
# SC2154 EXEMPTS ALL-CAPS NAMES BY DESIGN, on the assumption that they may be
# environment inputs; `${board}` in the same position does fire. COVERAGE IS NOT
# DETECTION -- a tool can cover a file completely and be silent on a defect on
# purpose, and `set -u` at runtime is what found that one.
mapfile -t files < <(git ls-files '*.sh' 'hack/*' | sort -u)
[ "${#files[@]}" -gt 0 ] || { echo "error: no shell scripts found; this lint would pass by finding nothing" >&2; exit 1; }

scanned=0
for f in "${files[@]}"; do
    [ -f "${f}" ] || continue
    # The WHOLE file, not its first N lines: `set -euo pipefail` does not have
    # to be near the top, and a scoping heuristic that quietly excludes files
    # is indistinguishable, in the output, from a tree that is clean.
    grep -c 'pipefail' "${f}" >/dev/null || continue
    scanned=$((scanned + 1))
    # A pipe, optional whitespace, then grep with -q among its flags; comment
    # lines dropped afterwards so prose about the trap is not an instance of it.
    hits="$(grep -nE '\|[[:space:]]*(command[[:space:]]+)?e?grep([[:space:]]+-[A-Za-z]*q[A-Za-z]*)+' "${f}" |
        grep -vE '^[0-9]+:[[:space:]]*#' || true)"
    # The same trap with a printing reader: `| head`, unless the line discards the status with `|| true`.
    heads="$(grep -nE '\|[[:space:]]*(head([[:space:]]|$)|(command[[:space:]]+)?e?grep[[:space:]]+-[A-Za-z]*m|sed[[:space:]]+(-n[[:space:]]+)?.?[0-9]*q)' "${f}" |
        grep -vE '^[0-9]+:[[:space:]]*#' | { grep -vF '|| true' || true; } || true)"
    if [ -n "${hits}${heads}" ]; then
        [ -z "${hits}" ] || while IFS= read -r h; do
            fail "${f}:${h%%:*}: an early-exiting grep on the right of a pipe, in a file that sets pipefail: the pipeline reports failure when the pattern IS found. Use 'grep -c ... >/dev/null'"
        done <<<"${hits}"
        [ -z "${heads}" ] || while IFS= read -r h; do
            fail "${f}:${h%%:*}: an early-exiting reader on the right of a pipe, in a file that sets pipefail: the producer dies of SIGPIPE and the pipeline reports failure. Use \"sed -n '1p'\" or \"awk 'NR == 1'\", or discard the status with '|| true'"
        done <<<"${heads}"
    else
        pass "${f} pipes nothing into an early-exiting reader"
    fi
done

[ "${scanned}" -gt 0 ] || { echo "error: no file enabled pipefail; the scan matched nothing and would report clean" >&2; exit 1; }

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) ($((PASS_N))/$((PASS_N + FAIL_N)) files clean, ${scanned} scanned)"
[ "${FAIL_N}" -eq 0 ]
