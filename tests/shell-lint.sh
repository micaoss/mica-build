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
# ALSO FLAGGED, since 2026-09-16 (mica-podman found the same class in this
# shape): `| grep -m<n>` and `| head`. They print, so they look like a value
# rather than a status, but they exit at their limit just as `-q` does, and the
# producer's next write dies of SIGPIPE under pipefail -- a failure that depends
# on how much the producer still had to say. The fix is the same shape every
# time: take the first match where the reading happens (`sed -n '/x/{s///;p;q;}'`
# over a file, `grep -m1` with no pipe), or capture the whole output and take the
# first line with `${value%%$'\n'*}`. Not flagged: `| tail`, `| sed q` and awk
# with `exit`, which read to EOF or are not in use here.
#
# Comment lines are skipped, so prose describing the trap -- including the
# paragraph above -- is not reported as an instance of it.
set -euo pipefail

cd "$(dirname "$0")/.."

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
mapfile -t files < <(git ls-files '*.sh' 'hack/*' | sort -u)

# EVERY tracked shell file is syntax-checked, before any rule below runs and
# whatever the file does with pipefail. `bash -n` costs milliseconds and
# catches the class no rule about pipelines can see: on 2026-09-20 an edit to
# a board's kernel prepare hook dropped the `# ` from a comment line, `make
# check` was green, and CI failed inside a container at the one step that runs
# that hook -- after the source fetch and the toolchain, minutes in. A syntax
# error is the cheapest possible failure to move earlier.
syntax_bad=0
for f in "${files[@]}"; do
    if out="$(bash -n "${f}" 2>&1)"; then
        continue
    fi
    syntax_bad=1
    FAIL_N=$((FAIL_N + 1))
    echo "FAIL: ${f}: not valid bash: ${out}" >&2
done
[ "${syntax_bad}" = 0 ] || { echo "RESULT: FAIL (a tracked shell file does not parse)"; exit 1; }
[ "${#files[@]}" -gt 0 ] || { echo "error: no shell scripts found; this lint would pass by finding nothing" >&2; exit 1; }

# A SOURCED LIBRARY RUNS UNDER ITS CALLER'S OPTIONS, so it is in scope even
# though it sets none of its own. tools/deb/registry.sh is the case that taught
# this: it is sourced by the publishers, which set pipefail, and it held a
# `printf | grep -q` membership test that this lint never saw.
sourced=" "
for f in "${files[@]}"; do
    [ -f "${f}" ] || continue
    grep -c 'pipefail' "${f}" >/dev/null || continue
    while IFS= read -r lib; do
        for candidate in "${files[@]}"; do
            [ "${candidate##*/}" = "${lib##*/}" ] || continue
            case "${sourced}" in *" ${candidate} "*) ;; *) sourced="${sourced}${candidate} " ;; esac
        done
    done < <(sed -n 's/^[[:space:]]*\(\.\|source\)[[:space:]][[:space:]]*"\{0,1\}\([^"]*\.sh\)"\{0,1\}[[:space:]]*$/\2/p' "${f}")
done

scanned=0
for f in "${files[@]}"; do
    [ -f "${f}" ] || continue
    # The WHOLE file, not its first N lines: `set -euo pipefail` does not have
    # to be near the top, and a scoping heuristic that quietly excludes files
    # is indistinguishable, in the output, from a tree that is clean.
    if ! grep -c 'pipefail' "${f}" >/dev/null; then
        case "${sourced}" in *" ${f} "*) ;; *) continue ;; esac
    fi
    scanned=$((scanned + 1))
    # A pipe, optional whitespace, then grep with -q among its flags; comment
    # lines dropped afterwards so prose about the trap is not an instance of it.
    hits="$(grep -nE '\|[[:space:]]*(command[[:space:]]+)?(e?grep([[:space:]]+-[A-Za-z]*[qm][A-Za-z]*)+|head([[:space:]]|$))' "${f}" |
        grep -vE '^[0-9]+:[[:space:]]*#' || true)"
    if [ -n "${hits}" ]; then
        while IFS= read -r h; do
            fail "${f}:${h%%:*}: an early-exiting reader (grep -q, grep -m, head) on the right of a pipe, in a file that sets pipefail or is sourced by one: the reader stops and the producer dies of SIGPIPE, so the pipeline fails exactly when it found what it was looking for. Use 'grep -c ... >/dev/null' or a loop for a membership test, and take a first match where the reading happens (sed with q, grep -m1 without a pipe) or from a captured value"
        done <<<"${hits}"
    else
        pass "${f} pipes nothing into an early-exiting reader"
    fi
done

[ "${scanned}" -gt 0 ] || { echo "error: no file enabled pipefail; the scan matched nothing and would report clean" >&2; exit 1; }

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) ($((PASS_N))/$((PASS_N + FAIL_N)) files clean, ${scanned} scanned)"
[ "${FAIL_N}" -eq 0 ]
