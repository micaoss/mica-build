#!/usr/bin/env bash
# No toolchain on the host. No compilation on the host. No assembly on the host.
#
# The policy is mica:docs/design/build.md section 0, and this is what makes it fail.
# It exists because that page has carried the claim -- "no toolchain is
# installed on the host, and every compiler comes out of a builder image pinned
# by digest" -- for as long as it has existed, while paths that contradict it
# sat in the tree with nothing going red.
#
# WHAT IT LOOKS FOR. Three shapes over two surfaces. In shell: one producer
# binary in command position, in a file that has not declared itself
# container-side -- and one PATH assignment that prepends a directory under
# $HOME, which is how a script reaches for a toolchain that is not on the
# machine's PATH at all. In TypeScript: one producer binary NAMED by a process
# launch -- a bun shell template or an argv-taking spawn -- which is the shape
# `bin/bun.sh src/cli.ts` and `bin/bun.sh src/cli.ts` would take if a fifth toolbox seam were
# written past the four that are closed. The second shape exists
# because the first one nearly missed the largest violation in the tree: this
# host has no cargo, and `micad:hack/check.sh` finds one only because its
# line 8 puts $HOME/.cargo/bin in front. A producer is a tool whose own build can
# change the bytes it writes: a compiler, a filesystem maker, an image
# assembler, a packer, a signer. mica:docs/design/build.md section 0 states the test
# that decides whether a new tool belongs in the table below; this file is the
# table, not the rule.
#
# WHAT IT CANNOT SEE, said here rather than discovered later:
#
#   - A binary invoked through a VARIABLE. `"${MKIMAGE}" -T script` is a real
#     mkimage call and nothing here matches it; tests/handshake-test/harness.sh
#     line 101 is exactly that shape, and it is covered only because the file
#     declares its side. A grep cannot resolve a variable, and pretending
#     otherwise would be worse than saying so.
#   - A HEREDOC BODY. Bodies are skipped whole. (A comment that merely MENTIONS
#     one does not open it: comments are looked at first, or a `# ... <<EOF` in
#     prose would elide the rest of the file and still report it clean.) Every heredoc in this tree that
#     carries a producer today carries a CONTAINER script -- `docker run ...
#     <<'INNER'`, or a `cat > inner.sh` whose output is run in one -- so the
#     elision costs nothing measured; a host build step written into one would
#     not be seen.
#   - A STRING THAT SPANS LINES. What a quoted string makes literal is not a
#     command position, so quoted spans are blanked before a producer is looked
#     for -- `"install the GOOD bundle (rauc install <bundle>), ..."` is one
#     English sentence and not a call. That is done a line at a time, so a quote
#     opened on one line and closed on another leaves the first line unbalanced,
#     and an unbalanced line is matched exactly as it came -- which is what this
#     lint did everywhere until 2026-09-07, so the cost is a false positive and
#     never a missed one. A COMMAND SUBSTITUTION IS NOT LITERAL and stays
#     visible wherever it sits: `"$(cargo build)"` is a finding.
#   - A SCRIPT WRITTEN INTO A QUOTED ARGUMENT, for the same reason and with the
#     same answer as a heredoc body above: `bash -c 'cd x && cargo build'` runs
#     cargo on this host and is not seen, because nothing here can tell it from
#     `docker run ... sh -c 'mkfs.ext4 ...'`, which is the toolbox. There is no
#     such site in the tree -- the change that blanked quoted spans moved the
#     finding count by exactly one, the sentence at
#     tests/cx3576-bench/collect.sh:1058 -- and a `-c` special case would buy
#     nothing present at the price of flagging every container's script.
#   - A DECLARATION THAT IS WRONG. `# mica-build-side: container` is a claim by
#     whoever wrote it. This counts the claims and refuses a run that found
#     none; it cannot check one.
#   - A TYPESCRIPT LAUNCH THROUGH A VARIABLE. The second scan below reads every
#     tracked `.ts` file, but it can only report the command a call site NAMES:
#     `$`${docker} exec ...`` and `Bun.spawn(argv)` resolve at runtime, and 16
#     of this tree's 35 launch sites are that shape. They are counted and
#     reported as unresolved rather than passed over silently.
#   - A TYPESCRIPT WHOLE-FILE MARKER ONLY. Since P2 of the one-language plan a
#     `.ts` file can be a container's script (the runtime composition in the
#     pack stage, the boot logo and the regdb export in the kernel builds), so
#     `// mica-build-side: container -- <why>` in a file's leading comment
#     declares the whole file, as `#` does for shell. No block form: a
#     TypeScript file runs on one side. A finding that must stand is
#     registered in the exemption file like any other.
#
# DECLARING A SIDE. Two markers, both requiring a reason after `--`:
#
#   # mica-build-side: container -- <why>          the whole FILE runs in an image;
#                                                 must appear before any code
#   # mica-build-side: container-block -- <why>    the lines BELOW run in an image
#   # mica-build-side: host                        ...and here they stop
#
# EXEMPTIONS live in tests/fixtures/host-toolchain-exemptions, one `path<TAB>tool<TAB>reason`
# per site, and an exemption that matches NOTHING is a failure -- a rename must
# not leave a rule behind about a file that has moved, and a path that stops
# violating the policy must not keep a silent waiver.
#
#   bash tests/gates/host-toolchain-lint.sh            (or: make os-host-toolchain-lint)
#   bash tests/gates/host-toolchain-lint.sh --root DIR  scan another checkout; used by
#                                                 tests/gates/host-toolchain-lint-test.sh
#   bash tests/gates/host-toolchain-lint.sh --print-tools
#                                                 the table below, one tool per
#                                                 line, and nothing else; used by
#                                                 tests/suites/bare-host-gate/ladder.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRINT_TOOLS=0
while [ "$#" -gt 0 ]; do
    case "$1" in
    --print-tools)
        PRINT_TOOLS=1
        shift
        ;;
    --root)
        [ -n "${2-}" ] || { echo "error: --root takes a directory" >&2; exit 1; }
        ROOT="$(cd "$2" && pwd)"
        shift 2
        ;;
    *) echo "error: '$1' is not an option this lint takes" >&2; exit 1 ;;
    esac
