#!/bin/sh
# PLAN-086 S4: take the static hardware database out of the shipped root.
#
# Called from stages/compose/90-pack.Dockerfile (closed stage), where the
# reasoning lives. Operates on `/` -- the device root itself, as the
# package-manager purge beside it does.
#
# WHAT GOES: /usr/lib/udev/hwdb.bin and /etc/udev/hwdb.bin, the two places the
# compiled database can sit; /usr/lib/udev/hwdb.d and /etc/udev/hwdb.d, the
# source data it is compiled from; /usr/bin/systemd-hwdb and
# systemd-hwdb-update.service, the machinery that would recompile it; and the
# `IMPORT{builtin}="hwdb ..."` clauses in the shipped udev rules, which are the
# only thing that ever reads it. 22.9 MB on cx3576, of which 13.5 MB is the
# compiled database and 9.3 MB the sources it came from.
#
# WHAT STAYS, and this is the harder half: everything else in those rules.
# A rule that queries hwdb almost always does something else in the same rule --
# 50-udev-default.rules sets the tty/input/disk group and mode for the whole
# system on lines that also import from hwdb, 60-serial.rules creates
# /dev/serial/by-id and by-path, 75-net-description.rules ends at
# IMPORT{builtin}="net_id" -- so this removes CLAUSES and not files or lines.
# The survivor table below names, per file, the actions that must still be there
# when it is done, and the run fails if any of them is not.
#
# WHY THE FLAG GOES WITH THE QUERY. 60-evdev.rules sets a private
# ENV{.HAVE_HWDB_PROPERTIES}="1" in the SAME rule as each hwdb import, and later
# gates IMPORT{builtin}="keyboard" on it. Removing the import alone would leave
# the flag set unconditionally and turn a conditional keyboard import into an
# unconditional one -- a behaviour CHANGE made in passing by a removal. The flag
# is hwdb bookkeeping by construction (its value records that a hwdb lookup
# succeeded), so it is part of the clause. The `=="1"` consumer is left alone and
# simply never matches, which is exactly what it does on a root whose hwdb.bin
# is missing.
#
# WHY NOT JUST DELETE hwdb.bin AND LEAVE THE RULES. A missing database makes
# every `IMPORT{builtin}="hwdb ..."` fail at runtime rather than do nothing:
# 33 clauses on cx3576, attempted on every matching uevent, for a database that
# is never coming back. The plan's acceptance is "no active rule or unit still
# requires it", which a root full of failing imports does not satisfy.
#
# NETWORK INTERFACE NAMING IS THE ONE THING THAT COULD MAKE THIS NOT INERT, and
# it is measured rather than reasoned about. hwdb feeds naming through three
# properties -- ID_NET_NAME_FROM_DATABASE (NamePolicy=... database ...),
# ID_NET_NAME_INCLUDE_DOMAIN and ID_NET_AUTO_LINK_LOCAL_ONLY -- and the shipped
# sources set them for a Dell iDRAC virtual NIC, an Azure MANA adapter and four
# USB-to-USB bridges, none of which is on any board here. Every Mica OS board also
# boots with net.ifnames=0 (BOARD_CMDLINE_ARGS in all three board.env files),
# which disables the whole NamePolicy path before hwdb is consulted at all.
# mica:docs/task/RFCT-346.md carries the before/after `udevadm info` from a booted
# guest; this comment is the reason to look, not the evidence.
set -eu

RULE_DIRS="/usr/lib/udev/rules.d /etc/udev/rules.d"
UNIT_DIRS="/usr/lib/systemd/system /etc/systemd/system"

# ---------------------------------------------------------------------------
# 1. The database, its sources, and the tool that rebuilds them.

# MEASURED BEFORE, so the removal cannot be vacuous. A root that never had a
# hwdb.bin would sail through every `rm -f` below and every "it is gone"
# assertion, and report the same success as a root this actually emptied.
bin_before=0
for f in /usr/lib/udev/hwdb.bin /etc/udev/hwdb.bin; do
    [ -f "${f}" ] || continue
    bin_before=$((bin_before + 1))
    bin_bytes=$(wc -c <"${f}")
    echo "hwdb: ${f} is ${bin_bytes} bytes"
done
[ "${bin_before}" -gt 0 ] ||
    { echo "error: neither /usr/lib/udev/hwdb.bin nor /etc/udev/hwdb.bin is in this root, so there is no compiled hardware database to remove. Debian's udev postinst runs \`systemd-hwdb update\` and every image this repository has built carries one; a zero here means this step is reading a root it does not recognise, and every assertion below would pass over an absence" >&2; exit 1; }