done
cd "${ROOT}"

# THE TABLE, by kind, with the reason each kind is in it. It is not the policy
# -- mica:docs/design/build.md section 0 is -- but a reader adding a row should be
# able to see which arm of that test the row belongs to.
#
#   toolchain   a compiler decides the bytes even when the binary is discarded:
#               `cargo clippy -- -D warnings` turns a toolchain difference into
#               red or green, and mica:docs/design/build-harness.md section 3 has the
#               measurement (a 1.96 rustc ahead of the image's 1.98 reported
#               `can't find crate for std` against a workspace that was fine).
#   filesystem  which e2fsprogs, which mkfs.vfat. This host's mkfs.vfat is
#               BusyBox's and does not know `--invariant`.
#   assembly    which sgdisk, which grub-efi-amd64-bin. BOOTX64.EFI is only as
#               reproducible as the package in its container.
#   package     which dpkg, which rauc. A bundle built by rauc 1.8 was refused
#               by a device's 1.13; commit 9a43a59 records it.
#   signing     what openssl writes into a certificate is openssl's decision.
#
# NOT in the table, deliberately: `cc`, `ld`, `go`, `make`, `tar`, `install`.
# Each is either a word that appears constantly in prose and in paths, or
# orchestration by the section-0 test. A rule whose findings are mostly false
# positives teaches people to ignore it, which is worse than no rule --
# tests/gates/shell-pipefail-lint.sh states the same principle for the same reason.
#
# `jq` IS THE AWKWARD ONE, and it is left out with its exception named rather
# than quietly. It is orchestration nearly everywhere here -- reading a field,
# building a fixture -- but pkgs/rauc/gen-dev-keys.sh edits
# meta/updates/manifest.json with it, and that file reaches the image. A row
# for `jq` would flag tests/gates/release-verify-test.sh's fixture edits too, which
# are verdicts, and the table cannot tell the two apart from the binary's name.
# So the one producing use travels with that script's existing openssl
# exemption and its backlog item, which is where it will actually be fixed.
TOOLS='cargo|rustc|gcc|g\+\+|tsc|bun'
TOOLS="${TOOLS}"'|mkfs\.vfat|mkfs\.ext4|mkfs\.fat|mke2fs|mksquashfs|unsquashfs|debugfs|dumpe2fs|e2fsck|resize2fs|tune2fs'
TOOLS="${TOOLS}"'|sgdisk|sfdisk|parted|mcopy|mmd|mkimage|mkenvimage|veritysetup|grub-mkstandalone|grub-install|grub-editenv'
TOOLS="${TOOLS}"'|dpkg-deb|dpkg-buildpackage|dpkg-scanpackages|apt-ftparchive|rauc'
TOOLS="${TOOLS}"'|openssl|gpg'

# ONE TABLE, TWO READERS. tests/suites/bare-host-gate/ladder.sh asserts that none of
# these is reachable inside the container standing in for the criterion's host,
# and it reads them from here rather than keeping its own list. A second copy
# would agree with this one exactly until somebody added a row to one of them,
# and then the gate would be measuring a policy the tree had already moved past.
# The alternation is an ERE, so the backslashes come back out: `g\+\+` is `g++`
# and `mkfs\.vfat` is `mkfs.vfat`, which is what `command -v` needs to be asked.
if [ "${PRINT_TOOLS}" = 1 ]; then
    printf '%s\n' "${TOOLS}" | tr '|' '\n' | sed 's/\\//g'
    exit 0
fi

PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); [ -n "${LINT_QUIET:-}" ] || echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

# AN UNRESOLVED MERGE IS REFUSED. git ls-files lists a path once per index
# stage, so during a conflicted merge one file is scanned up to three times and
# every count below is inflated -- quietly, in the direction of "more files
# clean than the tree has". tests/gates/shell-pipefail-lint.sh declines for the same
# reason and says so at greater length.
mapfile -t unmerged < <(git diff --name-only --diff-filter=U | sort -u)
if [ "${#unmerged[@]}" -gt 0 ]; then
    echo "error: this tree has ${#unmerged[@]} unresolved merge conflict(s), so the counts below would be wrong:" >&2
    printf '         %s\n' "${unmerged[@]}" >&2
    exit 1
fi

# The surface. DOCKERFILES ARE NOT SCANNED and that is not an oversight: a
# Dockerfile IS a container, and every RUN in one is already on the right side
# of the policy. The list comes from git, so a script added to the tree is
# covered the day it lands.
mapfile -t files < <(git ls-files '*.sh' 'Makefile' '*/Makefile' '.github/workflows/*.yml' | sort -u)
[ "${#files[@]}" -gt 0 ] || {
    echo "error: no shell scripts, Makefiles or workflows found; this lint would pass by finding nothing" >&2
    exit 1
}

# The exemption register. Absent means empty, which is the state a fixture
# checkout is in; the matches-nothing rule below is what keeps the real one
# honest.
EXEMPTIONS="tests/fixtures/host-toolchain-exemptions"
declare -A EXEMPT_REASON=()
declare -A EXEMPT_HITS=()
EXEMPT_N=0
if [ -f "${EXEMPTIONS}" ]; then
    while IFS=$'\t' read -r epath etool ereason; do
        case "${epath}" in '' | '#'*) continue ;; esac
        [ -n "${etool}" ] && [ -n "${ereason}" ] || {
            echo "error: ${EXEMPTIONS}: '${epath}' has no tool or no reason. An exemption without a reason is a waiver nobody can review" >&2
            exit 1
        }
        EXEMPT_REASON["${epath}|${etool}"]="${ereason}"
        EXEMPT_HITS["${epath}|${etool}"]=0
        EXEMPT_N=$((EXEMPT_N + 1))
    done <"${EXEMPTIONS}"
fi

SCANNED=0
EXAMINED=0
DECLARED_FILES=0
DECLARED_BLOCKS=0
ELIDED=0