src_before=$(find /usr/lib/udev/hwdb.d /etc/udev/hwdb.d -type f -name '*.hwdb' 2>/dev/null | wc -l)
[ "${src_before}" -gt 0 ] ||
    { echo "error: no .hwdb source file is under /usr/lib/udev/hwdb.d or /etc/udev/hwdb.d. The udev package ships 34 of them; none means the source data was already gone and the byte figure this step reports would be a fiction" >&2; exit 1; }

rm -f /usr/lib/udev/hwdb.bin /etc/udev/hwdb.bin
rm -rf /usr/lib/udev/hwdb.d /etc/udev/hwdb.d
rm -f /usr/bin/systemd-hwdb

for p in /usr/lib/udev/hwdb.bin /etc/udev/hwdb.bin /usr/lib/udev/hwdb.d /etc/udev/hwdb.d /usr/bin/systemd-hwdb; do
    [ ! -e "${p}" ] ||
        { echo "error: ${p} is still in the root after the removal" >&2; exit 1; }
done

# The unit that would rebuild it, and its enablement. BOTH, because removing the
# unit file and leaving the wants-symlink is a dangling enablement systemd logs
# once and nobody reads -- and leaving the unit and removing the link is a
# `systemctl preset-all` away from being enabled again.
#
# It is not merely dead weight. Its conditions are
# `ConditionPathExists=|!/usr/lib/udev/hwdb.bin` among others, an OR group that
# this very removal makes TRUE: on a root with no hwdb.bin the unit stops being
# skipped and starts running `systemd-hwdb update` against a read-only /usr on
# every boot. The removal creates the failure; this is the same change.
units_removed=0
for dir in ${UNIT_DIRS}; do
    for p in "${dir}/systemd-hwdb-update.service" "${dir}"/*.target.wants/systemd-hwdb-update.service; do
        { [ -e "${p}" ] || [ -L "${p}" ]; } || continue
        rm -f "${p}"
        units_removed=$((units_removed + 1))
        echo "hwdb: removed ${p}"
    done
done
[ "${units_removed}" -ge 2 ] ||
    { echo "error: ${units_removed} systemd-hwdb-update.service path(s) were removed; the systemd package ships the unit AND enables it into sysinit.target.wants, so a correct root has at least two. Fewer means one of them is spelled somewhere this loop does not look, and the survivor is a unit that runs \`systemd-hwdb update\` against a read-only /usr on every boot" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2. The ordering directive in systemd-udevd.service.
#
# `After=systemd-sysusers.service systemd-hwdb-update.service` names a unit that
# no longer exists. systemd drops such a token silently, so this is not a boot
# failure -- it is the difference between a root where nothing refers to hwdb
# and one where the reference is merely ineffective, and the acceptance clause
# asks for the first. The OTHER name on that line is not touched.
udevd_edited=0
for dir in ${UNIT_DIRS}; do
    p="${dir}/systemd-udevd.service"
    [ -f "${p}" ] || continue
    grep -q 'systemd-hwdb-update\.service' "${p}" || continue
    # `[[:space:]]*` and not `[ \t]*`: inside a bracket expression sed reads
    # `\t` as the two characters backslash and t, so that spelling would also
    # eat a literal `t` in front of the name.
    sed -i 's/[[:space:]]*systemd-hwdb-update\.service//g' "${p}"
    grep -q '^After=.*systemd-sysusers\.service' "${p}" ||
        { echo "error: editing ${p} lost its After=systemd-sysusers.service ordering. That is the unrelated action on the same line and it must survive: without it udevd can start before the accounts its rules assign devices to exist" >&2; exit 1; }
    udevd_edited=$((udevd_edited + 1))
done
[ "${udevd_edited}" -eq 1 ] ||
    { echo "error: ${udevd_edited} copies of systemd-udevd.service name systemd-hwdb-update.service; exactly one is expected. Zero means the ordering moved and this edit is now checking nothing" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 3. The query clauses in the udev rules.
#
# The transform is token-level, not line-level: a logical rule is split on its
# TOP-LEVEL commas (a comma inside a double-quoted value is part of the value),
# the hwdb tokens are dropped, and what is left is written back. A rule left
# with no assignment token at all is dropped whole -- udev logs "takes no
# effect" for those, and a match-only leftover is what removing the private flag
# from 60-evdev.rules produces.
#
# A rule that lost nothing is written back BYTE FOR BYTE, continuations and all.
# Only the rules that actually changed are reflowed, so a diff of the shipped
# rules against the Debian originals is exactly the set of clauses removed.

# Both halves of the clause are counted, because both are removed: the import
# itself and the private flag that records whether it succeeded. Only the
# ASSIGNMENT of that flag (`}="`) counts -- its `}=="` consumer stays, and
# counting it here would make the tally disagree with the rewrite by one per
# consumer and fail the equality below for the wrong reason.
imports_before=$(grep -rho 'IMPORT{builtin}="hwdb[^"]*"' ${RULE_DIRS} 2>/dev/null | wc -l)
flags_before=$(grep -rho 'ENV{\.HAVE_HWDB_PROPERTIES}="' ${RULE_DIRS} 2>/dev/null | wc -l)
clauses_before=$((imports_before + flags_before))
files_before=$(grep -rl 'IMPORT{builtin}="hwdb' ${RULE_DIRS} 2>/dev/null | wc -l)
[ "${imports_before}" -gt 0 ] ||
    { echo "error: no udev rule in ${RULE_DIRS} carries an IMPORT{builtin}=\"hwdb\" clause. systemd 257 ships 33 of them across 13 files; zero means this step would rewrite nothing and then report that nothing queries hwdb -- true of a root with no udev rules at all" >&2; exit 1; }
echo "hwdb: ${imports_before} query clause(s) and ${flags_before} bookkeeping flag(s) in ${files_before} rule file(s) before the rewrite"

# THE PROGRAM IS A SHELL VARIABLE AND NOT A FILE, and the counts come back on
# stderr rather than through one. /tmp is IMAGE CONTENT at this point in the
# chain -- stages/compose/compose-install.sh asserts it empty and says why: the
# first composed root shipped a /tmp/pool.names and the dual-build gate found it
# as an `added` path. A scratch file written HERE lands after that assertion,
# where nothing would catch it. Writing none is stronger than removing them.
HWDB_STRIP_AWK=$(cat <<'AWK'
# One .rules file in, the same file with its hwdb clauses gone out.
#
# `raw` keeps the physical lines of the rule being read so an untouched rule can
# be re-emitted verbatim; `logical` is the same rule joined up, which is what
# gets tokenized.
function flush(  i, n, tok, out, removed, kept, has_assign) {
    if (raw == "") return
    n = split_tokens(logical, tok)
    removed = 0; out = ""; has_assign = 0
    for (i = 1; i <= n; i++) {
        if (tok[i] ~ /^IMPORT\{builtin\}[ \t]*=[ \t]*"hwdb([ \t]|")/ ||
            tok[i] ~ /^ENV\{\.HAVE_HWDB_PROPERTIES\}[ \t]*=[ \t]*"/) { removed++; continue }
        out = (out == "" ? tok[i] : out ", " tok[i])
        # An assignment operator, as opposed to a match: `==` and `!=` test,
        # everything else acts. A rule with no action left is dropped.
        if (tok[i] ~ /[^=!<>+:-]=[^=]/ || tok[i] ~ /(\+=|-=|:=)/) has_assign = 1
    }
    if (removed == 0) { printf "%s", raw }
    else {
        REMOVED += removed
        if (out != "" && has_assign) print out
        else DROPPED++
    }
    raw = ""; logical = ""
}
# Tokenize on commas that are not inside a double-quoted value.
function split_tokens(s, arr,   i, c, q, cur, n) {
    n = 0; cur = ""; q = 0
    for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "\"") q = !q
        if (c == "," && !q) { arr[++n] = trim(cur); cur = ""; continue }
        cur = cur c
    }
    if (trim(cur) != "") arr[++n] = trim(cur)
    return n
}
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
{
    line = $0
    if (raw == "" && (line ~ /^[ \t]*#/ || line ~ /^[ \t]*$/)) { print line; next }
    raw = raw line "\n"
    body = line
    sub(/[ \t]*\\[ \t]*$/, " ", body)
    logical = logical body
    if (line ~ /\\[ \t]*$/) next
    flush()
}
# On stderr, because stdout is the rewritten rule file.
END { flush(); printf "%d %d\n", REMOVED, DROPPED > "/dev/stderr" }
AWK
)

removed_total=0
dropped_total=0
for dir in ${RULE_DIRS}; do
    [ -d "${dir}" ] || continue
    for f in "${dir}"/*.rules; do
        [ -f "${f}" ] || continue
        grep -q 'IMPORT{builtin}="hwdb' "${f}" || continue
        # `2>&1 >file` in THIS order: stderr is redirected to the command
        # substitution first, then stdout to the file. The other order sends
        # both to the file and leaves the counts empty.
        counts="$(awk "${HWDB_STRIP_AWK}" "${f}" 2>&1 >"${f}.hwdbnew")"
        r="${counts%% *}"
        d="${counts##* }"
        [ "${r}" -gt 0 ] ||
            { echo "error: ${f} matched the hwdb grep and the rewrite removed no clause from it. The tokenizer and the grep disagree about what a clause is, and the file would ship unchanged behind a green count" >&2; exit 1; }
        # Same mode and owner as the file it replaces: these are read by udevd
        # and a rules file that arrived 0600 is one udev cannot read.
        cat "${f}.hwdbnew" >"${f}"
        rm -f "${f}.hwdbnew"
        removed_total=$((removed_total + r))
        dropped_total=$((dropped_total + d))
        echo "hwdb: ${f}: ${r} clause(s) removed, ${d} rule(s) left with no action and dropped"
    done
done

[ "${removed_total}" -eq "${clauses_before}" ] ||
    { echo "error: ${clauses_before} hwdb clause(s) were counted before the rewrite and ${removed_total} were removed. The two disagree, so some clause is spelled in a way the tokenizer does not recognise and is still in a shipped rule" >&2; exit 1; }

# BY CLAUSE AND NOT BY THE WORD. Two files mention hwdb in a COMMENT and keep
# doing so -- 71-seat.rules explains why a rule it no longer has existed, and
# 60-autosuspend.rules consumes properties hwdb used to supply and was never
# edited here because it queries nothing. A grep for the word would fail on
# prose and teach the next reader to delete comments to make a check pass.
after_imports=$(grep -rl 'IMPORT{builtin}="hwdb' ${RULE_DIRS} 2>/dev/null | wc -l)
after_flags=$(grep -rl 'ENV{\.HAVE_HWDB_PROPERTIES}="' ${RULE_DIRS} 2>/dev/null | wc -l)
[ "${after_imports}" -eq 0 ] && [ "${after_flags}" -eq 0 ] ||
    { echo "error: ${after_imports} rule file(s) still import from hwdb and ${after_flags} still set ENV{.HAVE_HWDB_PROPERTIES}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 4. The survivors, named one by one.
#
# This is the assertion the plan asks for -- "check that rule edits preserve
# permissions, symlinks, module loading and service activation" -- written as
# the four categories in the four files that carry them. A token-level transform
# that went wrong takes a WHOLE RULE, and every entry below is a rule that
# shares a file, and usually a line, with a clause this step removed.
survivors="
50-udev-default.rules|IMPORT{builtin}=\"usb_id\"
50-udev-default.rules|IMPORT{builtin}=\"path_id\"
50-udev-default.rules|IMPORT{builtin}=\"net_driver\"
50-udev-default.rules|GROUP=\"tty\", MODE=\"0666\"
50-udev-default.rules|GROUP=\"disk\"
50-udev-default.rules|OPTIONS+=\"static_node=
60-input-id.rules|IMPORT{builtin}=\"input_id\"
60-serial.rules|IMPORT{builtin}=\"path_id\"
60-serial.rules|SYMLINK+=\"serial/by-id/
60-serial.rules|SYMLINK+=\"serial/by-path/
71-seat.rules|TAG+=\"master-of-seat\"
75-net-description.rules|IMPORT{builtin}=\"net_id\"
78-sound-card.rules|ENV{SOUND_INITIALIZED}=\"1\"
90-iocost.rules|RUN+=\"iocost apply
"
checked=0
echo "${survivors}" | while IFS='|' read -r file token; do
    [ -n "${file}" ] || continue
    path="/usr/lib/udev/rules.d/${file}"
    [ -f "${path}" ] ||
        { echo "error: ${path} is not in this root, so the action this step promised to preserve cannot be checked. Every file named here had a clause removed from it moments ago" >&2; exit 1; }
    grep -qF "${token}" "${path}" ||
        { echo "error: ${path} no longer contains: ${token}. Removing the hwdb clause took an unrelated action with it -- the very failure PLAN-086 S4 names" >&2; exit 1; }
    checked=$((checked + 1))
done
# The loop above runs in a subshell, so its counter does not survive it; the
# count is taken from the table itself, which is what a zero would mean anyway.
checked=$(echo "${survivors}" | grep -c '|')
[ "${checked}" -ge 14 ] ||
    { echo "error: the survivor table holds ${checked} entries; it is meant to cover permissions, symlinks and service activation across every rule file this step edits. A table that shrank is a check that stopped looking" >&2; exit 1; }

# What must still be there whatever happened above: device rules, the module
# indexes, and udevd itself. The plan keeps all three by name.
[ -x /usr/lib/systemd/systemd-udevd ] || [ -x /usr/bin/udevadm ] ||
    { echo "error: neither systemd-udevd nor udevadm is in this root; device management is what the hwdb removal was supposed to keep" >&2; exit 1; }
rules_after=$(find ${RULE_DIRS} -type f -name '*.rules' 2>/dev/null | wc -l)
[ "${rules_after}" -ge 30 ] ||
    { echo "error: ${rules_after} udev rule file(s) survive; this root shipped 41 and this step removes clauses, never files" >&2; exit 1; }
# Module indexes belong to the separately verified support image. Its producer
# checks them before signing; this user-space transform never owns that tree.

echo "hwdb: removed the compiled database, ${src_before} source file(s), the update unit, ${imports_before} query clause(s) and ${flags_before} bookkeeping flag(s); ${rules_after} rule file(s) survive, ${dropped_total} rule(s) left with no action were dropped, ${checked} preserved action(s) checked"