for f in "${files[@]}"; do
    [ -f "${f}" ] || continue
    SCANNED=$((SCANNED + 1))

    # One awk pass per file, emitting tab-separated records the shell reads
    # back: `hit`, `stat`, or `err`. The state machine is here rather than in
    # bash because heredoc and declaration state are per line and bash reading
    # a file line by line is an order of magnitude slower over 80 files.
    mapfile -t records < <(awk -v TOOLS="${TOOLS}" '
        function emit(kind, a, b) { print kind "\t" NR "\t" a "\t" b }
        BEGIN { hd=""; code=0; filedecl=0; block=0; examined=0; elided=0; blockline=0 }
        {
            line = $0

            # --- heredoc bodies, skipped whole ---
            if (hd != "") {
                elided++
                if (line ~ ("^[[:space:]]*" hd "[[:space:]]*$")) hd = ""
                next
            }
            # COMMENTS FIRST, and the order is load-bearing. A comment that
            # MENTIONS a heredoc -- `# ... <<EOF ...` -- would otherwise open
            # one here and elide every line until something matched the
            # terminator, which is a file that silently stops being scanned and
            # still reports clean. A real heredoc body is already handled
            # above, so nothing is lost by looking at `#` first.
            if (line ~ /^[[:space:]]*#/) {
                if (line ~ /^[[:space:]]*#[[:space:]]*mica-build-side:/) {
                    if (line ~ /^[[:space:]]*#[[:space:]]*mica-build-side:[[:space:]]*container[[:space:]]*--[[:space:]]*[^[:space:]]/) {
                        if (code) { emit("err", "a whole-file container declaration must come before any code; this one is after line " code, ""); next }
                        filedecl = 1; emit("stat", "filedecl", ""); next
                    }
                    if (line ~ /^[[:space:]]*#[[:space:]]*mica-build-side:[[:space:]]*container-block[[:space:]]*--[[:space:]]*[^[:space:]]/) {
                        if (block) { emit("err", "a container block opened at line " blockline " is still open", ""); next }
                        block = 1; blockline = NR; emit("stat", "blockdecl", ""); next
                    }
                    if (line ~ /^[[:space:]]*#[[:space:]]*mica-build-side:[[:space:]]*host[[:space:]]*$/) {
                        if (!block) { emit("err", "a `mica-build-side: host` closes a container block that was never opened", ""); next }
                        block = 0; next
                    }
                    # A marker with no reason is a rubber stamp; refuse it by
                    # name rather than ignoring it, which would read as "not a
                    # marker" to the tool and as "declared" to its author.
                    emit("err", "malformed `mica-build-side:` marker; the forms are `container -- <why>`, `container-block -- <why>` and `host`", "")
                }
                next
            }

            if (line !~ /<<</ && match(line, /<<-?[[:space:]]*["\047]?[A-Za-z_][A-Za-z0-9_]*["\047]?/)) {
                t = substr(line, RSTART, RLENGTH)
                sub(/^<<-?[[:space:]]*/, "", t)
                gsub(/["\047]/, "", t)
                hd = t
            }

            if (line ~ /^[[:space:]]*$/) next
            if (!code && line !~ /^#!/) code = NR

            if (filedecl || block) { elided++; next }

            # --- what is not a command position ---
            # A `case` label: strip up to the first `)` when nothing before it
            # opens a substitution, so `rauc | updates) ;;` is a pattern and
            # `x509) text=$(openssl ...)` keeps its openssl.
            if (match(line, /^[[:space:]]*[^()$]*\)/)) line = substr(line, RSTART + RLENGTH)
            sub(/^[[:space:]]+/, "", line)
            # An echo/printf ARGUMENT. Prose naming a tool is not a call to it.
            if (line ~ /^(echo|printf)[[:space:]]/) next

            examined++

            # THE SECOND SHAPE. A script that REACHES for a host toolchain is
            # invisible to the table above: `micad:hack/check.sh` runs
            # `cargo`, which the table does catch, but it can only find one
            # because line 8 puts $HOME/.cargo/bin in front of PATH -- and on
            # this host `command -v cargo` answers nothing without it. A
            # toolchain a script goes looking for under $HOME is still a host
            # toolchain, and it is a worse one: nothing pins it and nothing
            # records which it was.
            #
            # Narrow to $HOME and ~, so that the fixture PATHs the test suites
            # build -- `env PATH="${FAKEBIN}:$PATH"` in
            # tests/shadow-reconcile-test.sh, `env -i PATH="$BIN:/usr/bin:/bin"`
            # in tests/health-test.sh -- are not findings. Those point at
            # directories the test just made; these point at a toolchain
            # installed beside the package manager rather than by it.
            if (line ~ /(^|[[:space:]]|;)(export[[:space:]]+)?PATH=.*(\$HOME|\$\{HOME\}|~\/)/) {
                emit("hit", "host-toolchain-on-PATH", $0)
            }

            cmd = code_only(line)
            if (match(cmd, "(^|[;&|(]|&&|\\|\\|)[[:space:]]*(" TOOLS ")([[:space:]]|$)")) {
                m = substr(cmd, RSTART, RLENGTH)
                sub(/^([;&|(]|&&|\|\|)?[[:space:]]*/, "", m)
                sub(/[[:space:]]*$/, "", m)
                emit("hit", m, $0)
            }
        }
        END {
            if (block) emit("err", "a container block opened at line " blockline " is never closed; every line after it was skipped", "")
            emit("stat", "examined", examined)
            emit("stat", "elided", elided)
        }

        # WHAT A QUOTED STRING MAKES LITERAL IS NOT A COMMAND POSITION. This
        # returns the line with those spans blanked to `Q`, so the match above
        # reads only what the shell would run. It exists because
        # `operator_step "install the GOOD bundle (rauc install <bundle>), ..."`
        # -- one English sentence, in tests/cx3576-bench/collect.sh -- was a
        # finding: the `(` read as a command separator. That was carried as a
        # registered false positive, and a false positive spends the credibility
        # this rule needs to be worth having.
        #
        # A COMMAND SUBSTITUTION IS STILL CODE, wherever it sits. `"$(cargo
        # build)"` compiles inside a double-quoted string and stays a finding, so
        # the distinction drawn here is substitution versus literal and NOT
        # quoted versus unquoted: `$( )` and backticks are handed back to the
        # scan untouched, including from inside a double-quoted string, and a
        # `'...'` span is blanked whole because nothing expands in one.
        #
        # A LINE THAT ENDS INSIDE A QUOTE IS RETURNED AS IT CAME. A string
        # opening on one line and closing on another cannot be resolved by a
        # reader that sees one line at a time, and guessing at it would cost
        # findings; the unmasked line is what this lint has always matched, so
        # that case keeps today behaviour rather than acquiring a blind spot.
        function code_only(s,   out, i, n, c, st, top, stack) {
            if (index(s, "\"") == 0 && index(s, "\047") == 0) return s
            n = length(s); out = ""; top = 0
            for (i = 1; i <= n; i++) {
                c = substr(s, i, 1)
                st = (top > 0) ? stack[top] : ""
                if (st == "\047") {
                    out = out "Q"
                    if (c == "\047") top--
                    continue
                }
                if (c == "\\") {
                    out = out ((st == "\"") ? "QQ" : substr(s, i, 2))
                    i++
                    continue
                }
                if (c == "$" && substr(s, i + 1, 1) == "(") {
                    stack[++top] = "("
                    out = out "$("
                    i++
                    continue
                }
                if (c == "`") {
                    if (st == "`") top--; else stack[++top] = "`"
                    out = out "`"
                    continue
                }
                if (st == "(" && c == ")") { top--; out = out ")"; continue }
                if (st == "\"") {
                    out = out "Q"
                    if (c == "\"") top--
                    continue
                }
                if (c == "\"" || c == "\047") { stack[++top] = c; out = out "Q"; continue }
                out = out c
            }
            if (top > 0) return s
            return out
        }
    ' "${f}")

    hits=0
    for rec in ${records[@]+"${records[@]}"}; do
        IFS=$'\t' read -r kind lineno a b <<<"${rec}"
        case "${kind}" in
        err)
            fail "${f}:${lineno}: ${a}"
            hits=$((hits + 1))
            ;;
        stat)
            case "${a}" in
            filedecl) DECLARED_FILES=$((DECLARED_FILES + 1)) ;;
            blockdecl) DECLARED_BLOCKS=$((DECLARED_BLOCKS + 1)) ;;
            examined) EXAMINED=$((EXAMINED + b)) ;;
            elided) ELIDED=$((ELIDED + b)) ;;
            esac
            ;;
        hit)
            key="${f}|${a}"
            if [ -n "${EXEMPT_REASON[${key}]+set}" ]; then
                EXEMPT_HITS["${key}"]=$(( ${EXEMPT_HITS[${key}]} + 1 ))
                continue
            fi
            hits=$((hits + 1))
            if [ "${a}" = 'host-toolchain-on-PATH' ]; then
                fail "${f}:${lineno}: this prepends a directory under \$HOME to PATH, which is how a script reaches a toolchain the machine's package management never installed and nothing pins. See mica:docs/design/build.md section 0. Register it in ${EXEMPTIONS} as '${f}<TAB>host-toolchain-on-PATH<TAB><why>' if it cannot move yet."
                continue
            fi
            fail "${f}:${lineno}: \`${a}\` runs on the host. Producers run in a container pinned in locks/ (bin/bun.sh src/cli.ts from); see mica:docs/design/build.md section 0. If this line runs INSIDE an image, say so with \`# mica-build-side: container-block -- <why>\`; if it cannot move yet, register it in ${EXEMPTIONS} with the reason."
            ;;
        esac
    done
    [ "${hits}" -eq 0 ] && pass "${f}"
done

# --- the second surface: TypeScript -----------------------------------------
#
# The four toolbox seams are closed in code and nothing stops a fifth from being
# written. `src/image` and `src/verify` drive every external tool they need
# through `docker`, and the shape a regression would take is a call site that
# names a producer directly instead: `$`mksquashfs ...`` where `$` is bun's
# shell tag, or `Bun.spawn(['sgdisk', ...])`. Both name the binary in the source,
# which is what makes them findable at all.
#
# THE TABLE IS THE SAME TABLE. A TypeScript-only list of producers would agree
# with the shell one exactly until somebody added a row to one of them.
#
# AND IT IS NOT "no `$`". The tag is used 21 times in this tree and every one of
# them is legitimate -- `git`, `bash`, `cp`, `sh` and `${docker}`. A rule whose
# findings are mostly false positives teaches people to ignore it; this one asks
# only what the FIRST WORD is, so a producer handed to `docker run` as an
# argument -- which is the entire toolbox -- is not a finding.
mapfile -t tsfiles < <(git ls-files '*.ts' | sort -u)
TS_FILES=0
TS_SITES=0
TS_NAMED=0
TS_VARIABLE=0

for f in ${tsfiles[@]+"${tsfiles[@]}"}; do
    [ -f "${f}" ] || continue
    TS_FILES=$((TS_FILES + 1))

    # The whole-file declaration, in the leading comment: `// mica-build-side: container -- <why>`. Before any
    # code, with a reason, or refused by name -- the shell grammar's rules, in the comment syntax the file has.
    tsdeclared=0
    tsdecl="$(awk '
        /^[[:space:]]*$/ { next }
        /^[[:space:]]*\/\// {
            if ($0 ~ /^[[:space:]]*\/\/[[:space:]]*mica-build-side:/) {
                if ($0 !~ /^[[:space:]]*\/\/[[:space:]]*mica-build-side:[[:space:]]*container[[:space:]]*--[[:space:]]*[^[:space:]]/) { print "malformed"; exit }
                if (code) { print "late " code; exit }
                print "declared"; exit
            }
            next
        }
        { if (!code) code = NR }
    ' "${f}")"
    case "${tsdecl}" in
    declared) DECLARED_FILES=$((DECLARED_FILES + 1)); tsdeclared=1 ;;
    malformed) fail "${f}: malformed \`mica-build-side:\` marker; the one TypeScript form is \`// mica-build-side: container -- <why>\`"; SCANNED=$((SCANNED + 1)); continue ;;
    late*) fail "${f}: a whole-file container declaration must come before any code; this one is after line ${tsdecl#late }"; SCANNED=$((SCANNED + 1)); continue ;;
    esac

    # A small scanner rather than a grep, because the distinguishing feature is
    # WHERE a backtick sits. `new RegExp(`^${k}=(.*)$`, 'm')` ends a template
    # with a regex anchor immediately before the closing backtick, and a grep
    # for `$` followed by a backtick calls that a bun shell call: 43 matches in
    # this tree, 21 of them real. Tracking string, template, comment and regex
    # state instead costs 60 lines and gets the number exactly right.
    #
    # A FILE THAT DOES NOT SCAN BACK TO CODE STATE IS A FINDING. That is the
    # control on the scanner itself: an unterminated template or a regex the
    # heuristic below misread would otherwise swallow the rest of the file and
    # report it clean, which is the failure mode the heredoc elision above had.
    mapfile -t records < <(awk '
        BEGIN { RS = "\001" }
        {
            s = $0
            n = length(s)
            st = "code"          # code | lc | bc | sq | dq | tpl | re
            depth = 0            # brace nesting inside a ${ } substitution
            top = 0              # the stack of templates a ${ } interrupted
            prev = ""            # last significant code character, for the / ambiguity
            line = 1
            i = 1
            while (i <= n) {
                c = substr(s, i, 1)
                if (c == "\n") line++

                if (st == "lc") { if (c == "\n") st = "code"; i++; continue }
                if (st == "bc") { if (c == "*" && substr(s, i + 1, 1) == "/") { st = "code"; i += 2; continue } i++; continue }
                if (st == "sq" || st == "dq" || st == "re") {
                    if (c == "\\") { i += 2; continue }
                    if (st == "re" && c == "[") { inclass = 1; i++; continue }
                    if (st == "re" && c == "]") { inclass = 0; i++; continue }
                    if (st == "sq" && c == "\047") { st = "code"; prev = "\047" }
                    else if (st == "dq" && c == "\"") { st = "code"; prev = "\"" }
                    else if (st == "re" && c == "/" && !inclass) { st = "code"; prev = "/" }
                    i++; continue
                }
                if (st == "tpl") {
                    if (c == "\\") { i += 2; continue }
                    # A ${ } is CODE again, and `prev` is reset with it: without
                    # that, `$`cp -a ${`${a}/.`}`` reads the inner template as a
                    # second tagged call, because the tag`s own $ is still the
                    # last code character seen.
                    if (c == "$" && substr(s, i + 1, 1) == "{") { stack[++top] = "tpl"; st = "code"; depth = 0; prev = ""; i += 2; continue }
                    if (c == "`") { st = "code"; prev = "`"; i++; continue }
                    i++; continue
                }

                # --- code ---
                if (c == " " || c == "\t" || c == "\n" || c == "\r") { i++; continue }
                if (c == "/") {
                    d = substr(s, i + 1, 1)
                    if (d == "/") { st = "lc"; i += 2; continue }
                    if (d == "*") { st = "bc"; i += 2; continue }
                    # Regex or division, decided by what came before -- the
                    # standard rule. It matters because a regex may hold `//`,
                    # which read as a comment would elide the rest of the line.
                    if (prev == "" || index("([{,;:=!&|?+-*%~^<>", prev) > 0) { st = "re"; inclass = 0; i++; continue }
                    prev = "/"; i++; continue
                }
                if (c == "\047") { st = "sq"; i++; continue }
                if (c == "\"") { st = "dq"; i++; continue }
                if (c == "{") { if (top > 0) depth++; prev = "{"; i++; continue }
                if (c == "}") {
                    if (top > 0 && depth == 0) { st = stack[top--]; prev = "}"; i++; continue }
                    if (top > 0) depth--
                    prev = "}"; i++; continue
                }
                if (c == "`") {
                    if (prev == "$") emit_tpl(i + 1, line)     # bun`s shell tag
                    st = "tpl"; i++; continue
                }
                if (c == "$") { prev = "$"; i++; continue }

                if (c == "s" || c == "e" || c == "B") {
                    rest = substr(s, i, 40)
                    if (match(rest, /^(Bun\.)?(spawnSync|spawn|execFileSync|execFile)[ \t\n]*\(/)) {
                        # `.spawn` as a method on something else is not one of
                        # these; `Bun.spawn` is, and says so.
                        if (prev != "." || substr(rest, 1, 4) == "Bun.") {
                            emit_spawn(i + RLENGTH, line)
                            i += RLENGTH; prev = "("; continue
                        }
                    }
                }
                prev = c
                i++
            }
            if (st != "code" || top > 0)
                print "err\t" line "\tthis file did not scan back to code state (ended in \047" st "\047), so the scan cannot claim to have read it"
        }

        # The first word of a bun shell template, from just past the backtick.
        function emit_tpl(p, ln,   j, w, c) {
            j = p
            while (j <= n && (substr(s, j, 1) == " " || substr(s, j, 1) == "\t")) j++
            if (substr(s, j, 2) == "${") { print "site\t" ln "\t"; return }
            w = ""
            while (j <= n) {
                c = substr(s, j, 1)
                if (c == " " || c == "\t" || c == "\n" || c == "`" || c == "\\") break
                w = w c
                j++
            }
            print "site\t" ln "\t" w
        }

        # The command an argv-taking launcher names, from just past its paren.
        # Three argument shapes: an array, a bare string, and { cmd: [...] }.
        function emit_spawn(p, ln,   j, c, q, w) {
            j = p
            while (j <= n && (substr(s, j, 1) ~ /[ \t\n\r]/)) j++
            c = substr(s, j, 1)
            if (c == "{") {
                if (!match(substr(s, j, 400), /cmd[ \t\n]*:[ \t\n]*\[/)) { print "site\t" ln "\t"; return }
                j = j + RSTART + RLENGTH - 2
                c = "["
            }
            if (c == "[") {
                j++
                while (j <= n && (substr(s, j, 1) ~ /[ \t\n\r]/)) j++
                c = substr(s, j, 1)
            }
            if (c != "\047" && c != "\"" && c != "`") { print "site\t" ln "\t"; return }
            q = c; j++
            w = ""
            while (j <= n) {
                c = substr(s, j, 1)
                if (c == "\\") { j += 2; continue }
                if (c == q) break
                if (c == "$" && q == "`") { print "site\t" ln "\t"; return }
                w = w c
                j++
            }
            print "site\t" ln "\t" w
        }
    ' "${f}")

    hits=0
    for rec in ${records[@]+"${records[@]}"}; do
        IFS=$'\t' read -r kind lineno a <<<"${rec}"
        case "${kind}" in
        err)
            fail "${f}:${lineno}: ${a}"
            hits=$((hits + 1))
            ;;
        site)
            TS_SITES=$((TS_SITES + 1))
            if [ -z "${a}" ]; then
                TS_VARIABLE=$((TS_VARIABLE + 1))
                continue
            fi
            TS_NAMED=$((TS_NAMED + 1))
            # A declared file launches its producers inside its image; the site is counted, not judged.
            [ "${tsdeclared}" = 0 ] || continue
            # A path is still the binary it ends in.
            tool="${a##*/}"
            [[ "${tool}" =~ ^(${TOOLS})$ ]] || continue
            key="${f}|${tool}"
            if [ -n "${EXEMPT_REASON[${key}]+set}" ]; then
                EXEMPT_HITS["${key}"]=$(( ${EXEMPT_HITS[${key}]} + 1 ))
                continue
            fi
            hits=$((hits + 1))
            fail "${f}:${lineno}: this launches \`${tool}\` on the host. src/image and src/verify reach every producer through a container -- src/image/toolbox.ts and src/verify/tools.ts are the seams -- so a call site that names one directly is a fifth seam nobody declared. See mica:docs/design/build.md section 0."
            ;;
        esac
    done
    [ "${hits}" -eq 0 ] && pass "${f}"
    SCANNED=$((SCANNED + 1))
done

# --- the controls, so this cannot report clean over nothing -----------------

[ "${EXAMINED}" -gt 0 ] || {
    echo "error: ${#files[@]} shell file(s) were opened and not one command line was examined. The elisions above swallowed the whole tree, which is a broken scan and not a clean one" >&2
    exit 1
}

# THE SAME CONTROL FOR THE SECOND SURFACE. This tree's TypeScript launches
# processes -- that is what a build harness written in it does -- so a scan that
# opened .ts files and found no launch site at all has not found a clean tree.
# It has found a scanner whose state machine stopped agreeing with the language,
# and it would report the same green as a tree that launched nothing.
if [ "${TS_FILES}" -gt 0 ] && [ "${TS_SITES}" -eq 0 ]; then
    echo "error: ${TS_FILES} TypeScript file(s) were scanned and not one process launch was found. src/image and src/verify drive docker; a scan that sees none of it is measuring nothing" >&2
    exit 1
fi

# THE POSITIVE CONTROL. This tree assembles images and compiles Rust, so its
# build surfaces necessarily invoke producers; the only question the policy
# asks is on which side. A run that found no container-side declaration at all
# has therefore not found the build -- it has found a pattern that no longer
# matches, or a marker grammar that changed under it, and it would report the
# same green as a tree that genuinely ran everything in containers.
DECLARED=$((DECLARED_FILES + DECLARED_BLOCKS))
[ "${DECLARED}" -gt 0 ] || {
    echo "error: no container-side declaration was found in ${SCANNED} file(s). This repository builds images; a scan that sees no producer running in a container is measuring nothing" >&2
    exit 1
}

# AN EXEMPTION THAT MATCHES NOTHING. Either the path moved and the rule was left
# behind, or the path was fixed and the waiver outlived it. Both read as green
# and neither is.
EXEMPTED=0
if [ "${EXEMPT_N}" -gt 0 ]; then
    for key in "${!EXEMPT_HITS[@]}"; do
        if [ "${EXEMPT_HITS[${key}]}" -eq 0 ]; then
            fail "${EXEMPTIONS}: '${key/|/ }' matches nothing. Either the file moved and this rule was left behind, or the invocation is gone and the waiver outlived it; delete it or point it at what it means."
        fi
        EXEMPTED=$((EXEMPTED + EXEMPT_HITS[${key}]))
    done
fi

# The numbers are the point, and they are separate numbers on purpose: a file
# count alone cannot tell a clean tree from a scan whose pattern stopped
# matching, and a finding count alone cannot tell "nothing wrong" from "nothing
# looked at". Both, plus what was elided and what was declared.
echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/${SCANNED} files clean, ${FAIL_N} finding(s), ${EXAMINED} shell command lines examined, ${ELIDED} elided, ${TS_SITES} TypeScript launch sites examined in ${TS_FILES} file(s) (${TS_NAMED} naming a command, ${TS_VARIABLE} through a variable), ${DECLARED_FILES} file + ${DECLARED_BLOCKS} block container declarations, ${EXEMPTED} exempted invocation(s) under ${EXEMPT_N} rule(s))"
[ "${FAIL_N}" -eq 0 ]
