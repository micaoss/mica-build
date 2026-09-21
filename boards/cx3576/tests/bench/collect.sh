#!/usr/bin/env bash
# cx3576 bench qualification collector.
#
#   bash /root/cx3576-bench-collect.sh <stage> [options]
#   bash /root/cx3576-bench-collect.sh report
#
# The procedure this implements is docs/boards/cx3576-bench.md. It runs ON THE
# DEVICE, over the serial console, one stage at a time, and its output is a
# markdown report with docs/boards/cx3576.md's legacy Qualification
# results rows plus the live matrix's 39 current details.
#
# IT NEEDS NOTHING FROM THE REPOSITORY. It is copied to the device and run
# there. Everything it needs is in this file or on the image.
#
# WHAT IS ON THE IMAGE, measured on a shipped root: bash, sh, curl, networkctl,
# journalctl, systemctl, mica-deploy, podman, udevadm, dmesg, lsblk, date, stat, awk,
# sed, grep. ABSENT: jq, python3, wget, perl -- and there is no package
# manager, which is a property under test rather than an obstacle. BusyBox
# ships with no applet links by design. So: no `jq`, nothing is installed, and
# every probe outside the list above is guarded by `command -v` and RECORDS ITS
# ABSENCE rather than skipping.
#
# ---------------------------------------------------------------------------
# IT MUST NOT REPORT A PASS IT DID NOT OBSERVE. This is the whole design
# constraint and it shapes three things:
#
#   1. `record` accepts exactly pass | fail | N/A | not tested, and pass/fail
#      carry an ISO date -- the same grammar tools/docs/verify-board.sh enforces
#      on the dossier. There is no code path that writes `pass` from anything
#      but a probe that returned green or an operator who said so.
#   2. Human steps PROMPT, WAIT and RECORD WHAT THE OPERATOR SAW. With no
#      terminal on stdin they record `not tested -- no operator present`. An
#      unattended run that silently skipped them would produce a report that
#      looks complete, which is the failure mode this file exists to prevent.
#   3. A row that was not reached at all is `not tested` NAMING THE STAGE that
#      produces it. Off-hardware gates that back a row are noted as evidence
#      about their own surface, never as a hardware pass.
#
# ---------------------------------------------------------------------------
# NO `set -e`, DELIBERATELY. This is a collector: probes are EXPECTED to fail
# -- an absent tool, an unbound driver, a file the kernel did not create -- and
# each of those failures is a result to be recorded. Under `set -e` the first
# one would abort the run, losing every row after it and producing a partial
# report with no explanation. Exit status is captured explicitly at each call
# site instead. `set -u` and `set -o pipefail` stay: an unset variable here is
# a typo in a probe name, and a pipeline whose producer died is not a reading.
set -u
set -o pipefail

COLLECTOR_VERSION=3

# --- the dossier's rows, in the dossier's order -----------------------------
# key|label. The label is what docs/boards/cx3576.md's table says, spelled
# exactly, because `report` writes it back into that table.
ROWS=(
    "cold-boot|Cold boot"
    "warm-boot|Warm boot"
    "ab-update|A/B switch and update"
    "power-cut|Power-cut during update"
    "storage|Storage growth/health"
    "network|Network/radio"
    "fieldbus|USB/fieldbus (CAN, OTG/gadget)"
    "rtc|RTC"
    "thermal|Thermal/throttling"
    "watchdog|Watchdog/reset cause"
    "offline|Offline service"
    "recovery|Recovery"
    "install|Installation and first boot"
)

# key|stage that produces it. A row nothing recorded says which stage was not
# run, so "not tested" points at the next action instead of at a shrug.
ROW_STAGE=(
    "cold-boot|firstboot"
    "warm-boot|warmboot"
    "ab-update|update"
    "power-cut|powercut"
    "storage|firstboot + storagefill"
    "network|network"
    "fieldbus|fieldbus"
    "rtc|warmboot"
    "thermal|thermal"
    "watchdog|watchdog"
    "offline|firstboot"
    "recovery|recovery"
    "install|install"
)

# The current contract's logical acceptance rows. These are deliberately
# separate from the thirteen legacy dossier rows above: one aggregate pass
# must never hide an unobserved mandatory behavior.
# id|class|stage|short requirement
DETAIL_ROWS=(
    "I1|mandatory|install|exact clean source, image, target and readback binding"
    "B1|mandatory|install|blank-unit install and claimable first boot"
    "B2|mandatory|firstboot|five cold boots with 180-second required-health windows"
    "B3|mandatory|warmboot|three authenticated reboots with teardown and health"
    "B4|mandatory|warmboot|authenticated power-off and later healthy power-on"
    "W1|mandatory|watchdog|U-Boot to Linux to PID 1 watchdog handoff"
    "W2|mandatory|watchdog|watchdog expiry, spent attempt and readable reset cause"
    "R1|mandatory|recovery|authenticated recovery operations and declared survivors"
    "R2|mandatory|recovery|invalid-record RockUSB recovery and maskrom reflash"
    "U1|mandatory|update|root-only signed update"
    "U2|mandatory|update|kernel/support-only signed update"
    "U3|mandatory|update|combined signed update"
    "U4|mandatory|update|three failed trials and retained-deployment fallback"
    "U5|mandatory|update|DATA-only acquisition and atomic publication"
    "U6|mandatory|update|separately signed firmware update and exact readback"
    "P1|mandatory|powercut|cut during download or offline import"
    "P2|mandatory|powercut|cut during object write and file sync"
    "P3|mandatory|powercut|cut during directory publication"
    "P4|mandatory|powercut|cut during candidate activation"
    "P5|mandatory|powercut|cut during trial-attempt decrement"
    "P6|mandatory|powercut|cut during health confirmation"
    "P7|mandatory|powercut|cut during garbage collection or record repair"
    "S1|mandatory|firstboot|fixed FIRMWARE, 1 GiB SYSTEM and DATA-only growth"
    "S2|mandatory|storagefill|current namespace quotas and container isolation"
    "D1|mandatory|display|centered product presentation on connected HDMI"
    "D2|mandatory|display|authenticated tty2 with no autologin"
    "D3|mandatory|display|product presentation restored after tty2"
    "D4|mandatory|display|late HDMI attach restores product presentation"
    "D5|optional|display|historical PLAN-088 panic-screen observation (old D4)"
    "A1|mandatory|accelerators|checked repeated NPU inference"
    "A2|mandatory|accelerators|checked repeated hardware encode"
    "A3|mandatory|accelerators|checked repeated hardware decode"
    "N1|mandatory|network|both Ethernet ports obtain and carry traffic"
    "N2|mandatory|network|AIC8800D80 Wi-Fi and regulatory operation"
    "N3|mandatory|network|Bluetooth peer and profile exchange"
    "F1|mandatory|fieldbus|USB host, OTG gadget and CAN exchange"
    "F2|mandatory|warmboot|RTC identity and power-loss behavior"
    "F3|mandatory|thermal|sustained thermal load and cooldown"
    "F4|mandatory|firstboot|offline local management and provisioning"
)

# --- the stages, in order, with what each assumes ---------------------------
# name|assumes|one-line description. `assumes` is the stage that must be `done`
# before this one runs; empty for the first. A stage whose assumption is unmet
# is REFUSED, not run: tests/apid-api does the same thing for the
# same reason -- a stage-8 failure must never be read as a stage-9 bug.
STAGES=(
    "install||the flash and the profile it wrote"
    "firstboot|install|first boot: cold cycle, DATA growth, offline service"
    "inventory|firstboot|the four Gate D measurements, read-only"
    "warmboot|inventory|warm reboot cycles and the RTC across a power-off"
    "network|warmboot|Ethernet on both ports and the radio"
    "fieldbus|network|CAN, USB host and the OTG gadget console"
    "thermal|fieldbus|sustained load inside the thermal envelope"
    "watchdog|thermal|a deliberate hang, the reset, and the reset cause"
    "update|watchdog|signed deployment install, confirmation, and failed-trial fallback"
    "powercut|update|power removed inside the named window"
    "storagefill|powercut|bulk and disposable DATA quota containment"
    "display|storagefill|HDMI presentation, tty2 and late attach"
    "accelerators|display|NPU, hardware encoder and hardware decoder workloads"
    "recovery|accelerators|every recovery path, in the destructive order"
)

COLD_CYCLES=5      # docs/boards/cx3576-bench.md stage 1
WARM_CYCLES=3      # stage 3
THERMAL_SECONDS=1800
THERMAL_SAMPLE=10
STABILITY_SECONDS=180

# --- options ----------------------------------------------------------------
OUT=""
STAGE=""
TOKEN="${MICA_BENCH_TOKEN:-}"
DRY_RUN=0
DATE_OVERRIDE=""
API_BASE=""
IDENTITY_FILE=""
SOURCE_COMMIT=""
SOURCE_TREE=""
IMAGE_NAME=""
IMAGE_SHA256=""
VERIFICATION_RECORD=""
PROFILE=""
BOARD_REVISION=""
RADIO_SKU=""
SYSTEM_BLOCK=""
SYSTEM_SYS=""

usage() {
    cat <<USAGE
cx3576 bench qualification collector (v${COLLECTOR_VERSION})

  bash $0 <stage> [options]
  bash $0 report [options]
  bash $0 stages

stages, in order:
USAGE
    local entry name assumes desc
    for entry in "${STAGES[@]}"; do
        IFS='|' read -r name assumes desc <<<"$entry"
        printf '  %-12s %s\n' "$name" "$desc"
        [ -n "$assumes" ] && printf '  %-12s   assumes: %s\n' "" "$assumes"
    done
    cat <<USAGE

options:
  --out DIR       run directory (default: the first writable of /srv/bench,
                  /tmp/mica-bench)
  --token TOK     apid bearer token; or set MICA_BENCH_TOKEN
  --api URL       confirmed apid base URL; never inferred by this collector
  --identity FILE public exact-image/target binding (required for a bench stage)
  --date YYYY-MM-DD  the date written into pass/fail rows, when the device's
                  own clock is not to be trusted (see the RTC row)
  --dry-run       run every read-only probe; refuse every mutation, reboot,
                  install and power-cut prompt. This is how the script is
                  exercised somewhere other than the bench.
  -h, --help      this
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --out|--token|--identity|--date|--api)
            [ $# -ge 2 ] && [ -n "$2" ] || { echo "missing value for $1" >&2; exit 2; } ;;
    esac
    case "$1" in
        --out)     OUT=${2:-}; shift 2 ;;
        --token)   TOKEN=${2:-}; shift 2 ;;
        --identity) IDENTITY_FILE=${2:-}; shift 2 ;;
        --date)    DATE_OVERRIDE=${2:-}; shift 2 ;;
        --api)     API_BASE=${2:-}; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        -*)        echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
        *)         if [ -n "$STAGE" ]; then echo "one stage at a time: already have '$STAGE'" >&2; exit 2; fi
                   STAGE=$1; shift ;;
    esac
done

[ -n "$STAGE" ] || { usage >&2; exit 2; }

if [ "$STAGE" = stages ]; then usage; exit 0; fi

# --- the run directory ------------------------------------------------------
#
# WHERE IT LANDS IS LOAD-BEARING. This run spans reboots and deliberate power
# cuts, so a result recorded on a tmpfs or on EPHEMERAL is a result that does
# not survive the thing it is measuring. /srv is the user-owned namespace bound
# out of DATA -- persistent, and not the namespace micad writes. Each fallback
# is announced, because a silent demotion to /tmp turns the power-cut row into
# a row with no evidence.
pick_out() {
    local candidate
    # ONLY ON A MICA OS DEVICE. Auto-picking would otherwise create /srv/bench on
    # whatever machine somebody tried `--dry-run` on, and on a development host
    # /srv is not a device's DATA namespace but a shared root. Off-device runs
    # must name their own directory.
    if [ ! -r /usr/share/mica/release-identity.env ]; then
        echo "This is not a Mica OS device: /usr/share/mica/release-identity.env is absent." >&2
        echo "Pass --out DIR explicitly; the collector will not guess a directory here." >&2
        return 1
    fi
    for candidate in /srv/bench /tmp/mica-bench; do
        if mkdir -p "$candidate" 2>/dev/null && [ -w "$candidate" ]; then
            case "$candidate" in
                /srv/bench) ;;
                /tmp/mica-bench)
                    echo "WARNING: falling back to $candidate, which is a TMPFS. This run does NOT" >&2
                    echo "         survive a reboot, and the power-cut stage cannot be recorded here." >&2 ;;
            esac
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

if [ -z "$OUT" ]; then
    OUT=$(pick_out) || { echo "FATAL: no writable run directory found" >&2; exit 1; }
else
    mkdir -p "$OUT" 2>/dev/null || { echo "FATAL: cannot create --out $OUT" >&2; exit 1; }
fi

identity_value() {
    local key=$1 count value
    count=$(grep -c "^${key}=" "$IDENTITY_FILE" 2>/dev/null || true)
    [ "$count" -eq 1 ] || die "identity must contain exactly one ${key}= entry"
    value=$(sed -n "s/^${key}=//p" "$IDENTITY_FILE")
    [ -n "$value" ] || die "identity value $key is empty"
    printf '%s' "$value"
}

load_identity() {
    [ -n "$IDENTITY_FILE" ] || die "a bench stage requires --identity FILE; no image, endpoint or block device is inferred"
    [ -r "$IDENTITY_FILE" ] || die "identity file is not readable: $IDENTITY_FILE"
    SOURCE_COMMIT=$(identity_value SOURCE_COMMIT) || exit 1
    SOURCE_TREE=$(identity_value SOURCE_TREE) || exit 1
    IMAGE_NAME=$(identity_value IMAGE_NAME) || exit 1
    IMAGE_SHA256=$(identity_value IMAGE_SHA256) || exit 1
    VERIFICATION_RECORD=$(identity_value VERIFICATION_RECORD) || exit 1
    PROFILE=$(identity_value PROFILE) || exit 1
    BOARD_REVISION=$(identity_value BOARD_REVISION) || exit 1
    RADIO_SKU=$(identity_value RADIO_SKU) || exit 1
    SYSTEM_BLOCK=$(identity_value SYSTEM_BLOCK) || exit 1
    printf '%s\n' "$SOURCE_COMMIT" | grep -Ex '[0-9a-f]{40}' >/dev/null || die "SOURCE_COMMIT must be 40 lowercase hexadecimal characters"
    printf '%s\n' "$SOURCE_TREE" | grep -Ex '[0-9a-f]{40}' >/dev/null || die "SOURCE_TREE must be 40 lowercase hexadecimal characters"
    printf '%s\n' "$IMAGE_SHA256" | grep -Ex '[0-9a-f]{64}' >/dev/null || die "IMAGE_SHA256 must be 64 lowercase hexadecimal characters"
    printf '%s\n' "$SYSTEM_BLOCK" | grep -Ex '/dev/[A-Za-z0-9._-]+' >/dev/null || die "SYSTEM_BLOCK must name one explicit /dev node"
    case "$PROFILE" in dev|prod) ;; *) die "PROFILE must be dev or prod" ;; esac
    [ "$BOARD_REVISION" = CX3576-Z ] || die "BOARD_REVISION must be CX3576-Z"
    [ "$RADIO_SKU" = AIC8800D80 ] || die "RADIO_SKU must be AIC8800D80"
    if [ -n "$API_BASE" ]; then
        case "$API_BASE" in http://*|https://*) ;; *) die "--api requires an explicit HTTP(S) base URL" ;; esac
        case "$API_BASE" in *'@'*|*'?'*|*'#'*|*[[:space:]]*) die "--api must not contain credentials, query, fragment or whitespace" ;; esac
        API_BASE=${API_BASE%/}
    fi
    SYSTEM_SYS="/sys/class/block/${SYSTEM_BLOCK##*/}"
}

canonical_identity() {
    printf '%s\n' \
        "SOURCE_COMMIT=$SOURCE_COMMIT" \
        "SOURCE_TREE=$SOURCE_TREE" \
        "IMAGE_NAME=$IMAGE_NAME" \
        "IMAGE_SHA256=$IMAGE_SHA256" \
        "VERIFICATION_RECORD=$VERIFICATION_RECORD" \
        "PROFILE=$PROFILE" \
        "BOARD_REVISION=$BOARD_REVISION" \
        "RADIO_SKU=$RADIO_SKU" \
        "SYSTEM_BLOCK=$SYSTEM_BLOCK" \
        "API_BASE=$API_BASE" \
        "DRY_RUN=$DRY_RUN"
}

bind_run() {
    local bound="$OUT/exact-image.env" requested existing
    requested=$(canonical_identity)
    if [ -s "$bound" ]; then
        existing=$(cat "$bound")
        [ "$existing" = "$requested" ] || die "this run is already bound to a different exact image or target: $bound"
        return 0
    fi
    canonical_identity >"$bound"
    flush
}

RESULTS="$OUT/results.tsv"
DETAILS="$OUT/details.tsv"
MEASUREMENTS="$OUT/measurements.tsv"
STATE="$OUT/stage.state"
LOG="$OUT/log.txt"
EV="$OUT/evidence/$STAGE"
mkdir -p "$EV"
: >>"$RESULTS"; : >>"$DETAILS"; : >>"$MEASUREMENTS"; : >>"$STATE"; : >>"$LOG"

# --- primitives -------------------------------------------------------------

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
warn() { printf 'WARNING: %s\n' "$*" | tee -a "$LOG" >&2; }
die()  { printf 'REFUSED: %s\n' "$*" | tee -a "$LOG" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# The target of a sysfs symlink, or a WORD SAYING THERE IS NONE.
#
# `basename "$(readlink -f X)"` is the obvious spelling and it is wrong twice:
# `readlink -f` on a missing path prints nothing and `basename ""` prints
# nothing and exits 0, so a `|| echo unknown` fallback never fires and the
# field comes back EMPTY; and on a path that exists but is not a link,
# `readlink -f` returns the path itself, so an absent `of_node` is reported as
# a resolved device-tree node. Both were caught by running this script on a
# machine with neither -- an empty driver field and thirty-two ttyS ports each
# claiming an of_node that does not exist.
linktarget() {
    local p=$1 t
    [ -L "$p" ] || { printf 'none'; return 1; }
    t=$(readlink -f "$p" 2>/dev/null) || { printf 'unresolvable'; return 1; }
    [ -n "$t" ] || { printf 'unresolvable'; return 1; }
    printf '%s' "$t"
}
linkname() {
    local t
    t=$(linktarget "$1") || { printf '%s' "$t"; return 1; }
    printf '%s' "${t##*/}"
}

# `sync` after every append. The run survives a power cut only if its bytes are
# on the medium when the power goes, and this script's whole subject is power
# going away at inconvenient moments.
flush() { sync 2>/dev/null || true; }

# `grep -c` PRINTS the count and EXITS 1 when the count is zero, so the obvious
# `n=$(grep -c . f || echo 0)` yields the two-line string "0\n0" on an empty
# file and every arithmetic test downstream of it then fails with a syntax
# error. Counting goes through here instead.
count_lines() {
    local n
    n=$(grep -c . "$1" 2>/dev/null || true)
    printf '%s' "${n:-0}"
}

# The date written into a pass/fail row. --date wins, because the RTC row's
# whole point is that the device's own clock may be wrong; when the device's
# clock is used and is not synchronized, the row says so rather than carrying a
# plausible-looking wrong date silently.
iso_date() {
    if [ -n "$DATE_OVERRIDE" ]; then printf '%s' "$DATE_OVERRIDE"; return; fi
    date -u +%F
}
clock_caveat() {
    [ -n "$DATE_OVERRIDE" ] && return 0
    have timedatectl || return 0
    local sync
    sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
    [ "$sync" = yes ] && return 0
    printf ' (device clock unsynchronized at capture)'
}

# cap NAME -- CMD ... : run a probe, keep everything it said, return its status.
#
# The capture file carries the command line and the exit status ABOVE the
# output, so a reader of the run directory can tell "the tool answered nothing"
# from "the tool was not there" from "the tool failed" -- three different
# findings that an output-only capture renders identically.
cap() {
    local name=$1; shift
    [ "${1:-}" = "--" ] && shift
    local file="$EV/$name.txt" rc=0
    {
        printf '# command : %s\n' "$*"
        printf '# stage   : %s\n' "$STAGE"
        printf '# at      : %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo unknown)"
    } >"$file"
    if ! have "$1"; then
        printf '# status  : TOOL-ABSENT\n' >>"$file"
        say "  probe $name: '$1' is not on this image"
        return 127
    fi
    "$@" >"$file.body" 2>&1
    rc=$?
    printf '# status  : %s\n\n' "$rc" >>"$file"
    cat "$file.body" >>"$file" 2>/dev/null
    rm -f "$file.body"
    flush
    return "$rc"
}

# capf NAME FILE... : the same, for files rather than commands.
capf() {
    local name=$1; shift
    local file="$EV/$name.txt" f found=0
    { printf '# files   : %s\n' "$*"; printf '# stage   : %s\n\n' "$STAGE"; } >"$file"
    for f in "$@"; do
        if [ -e "$f" ]; then
            found=1
            printf '===== %s =====\n' "$f" >>"$file"
            cat "$f" >>"$file" 2>&1
            printf '\n' >>"$file"
        else
            printf '===== %s ===== ABSENT\n\n' "$f" >>"$file"
        fi
    done
    flush
    [ "$found" -eq 1 ]
}

# --- the row grammar, enforced here so the dossier never has to --------------

# The evidence cell is ONE TABLE CELL. A newline inside it breaks the row for
# every reader, and a bare `|` splits it -- including for
# tools/docs/verify-board.sh's own `awk -F'|'` parser, which would then read the
# result out of the wrong column and report a grammar violation nobody wrote.
# Both are flattened here, once, rather than at each of the forty call sites.
one_cell() { printf '%s' "$*" | tr '\n|\t' '   ' | sed 's/  */ /g; s/^ //; s/ $//'; }

record() {
    local key=$1 result=$2 evidence date
    evidence=$(one_cell "$3")
    # A DRY RUN CANNOT PRODUCE A HARDWARE VERDICT. --dry-run exists so the
    # script can be exercised somewhere other than the bench, and "somewhere
    # other than the bench" is exactly where a probe's answer says nothing
    # about the board: no /dev/watchdog in a container is a fact about the
    # container. Downgrading here rather than at each call site makes it a
    # property of the mode instead of a habit thirty call sites have to keep.
    case "$result" in
        pass|fail)
            if [ "$DRY_RUN" -eq 1 ]; then
                evidence="--dry-run, so this is not a bench observation; the probe would have said '$result': $evidence"
                result="not tested"
            fi ;;
    esac
    case "$result" in
        pass|fail)     date=$(iso_date); evidence="$evidence$(clock_caveat)" ;;
        N/A)           date="—" ;;
        "not tested")  date="—" ;;
        *) die "internal defect: result '$result' for row '$key' is outside the grammar (pass / fail / N/A / not tested)" ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$(date -u +%s 2>/dev/null || echo 0)" "$STAGE" "$key" "$result" "$date" "$evidence" >>"$RESULTS"
    flush
    say "  ROW $key = $result  [$evidence]"
}

detail_record() {
    local key=$1 result=$2 evidence date
    evidence=$(one_cell "$3")
    case "$result" in
        pass|fail)
            if [ "$DRY_RUN" -eq 1 ]; then
                evidence="--dry-run, so this is not a bench observation; the probe would have said '$result': $evidence"
                result="not tested"
            fi ;;
    esac
    case "$result" in
        pass|fail) date=$(iso_date); evidence="$evidence$(clock_caveat)" ;;
        N/A|"not tested") date="—" ;;
        *) die "internal defect: result '$result' for detail '$key' is outside the grammar" ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$(date -u +%s 2>/dev/null || echo 0)" "$STAGE" "$key" "$result" "$date" "$evidence" >>"$DETAILS"
    flush
    say "  DETAIL $key = $result  [$evidence]"
}

# A Gate D measurement. NOT a dossier row: PLAN-037 names four measurements by
# hand and they go in their own block, so the dossier's table stays thirteen
# rows long.
measure() {
    local id=$1 finding
    finding=$(one_cell "$2")
    printf '%s\t%s\t%s\t%s\n' "$(date -u +%s 2>/dev/null || echo 0)" "$STAGE" "$id" "$finding" >>"$MEASUREMENTS"
    flush
    say "  $id: $finding"
}

# --- the operator -----------------------------------------------------------
#
# There is no unattended mode for these. A run with no terminal records `not
# tested -- no operator present`, which is the honest answer; inventing a pass
# from an empty read is the one thing this file may not do.
interactive() { [ -t 0 ]; }

# Gate for a stage whose ACTIONS need a person -- arming the watchdog, staging
# a power cut. Returns 1 (and records why) when there is nobody to act, so an
# unattended invocation cannot reset the board or leave a cut half-staged.
require_operator() {
    local key=$1 what=$2
    if [ "$DRY_RUN" -eq 1 ]; then
        record "$key" "not tested" "--dry-run: $what was not performed"
        return 1
    fi
    if ! interactive; then
        record "$key" "not tested" "no operator present (stdin is not a terminal); $what needs someone at the board and was not performed"
        return 1
    fi
    return 0
}

ask() {
    local prompt=$1 answer=""
    if ! interactive; then printf ''; return 1; fi
    printf '\n  ? %s\n  > ' "$prompt" >&2
    IFS= read -r answer || return 1
    printf '%s' "$answer"
}

# operator_step KEY "what to do" "what a pass looks like"
# Prints the instruction, waits for the operator to do it, then takes a verdict
# and a free-text observation. The observation is recorded whichever way the
# verdict went: "it passed, but the LED stayed red" is the sentence a bench
# session exists to produce.
operator_step() {
    local key=$1 todo=$2 criterion=$3 verdict note

    if [ "$DRY_RUN" -eq 1 ]; then
        record "$key" "not tested" "--dry-run: the operator step was not offered ($todo)"
        return 0
    fi
    if ! interactive; then
        record "$key" "not tested" "no operator present (stdin is not a terminal); the step was not run: $todo"
        return 0
    fi

    say ""
    say "  OPERATOR STEP for row '$key'"
    say "    do   : $todo"
    say "    pass : $criterion"
    ask "press Enter when done" >/dev/null

    while :; do
        verdict=$(ask "verdict? pass / fail / skip") || verdict=""
        case "$verdict" in
            pass|fail) break ;;
            skip|"")   verdict=skip; break ;;
            *)         say "    answer 'pass', 'fail' or 'skip'." ;;
        esac
    done
    note=$(ask "what did you see? (one line, recorded verbatim)") || note=""
    [ -n "$note" ] || note="(operator left the observation blank)"

    case "$verdict" in
        pass) record "$key" pass  "operator: $note" ;;
        fail) record "$key" fail  "operator: $note" ;;
        skip) record "$key" "not tested" "operator skipped: $note" ;;
    esac
}

operator_detail() {
    local key=$1 todo=$2 criterion=$3 verdict note
    if [ "$DRY_RUN" -eq 1 ]; then
        detail_record "$key" "not tested" "--dry-run: the operator step was not offered ($todo)"
        return 0
    fi
    if ! interactive; then
        detail_record "$key" "not tested" "no operator present (stdin is not a terminal); the step was not run: $todo"
        return 0
    fi
    say ""
    say "  OPERATOR STEP for detail '$key'"
    say "    do   : $todo"
    say "    pass : $criterion"
    ask "press Enter when done" >/dev/null
    while :; do
        verdict=$(ask "verdict? pass / fail / skip") || verdict=""
        case "$verdict" in
            pass|fail) break ;;
            skip|"") verdict=skip; break ;;
            *) say "    answer 'pass', 'fail' or 'skip'." ;;
        esac
    done
    note=$(ask "what did you see? (one line, recorded verbatim)") || note=""
    [ -n "$note" ] || note="(operator left the observation blank)"
    case "$verdict" in
        pass) detail_record "$key" pass "operator: $note" ;;
        fail) detail_record "$key" fail "operator: $note" ;;
        skip) detail_record "$key" "not tested" "operator skipped: $note" ;;
    esac
}

# operator_note ID "question" -- a measurement a person answers, not a row.
operator_note() {
    local id=$1 question=$2 answer
    if [ "$DRY_RUN" -eq 1 ] || ! interactive; then
        measure "$id" "not collected: no operator (question was: $question)"
        return 0
    fi
    answer=$(ask "$question") || answer=""
    [ -n "$answer" ] || answer="(blank)"
    measure "$id" "operator: $answer"
}

# --- stage bookkeeping ------------------------------------------------------
stage_is_done() { grep -c "^$1\$" "$STATE" >/dev/null 2>&1; }
mark_stage_done() { printf '%s\n' "$1" >>"$STATE"; flush; }

stage_assumes() {
    local entry name assumes desc
    for entry in "${STAGES[@]}"; do
        IFS='|' read -r name assumes desc <<<"$entry"
        if [ "$name" = "$1" ]; then printf '%s' "$assumes"; return 0; fi
    done
    return 1
}

require_assumption() {
    local assumes
    assumes=$(stage_assumes "$STAGE") || die "'$STAGE' is not a stage. Run '$0 stages'."
    [ -n "$assumes" ] || return 0
    if stage_is_done "$assumes"; then return 0; fi
    die "stage '$STAGE' assumes '$assumes', and '$assumes' is not recorded as done in $STATE.
         Run it first, or -- if it genuinely ran on another boot of this unit --
         append its name to that file by hand and say so in the run notes.
         A stage run on an unmet assumption measures something other than its row."
}

# --- shared probes ----------------------------------------------------------

# Read the authenticated identity through the same command as mica-health.
booted_deployment() {
    local out
    have mica-deploy || return 127
    out=$(mica-deploy booted 2>/dev/null) || return 1
    printf '%s\n' "$out" | grep -cx '[0-9a-f]\{64\}' >/dev/null || return 2
    printf '%s' "$out"
}

# health_verdict : echo a one-line summary, return 0 when green.
#
# "Green" is what the dossier's rows mean by a healthy system: every named
# required-health member is green, mica-deploy names an authenticated
# deployment, and mica-health.service completed. Optional failed units are
# retained as evidence but do not redefine the required set. It
# deliberately does NOT wait on `is-system-running` reporting `running` --
# mica-health.service is a job in the initial transaction, so that state depends
# on its own completion. Here the confirmation is already expected to have
# completed, and both services must still answer their read-only probes.
health_verdict() {
    local failed="none" health="" member sysstate="unknown" slot="" mh="unknown" rc=0
    if have systemctl; then
        sysstate=$(systemctl is-system-running 2>/dev/null || true)
        failed=$(systemctl list-units --failed --no-legend --plain 2>/dev/null | tr '\n' ';' | sed 's/;*$//')
        [ -n "$failed" ] || failed="none"
        mh=$(systemctl show -p Result --value mica-health.service 2>/dev/null || echo unknown)
    else
        sysstate="systemctl absent"; rc=1
    fi
    if have journalctl; then
        health=$(journalctl -b -u mica-health.service --no-pager 2>/dev/null || true)
        printf '%s\n' "$health" | grep -F "required set: boot-settled micad apid" >/dev/null || rc=1
        for member in boot-settled micad apid; do
            printf '%s\n' "$health" | grep -F "required member $member: OK" >/dev/null || rc=1
        done
    else
        rc=1
    fi
    slot=$(booted_deployment) || true
    [ -n "$slot" ] || rc=1
    [ "$mh" = success ] || rc=1
    case "$sysstate" in running|degraded) ;; *) rc=1 ;; esac
    if ! have timeout || ! have busctl || ! have curl || [ -z "$API_BASE" ]; then
        printf 'live required-health probes unavailable: need timeout, busctl, curl and confirmed --api'
        return 2
    fi
    timeout 10 busctl --system call com.mica.micad /com/mica/micad \
        com.mica.micad1 GetState s '' >/dev/null 2>&1 || rc=1
    curl --fail --silent --show-error --insecure --max-time 10 \
        "$API_BASE/healthz" >/dev/null 2>&1 || rc=1
    printf 'systemd=%s optional-failed-units=%s required={boot-settled,micad,apid} deployment=%s mica-health=%s' \
        "${sysstate:-unknown}" "$failed" "${slot:-none}" "$mh"
    return "$rc"
}

health_window() {
    local tag=$1 before after first second rc=0
    before=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
    first=$(health_verdict) || rc=$?
    if [ "$rc" -ne 0 ]; then
        printf 'window not started: %s' "$first"
        return "$rc"
    fi
    sleep "$STABILITY_SECONDS" || rc=1
    capture_boot_state "${tag}-end"
    after=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
    second=$(health_verdict) || rc=$?
    [ "$before" != unknown ] && [ "$before" = "$after" ] || rc=1
    printf 'window=%ss boot-id=%s..%s initial={%s} final={%s}' \
        "$STABILITY_SECONDS" "$before" "$after" "$first" "$second"
    return "$rc"
}

# The whole per-boot probe set. Called by several stages; journald is
# Storage=volatile on this image, so THIS BOOT'S JOURNAL IS GONE AFTER THE NEXT
# REBOOT and every stage captures it eagerly rather than assuming it can be
# read back later.
capture_boot_state() {
    local tag=$1
    cap "${tag}-systemd-state"  -- systemctl is-system-running
    cap "${tag}-failed-units"   -- systemctl list-units --failed --all --no-legend --plain
    cap "${tag}-journal"        -- journalctl -b --no-pager
    cap "${tag}-journal-warn"   -- journalctl -b -p warning --no-pager
    cap "${tag}-boots"          -- journalctl --list-boots --no-pager
    cap "${tag}-dmesg"          -- dmesg
    cap "${tag}-deployment"     -- mica-deploy status
    capf "${tag}-boot-receipt"   /run/mica/boot.json
    cap "${tag}-mounts"         -- findmnt --raw --evaluate
    cap "${tag}-df"             -- df -h
    cap "${tag}-uptime"         -- uptime
    capf "${tag}-cmdline"       /proc/cmdline
    capf "${tag}-release"       /usr/share/mica/release-identity.env
}

# --- apid, without jq -------------------------------------------------------
#
# The reads below are authenticated. WITHOUT A TOKEN THE COLLECTOR DOES NOT LOG
# IN: minting a session on the device writes apid's audit ring and its
# login-backoff counters, and a test harness must not be the thing that locks
# the operator out. It records `not collected: no API token` and leans on the
# unauthenticated sources -- mica-deploy, systemctl, the bus -- for
# everything they cover.
api_get() {
    local path=$1 name=$2
    if ! have curl; then
        printf '# curl absent\n' >"$EV/$name.txt"; return 127
    fi
    if [ -z "$TOKEN" ]; then
        printf '# not collected: no API token (--token / MICA_BENCH_TOKEN)\n' >"$EV/$name.txt"
        return 3
    fi
    if [ -z "$API_BASE" ]; then
        printf '# not collected: no confirmed API URL (--api)\n' >"$EV/$name.txt"
        return 4
    fi
    curl -sS -k --max-time 20 -H "Authorization: Bearer $TOKEN" \
        "$API_BASE$path" >"$EV/$name.txt" 2>&1
    local rc=$?
    flush
    return "$rc"
}

# Flatten a JSON document to one `"key": value` token per line.
#
# DELIBERATELY SHALLOW. It cannot tell two identically-named keys at different
# depths apart and it does not try to; that is why the RAW BODY is kept beside
# every extraction and is what an evidence note points at. A real parser is not
# available -- the image ships no jq, no python3 and no perl by design -- and a
# clever regex pretending to be one would fail silently on exactly the nested
# document nobody checked.
json_tokens() { tr ',{}[]' '\n\n\n\n\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$'; }
# The first match is taken from a captured value, not with `| head -n1`: head
# exits at that line and the producer dies of SIGPIPE, which pipefail reports as
# a failed pipeline.
json_scalar() {
    local matches
    matches="$(json_tokens | sed -n "s/^\"$1\"[[:space:]]*:[[:space:]]*//p")"
    printf '%s\n' "${matches%%$'\n'*}" | sed 's/^"//;s/"$//'
}

# --- cycle accumulators -----------------------------------------------------
#
# A stage that needs the device to reboot cannot survive the reboot. So the
# reboot stages are RE-RUNNABLE and ACCUMULATE: each run appends one cycle and
# recomputes the row from every cycle on file. Until the required count is
# reached the row reads `not tested` naming how many are recorded -- which is
# what qualification.md section 4 means by "cold/warm boot rows state the cycle
# count".
cycle_append() {
    local file=$1 verdict=$2 detail
    detail=$(one_cell "$3")
    printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ 2>/dev/null || echo unknown)" "$verdict" "$detail" \
        >>"$OUT/$file"
    flush
}
cycle_observe() {
    local file=$1 kind=$2 health_rc=$3 summary=$4 boot_id answer note
    boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
    if [ "$health_rc" -eq 2 ]; then
        say "  cycle not counted: $summary"
        return 0
    fi
    if grep -F "boot-id=$boot_id" "$OUT/$file" >/dev/null 2>&1; then
        say "  cycle not counted: boot-id=$boot_id is already present in $OUT/$file"
        return 0
    fi
    if [ "$DRY_RUN" -eq 0 ]; then
        if ! interactive; then
            say "  cycle not counted: no operator confirmed $kind and its external trace"
            return 0
        fi
        answer=$(ask "does this boot have the required $kind admission and external serial/power trace? yes / no") || answer=""
        [ "$answer" = yes ] || {
            say "  cycle not counted: operator did not confirm $kind admission"
            return 0
        }
        note=$(ask "name the admission/trace evidence for this boot (one line)") || note=""
        [ -n "$note" ] || note="operator supplied no evidence note"
        summary="$summary; operator=$note"
    else
        summary="$summary; dry-run admission fixture"
    fi
    if [ "$health_rc" -eq 0 ]; then
        cycle_append "$file" green "boot-id=$boot_id evidence=$EV $summary"
    else
        cycle_append "$file" red "boot-id=$boot_id evidence=$EV $summary"
    fi
}
cycle_verdict() {
    local file=$1 key=$2 want=$3 label=$4 total green
    total=$(count_lines "$OUT/$file")
    green=$(awk -F'\t' '$2=="green"' "$OUT/$file" 2>/dev/null | grep -c . || true)
    green=${green:-0}
    if [ "$total" -gt "$green" ]; then
        record "$key" fail "$label: $((total - green)) of $total cycles were not green; see $OUT/$file and evidence/"
    elif [ "$green" -ge "$want" ]; then
        record "$key" pass "$label: $green/$green cycles green; see $OUT/$file and evidence/"
    else
        record "$key" "not tested" "$label: $green of $want cycles recorded so far; re-run this stage after the next cycle"
    fi
}

detail_cycle_verdict() {
    local file=$1 key=$2 want=$3 label=$4 total green
    total=$(count_lines "$OUT/$file")
    green=$(awk -F'\t' '$2=="green"' "$OUT/$file" 2>/dev/null | grep -c . || true)
    green=${green:-0}
    if [ "$total" -gt "$green" ]; then
        detail_record "$key" fail "$label: $((total - green)) of $total cycles were not green; see $OUT/$file and evidence/"
    elif [ "$green" -ge "$want" ]; then
        detail_record "$key" pass "$label: $green/$green cycles green; see $OUT/$file and evidence/"
    else
        detail_record "$key" "not tested" "$label: $green of $want cycles recorded so far; re-run this stage after the next cycle"
    fi
}

# ===========================================================================
# stages
# ===========================================================================

stage_install() {
    say "== install : the flash, and the profile it wrote =="
    capf release /usr/share/mica/release-identity.env
    capf emmc-cid "$SYSTEM_SYS/device/cid" "$SYSTEM_SYS/device/name" \
        "$SYSTEM_SYS/device/manfid" "$SYSTEM_SYS/device/oemid" \
        "$SYSTEM_SYS/device/serial" "$SYSTEM_SYS/device/date"
    capf emmc-health "$SYSTEM_SYS/device/life_time" "$SYSTEM_SYS/device/pre_eol_info"
    cap partitions -- lsblk -o NAME,SIZE,TYPE,PARTLABEL,MOUNTPOINT

    # The binding qualification.md section 1 requires, and the two elements this
    # tree does not have. A run whose binding is incomplete is not a
    # qualification run, so both are measurements in their own right.
    local part=""
    [ -r "$SYSTEM_SYS/device/name" ] && part=$(cat "$SYSTEM_SYS/device/name" 2>/dev/null)
    if [ -n "$part" ]; then
        measure BIND-STORAGE "eMMC part name '$part'; CID and manfid in evidence/$STAGE/emmc-cid.txt"
    else
        measure BIND-STORAGE "not collected: $SYSTEM_SYS/device/name unreadable -- the dossier's binding stays incomplete"
    fi
    local profile=""
    [ -r /usr/share/mica/release-identity.env ] &&
        profile=$(sed -n '/^PROFILE=/{s/^PROFILE=//;p;q;}' /usr/share/mica/release-identity.env)
    measure BIND-PROFILE "${profile:-not collected: no PROFILE in release-identity.env}"
    measure BIND-IMAGE "source=$SOURCE_COMMIT tree=$SOURCE_TREE image=$IMAGE_NAME sha256=$IMAGE_SHA256 verification=$VERIFICATION_RECORD profile=$PROFILE board=$BOARD_REVISION radio=$RADIO_SKU system=$SYSTEM_BLOCK"

    operator_detail I1 \
        "identify the authorized RockUSB unit and host; verify IMAGE_SHA256 and VERIFICATION_RECORD, flash IMAGE_NAME with an explicit MICA_IMAGE, then compare the full $SYSTEM_BLOCK readback" \
        "the source/tree, signed release and component records, image SHA-256, profile, board/radio revision, exact target and full readback all agree with exact-image.env"
    operator_detail B1 \
        "erase the identified development unit, install the bound complete image and retain uninterrupted serial through first required-health confirmation" \
        "the blank unit reaches authenticated root/support, DATA growth, provisioning and the complete required-health set for this profile"

    operator_step install \
        "confirm the flash: which host, which rkdeveloptool version, which image file, and was the eMMC blank or erased first" \
        "rkdeveloptool completed with no error against a blank unit, and the unit reached the state ../user/install.md section 5 claims -- not merely that it powered on. Row 13 binds the profile above: say which one was written."
}

stage_firstboot() {
    say "== firstboot : cold cycle, DATA growth, offline service =="
    capture_boot_state cold
    cap repart      -- journalctl -b -u systemd-repart --no-pager
    cap growfs      -- journalctl -b -u "systemd-growfs@*" --no-pager
    cap data-layout -- systemctl status mica-data-layout.service
    capf identity-record /mnt/data/state/machine-id
    capf machine-id-file /etc/machine-id
    api_get /api/v1/storage/status storage-status-api || true
    api_get /api/v1/provisioning/status provisioning-api || true
    cap networkctl  -- networkctl list

    local summary rc=0
    summary=$(health_window cold) || rc=$?
    cycle_observe cycles-cold.tsv "fully unpowered cold start" "$rc" "$summary"
    say "  this boot: $summary"
    cycle_verdict cycles-cold.tsv cold-boot "$COLD_CYCLES" "cold boot from fully unpowered"
    detail_cycle_verdict cycles-cold.tsv B2 "$COLD_CYCLES" "cold boot with ${STABILITY_SECONDS}-second required-health window"

    # --- row 5, growth half -------------------------------------------------
    local datasize disksize s1_growth_failed=0
    datasize=$(df -B1 --output=size /mnt/data 2>/dev/null | tail -n1 | tr -d ' ')
    disksize=$(cat "$SYSTEM_SYS/size" 2>/dev/null || echo "")
    if [ -n "$datasize" ] && [ -n "$disksize" ] && [ "$disksize" -gt 0 ] 2>/dev/null; then
        # DATA is the only tier that grows; it should be most of what is left
        # after the fixed partitions. The loader's survival is the other half:
        # a repart run that TRIMmed sector 64 leaves a unit that boots once.
        local diskbytes=$((disksize * 512)) pct=0
        pct=$(( datasize * 100 / diskbytes ))
        measure GROWTH "DATA is ${datasize} bytes of a ${diskbytes}-byte medium (${pct}%)"
        if [ "$pct" -ge 40 ]; then
            record storage "not tested" "growth half observed on this boot: DATA grew to ${pct}% of the medium and the unit booted, so the loader partition survived repart; the fill half is stage 'storagefill'"
            detail_record S1 "not tested" "DATA-only growth is ${pct}% of $SYSTEM_BLOCK; exact FIRMWARE/SYSTEM geometry and next-boot GPT agreement still require operator readback"
        else
            record storage fail "DATA is only ${pct}% of the medium after first boot; systemd-repart growth did not run or did not complete (see evidence/$STAGE/repart.txt)"
            detail_record S1 fail "DATA is only ${pct}% of $SYSTEM_BLOCK after first boot"
            s1_growth_failed=1
        fi
    else
        record storage "not tested" "growth half not collected: could not read /mnt/data size or $SYSTEM_SYS/size"
        detail_record S1 "not tested" "could not read /mnt/data size or $SYSTEM_SYS/size"
    fi
    if [ "$s1_growth_failed" -eq 0 ]; then
        operator_detail S1 \
            "compare before/after block geometry and bytes for FIRMWARE, SYSTEM and DATA on $SYSTEM_BLOCK, then capture the next-boot primary/backup GPT scan" \
            "FIRMWARE is unchanged, SYSTEM is exactly 1 GiB, only DATA grows, both GPT copies agree, and the bound eMMC identity/health surface is retained"
    fi

    # --- row 11, offline service -------------------------------------------
    #
    # This is the only stage that can test it honestly. Later the cable is in,
    # and unplugging it to simulate a first boot with no network tests the
    # unplug, not the claim.
    local carriers
    carriers=$(cat /sys/class/net/*/carrier 2>/dev/null | grep -c '^1$' || true)
    capf provisioning /mnt/data/state/mica/provisioning /mica/config
    cap hostname     -- hostnamectl
    cap apid-listen  -- systemctl status apid.service
    if [ "${carriers:-0}" -gt 0 ]; then
        record offline "not tested" "a link already has carrier (${carriers} interface(s) up), so this boot is not offline; row 11's claim can only be measured on a boot with no cable attached"
    else
        operator_step offline \
            "with NO cable attached: read the provisioning document off the medium, log into apid over the console-published address, change one setting and read it back" \
            "the device has an identity-derived hostname, a minted credential, a provisioning document and a listening apid, and a configuration change round-trips -- all with no network. See ../design/provisioning.md section 2."
    fi
    operator_detail F4 \
        "with every external network path physically absent, use the confirmed local management path to inspect provisioning, change and read back one setting, then request authenticated shutdown" \
        "local management, provisioning and shutdown work without network time and without an inferred API endpoint"
}

stage_inventory() {
    say "== inventory : the four Gate D measurements, read-only =="

    # --- M1: the eth1 DHCPv4 lease defect ----------------------------------
    cap m1-networkctl-list  -- networkctl list
    cap m1-networkctl-all   -- networkctl status --all
    cap m1-ip-link          -- busybox ip link show
    cap m1-ip-addr          -- busybox ip -4 addr show
    cap m1-networkd-journal -- journalctl -b -u systemd-networkd --no-pager
    capf m1-network-units /etc/systemd/network/80-dhcp.network
    local rendered
    rendered=$(ls /run/systemd/network/ 2>/dev/null | tr '\n' ' ')
    measure M1-RENDERED "micad rendered into /run/systemd/network: ${rendered:-(nothing)}"
    local ifaces
    ifaces=$(ls /sys/class/net 2>/dev/null | tr '\n' ' ')
    measure M1-INTERFACES "kernel interfaces: ${ifaces:-(none read)}"
    local i drv
    for i in /sys/class/net/eth*; do
        [ -e "$i" ] || continue
        drv=$(linkname "$i/device/driver") || true
        measure "M1-${i##*/}" "driver=$drv mac=$(cat "$i/address" 2>/dev/null) assign_type=$(cat "$i/addr_assign_type" 2>/dev/null) carrier=$(cat "$i/carrier" 2>/dev/null || echo n/a)"
    done
    measure M1 "interface and driver set recorded; the LEASE half is taken in stage 'network', with cables attached"

    # --- M2: whether a watchdog device exists at all -----------------------
    cap m2-dev       -- ls -l /dev/watchdog /dev/watchdog0 /dev/watchdog1
    cap m2-class     -- ls -l /sys/class/watchdog/
    cap m2-dmesg     -- dmesg
    local w attrs=""
    if [ -d /sys/class/watchdog ]; then
        for w in /sys/class/watchdog/watchdog*; do
            [ -e "$w" ] || continue
            attrs=$(ls "$w" 2>/dev/null | tr '\n' ' ')
            capf "m2-$(basename "$w")-attrs" "$w"/*
            measure "M2-$(basename "$w")" "attributes: $attrs"
        done
    fi
    if [ -e /dev/watchdog0 ] || [ -e /dev/watchdog ]; then
        measure M2 "a watchdog character device EXISTS"
        if [ -e /sys/class/watchdog/watchdog0/bootstatus ]; then
            measure M2-BOOTSTATUS "bootstatus=$(cat /sys/class/watchdog/watchdog0/bootstatus 2>/dev/null)"
        else
            measure M2-BOOTSTATUS "ABSENT. The current image enables CONFIG_WATCHDOG_SYSFS=y. Investigate the flashed image and driver; row 10's reset-cause requirement remains unproven without another recorded source."
        fi
    else
        measure M2 "NO watchdog character device. The board DTS sets /watchdog@2ace0000 to okay and CONFIG_DW_WATCHDOG=y is built, so this is a defect to report, not an absence to accept."
    fi
    record watchdog "not tested" "presence readout taken in stage 'inventory'; the row itself needs the deliberate hang in stage 'watchdog'"

    # --- M3: the UART map ---------------------------------------------------
    cap m3-tty-driver -- cat /proc/tty/driver/serial
    # THE FULL MAP GOES IN A CAPTURE FILE, one line per port, and only the
    # device-tree-backed ports become measurements. An x86 kernel registers
    # thirty-two serial8250 ports with no of_node between them; emitting a
    # measurement per port would bury the seven that answer the question.
    local t node drv mapped=0
    : >"$EV/m3-uart-map.txt"
    for t in /sys/class/tty/ttyS*; do
        [ -e "$t" ] || continue
        node=$(linktarget "$t/device/of_node") || true
        drv=$(linkname "$t/device/driver") || true
        printf '%-10s of_node=%s driver=%s\n' "${t##*/}" "$node" "$drv" >>"$EV/m3-uart-map.txt"
        if [ "$node" != none ] && [ "$node" != unresolvable ]; then
            mapped=$((mapped + 1))
            measure "M3-${t##*/}" "of_node=$node driver=$drv"
        fi
    done
    flush
    measure M3-PORTS "$mapped of $(count_lines "$EV/m3-uart-map.txt") ttyS ports carry a device-tree node; the full map is evidence/$STAGE/m3-uart-map.txt"
    capf m3-fiq /sys/class/tty/ttyFIQ0
    operator_note M3 "the DTS enables seven UARTs and names three (uart1/uart6 RS-485, uart4 BT HCI). For each ttyS above, what is it physically wired to -- and does this board have a display or HMI module on a serial port at all, or is the display HDMI only?"

    # --- M4: the input device set ------------------------------------------
    capf m4-input /proc/bus/input/devices
    cap m4-devinput -- ls -l /dev/input/
    local n
    n=$(grep -c '^N: ' /proc/bus/input/devices 2>/dev/null || true)
    measure M4 "${n:-0} input device(s) registered; adc-keys is status=\"disabled\" in the board DTS while CONFIG_KEYBOARD_ADC=y is built, so an adc-keys device appearing here would itself be a finding"
    operator_note M4-USB "plug a USB keyboard into a host port and say whether a new input device appeared (re-read /proc/bus/input/devices). BOARD_RECOVERY_ACTIONS being empty rests partly on U-Boot on this board not taking a USB keyboard."

    # --- row 8 readout ------------------------------------------------------
    cap rtc-dev     -- ls -l /dev/rtc /dev/rtc0
    cap rtc-class   -- ls -l /sys/class/rtc/
    cap rtc-hwclock -- hwclock -r
    cap rtc-time    -- timedatectl
    cap i2c-devices -- ls -l /sys/bus/i2c/devices/
    cap rtc-dmesg   -- dmesg
    # EXPECTED TO BE PRESENT. kernel/configure.sh does `scripts/config --enable
    # RTC_DRV_HYM8563` and then `require '^CONFIG_RTC_DRV_HYM8563=y'`, so the
    # kernel cannot build without the driver the DTS node's second compatible
    # (haoyu,hym8563) binds. Absence is the finding here, not presence.
    if [ -e /dev/rtc0 ] || [ -e /dev/rtc ]; then
        measure RTC-PRESENT "an RTC character device EXISTS: $(ls /sys/class/rtc 2>/dev/null | tr '\n' ' ')"
        # Index, not identity: RTC_HCTOSYS_DEVICE="rtc0" binds by index. One
        # driver is built and one node enabled, so this should be the AT8563 --
        # confirmed rather than assumed, because it is one read.
        measure RTC-RTC0-NAME "$(cat /sys/class/rtc/rtc0/name 2>/dev/null || echo 'not collected: /sys/class/rtc/rtc0/name unreadable')"
    else
        measure RTC-PRESENT "NO /dev/rtc, and that is a DEFECT rather than the expected state: kernel/configure.sh enables RTC_DRV_HYM8563 and asserts it in the resolved config, and the DTS declares an AT8563 at i2c7 0x51 whose second compatible is haoyu,hym8563. Capture evidence/$STAGE/rtc-dmesg.txt and evidence/$STAGE/i2c-devices.txt and report it."
    fi
    # The chain behind the radio, captured while the boot journal still exists.
    # journald is Storage=volatile, so this is gone after the next reboot.
    cap sdio-pwrseq -- sh -c "dmesg | grep -iE 'pwrseq|deferred|mmc[0-9]|aic8800'"
    measure RTC-SDIO "the DTS gives /sdio-pwrseq clocks = <&at8563> and CONFIG_PWRSEQ_SIMPLE=y is built, so a bound RTC driver registers the clock and the SDIO host (mmc@2a320000, where the AIC8800D80 sits) should probe. Expected to work; this capture is the first place to look if the radio does not. Evidence in evidence/$STAGE/sdio-pwrseq.txt; the verdict is stage 'network'."

    # --- row 10 baseline ----------------------------------------------------
    cap reset-baseline -- journalctl --list-boots --no-pager
    capf uptime-baseline /proc/uptime
}

stage_warmboot() {
    say "== warmboot : warm reboot cycles, and the RTC across a power-off =="
    capture_boot_state warm
    cap tz -- timedatectl
    capf saved-floor /mnt/data/state/mica/clock /var/lib/systemd/timesync/clock

    local summary rc=0
    summary=$(health_window warm) || rc=$?
    cycle_observe cycles-warm.tsv "authenticated reboot with complete exitrd teardown" "$rc" "$summary"
    say "  this boot: $summary"
    cycle_verdict cycles-warm.tsv warm-boot "$WARM_CYCLES" "warm reboot from a running system"
    detail_cycle_verdict cycles-warm.tsv B3 "$WARM_CYCLES" "authenticated reboot with exitrd teardown and ${STABILITY_SECONDS}-second required-health window"

    operator_detail B4 \
        "request authenticated power-off, retain serial through complete teardown and loss of power, then reapply bench power and re-run this stage" \
        "power-off completes without a watchdog reset; the later physical power-on has a new boot ID and remains required-health green for ${STABILITY_SECONDS} seconds"

    # --- row 8 --------------------------------------------------------------
    #
    # TWO HONEST OUTCOMES, and the row records which. qualification.md row 8
    # reads "time survives power-off (battery-backed) OR the absence is handled
    # (documented resync behavior)", so a board with no RTC that comes back at
    # its saved floor and never goes backwards is a pass on the second limb.
    local now
    now=$(date -u +%FT%TZ 2>/dev/null || echo unknown)
    say "  wall clock now: $now"
    printf '%s\t%s\n' "$now" "pre-poweroff" >>"$OUT/clock-marks.tsv"; flush
    operator_step rtc \
        "remove power entirely for TEN MINUTES, then power on and re-run this stage" \
        "either the clock comes back within a minute of true time before any network sync (a working battery-backed RTC), or it comes back at the saved floor -- max(RTC, saved clock) per ../design/time.md section 3 -- monotonically. Both are a pass; the clock going BACKWARDS, or the device believing a time it should not, is a fail. Say which of the two happened."
    operator_detail F2 \
        "identify rtc0, remove all power for ten minutes with network absent, then record hardware time, saved floor and wall clock before network sync" \
        "rtc0 identity is recorded and time is either battery-retained or resumes monotonically from the documented saved floor"
}

stage_network() {
    say "== network : Ethernet on both ports, and the radio =="
    capture_boot_state net
    cap net-list      -- networkctl list
    cap net-status    -- networkctl status --all
    cap net-journal   -- journalctl -b -u systemd-networkd --no-pager
    cap ip-addr       -- busybox ip -4 addr show
    cap ip-route      -- busybox ip route show
    cap rfkill        -- rfkill list
    cap wpa           -- systemctl status wpa_supplicant.service
    cap radio-dmesg   -- sh -c "dmesg | grep -iE 'aic8800|firmware|wlan|pwrseq|deferred'"
    cap firmware-files -- ls -l /usr/lib/firmware

    # The eth1 lease, which is the measurement PLAN-037 Gate D names.
    local i lease
    for i in /sys/class/net/eth*; do
        [ -e "$i" ] || continue
        i=$(basename "$i")
        cap "lease-$i" -- networkctl status "$i"
        lease=$(busybox ip -4 addr show "$i" 2>/dev/null | sed -n 's/.*inet \([0-9.]*\/[0-9]*\).*/\1/p')
        lease=${lease%%$'\n'*}
        if [ -n "$lease" ]; then
            measure "M1-LEASE-$i" "has an IPv4 address: $lease"
        else
            measure "M1-LEASE-$i" "NO IPv4 address. carrier=$(cat "/sys/class/net/$i/carrier" 2>/dev/null || echo n/a). This is the eth1 lease defect if it is eth1 with a cable in it: capture networkctl status and the networkd journal above, and file it -- this stage characterises it, it does not fix it."
        fi
    done

    operator_step network \
        "attach Ethernet to eth0 and confirm a lease; move to eth1 and confirm; then both. Configure the Wi-Fi client against the bench AP and transfer data over it. Say which physical port is which interface name." \
        "Ethernet and each named radio module associate and transfer under the shipped stack. eth1 failing to take a DHCPv4 lease is a FAIL for this row, not a footnote. A Wi-Fi failure traced to the deferred SDIO power sequence is likewise a fail with a named cause, which is worth more than a 'not tested'."
    operator_detail N1 \
        "map both physical Ethernet ports, then record topology-derived MAC, DHCP, DNS and link-bound application transfer for each across three boots" \
        "both ports retain their expected distinct MAC identities and independently carry DHCP, DNS and application traffic"
    operator_detail N2 \
        "on the bound AIC8800D80 SKU and controlled AP, record global/phy regulatory state, firmware load, association, DHCP, DNS and link-bound transfer" \
        "post-service regulatory state is correct and Wi-Fi carries authenticated application traffic"
    operator_detail N3 \
        "name a controlled Bluetooth peer and profile, then record controller identity, pairing, connection and bidirectional operation" \
        "the named profile exchanges data in both directions; controller enumeration alone is insufficient"
}

stage_fieldbus() {
    say "== fieldbus : CAN, USB host, and the OTG gadget console =="
    say "  NOTE: the CAN interface exercised here is can0 ON THE BENCH UNIT."
    say "        It must be the bench harness's own bus, never one attached to a"
    say "        live vehicle or a production machine."
    cap can-link    -- networkctl status can0
    cap can-stats   -- sh -c 'for f in /sys/class/net/can0/statistics/*; do printf "%s %s\n" "${f##*/}" "$(cat "$f")"; done'
    capf can-conf   /etc/mica/can.conf
    capf can-network /run/systemd/network/10-mica-can.network
    cap can-units   -- systemctl status mica-can.service mica-otg.service mica-gadget.service mica-modules.service
    cap udc         -- ls -l /sys/class/udc/
    cap gadget-tree -- find /sys/kernel/config/usb_gadget -maxdepth 3
    cap gadget-getty -- systemctl status "serial-getty@ttyGS0.service"
    cap usb-devices -- sh -c 'for d in /sys/bus/usb/devices/*/; do [ -r "$d/idVendor" ] || continue; printf "%s %s:%s %s\n" "$d" "$(cat "$d/idVendor")" "$(cat "$d/idProduct")" "$(cat "$d/product" 2>/dev/null)"; done'
    cap otg-mode    -- sh -c 'cat /sys/devices/platform/*/*/otg_mode 2>/dev/null'

    local bitrate
    bitrate=$(networkctl status can0 2>/dev/null | sed -n 's/^ *Bit Rate: *//p')
    bitrate=${bitrate%%$'\n'*}
    measure CAN-BITRATE "${bitrate:-not read} (can.conf ships 250000, fd off, restart-ms 100)"
    if have cansend && have candump; then
        measure CAN-TOOLS "cansend and candump are present; frames can be driven from the device"
    else
        measure CAN-TOOLS "cansend/candump are NOT on this image; frames must be driven from the peer node and observed here via /sys/class/net/can0/statistics"
    fi

    operator_step fieldbus \
        "connect the second CAN node at 250 kbit/s classic (FD off) and pass frames both ways; plug a host PC into the OTG port and log in over the CDC ACM console; plug a USB device into a host port" \
        "CAN traffic passes both ways at the shipped configuration; the gadget enumerates on the host PC and its getty logs in; a USB device on a host port enumerates. Say which of the three worked -- a partial result is a fail with the working parts named, not a pass."
    operator_detail F1 \
        "enumerate a USB host device and the OTG CDC-ACM login, then exchange CAN frames both ways at the declared bitrate on the isolated local bench bus" \
        "USB host, authenticated gadget login and bidirectional can0 traffic all work with retained counters and errors"
}

stage_thermal() {
    say "== thermal : sustained load inside the thermal envelope =="
    cap thermal-zones -- sh -c 'for z in /sys/class/thermal/thermal_zone*; do printf "%s %s %s\n" "$z" "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done'
    cap thermal-trips -- find /sys/class/thermal -name "trip_point_*" -exec sh -c 'printf "%s=%s\n" "$1" "$(cat "$1" 2>/dev/null)"' _ {} \;
    cap cpufreq       -- sh -c 'for c in /sys/devices/system/cpu/cpu*/cpufreq; do [ -d "$c" ] || continue; printf "%s min=%s max=%s cur=%s\n" "$c" "$(cat "$c/scaling_min_freq" 2>/dev/null)" "$(cat "$c/scaling_max_freq" 2>/dev/null)" "$(cat "$c/scaling_cur_freq" 2>/dev/null)"; done'

    if ! have sleep; then
        record thermal "not tested" "'sleep' is not on this image, so the sampled load cannot be timed; the zone and trip readouts are in evidence/$STAGE/"
        return 0
    fi
    # The load itself needs nobody, but the row's criterion does -- the
    # enclosure and airflow it ran in are half the measurement -- and a
    # half-hour all-core load is not something an unattended invocation should
    # start on a board nobody is watching.
    require_operator thermal "the ${THERMAL_SECONDS}s all-core load" || return 0

    local ncpu samples="$EV/thermal-samples.tsv" i deadline loadpids=""
    ncpu=$(nproc 2>/dev/null || echo 1)
    say "  loading $ncpu core(s) for ${THERMAL_SECONDS}s, sampling every ${THERMAL_SAMPLE}s"
    printf 'epoch\tzone\ttype\ttemp_mC\tcpu0_cur_kHz\n' >"$samples"

    # PIDs are collected from `$!` per spawn, not from `jobs -p`: `jobs` inside
    # a command substitution runs in a subshell whose job table is its own, so
    # the list would come back empty and the load would outlive the stage.
    i=0
    while [ "$i" -lt "$ncpu" ]; do
        ( while :; do : ; done ) &
        loadpids="$loadpids $!"
        i=$((i + 1))
    done

    deadline=$(( $(date -u +%s) + THERMAL_SECONDS ))
    while [ "$(date -u +%s)" -lt "$deadline" ]; do
        local z
        for z in /sys/class/thermal/thermal_zone*; do
            [ -e "$z/temp" ] || continue
            printf '%s\t%s\t%s\t%s\t%s\n' \
                "$(date -u +%s)" "$(basename "$z")" "$(cat "$z/type" 2>/dev/null)" \
                "$(cat "$z/temp" 2>/dev/null)" \
                "$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null)" \
                >>"$samples"
        done
        flush
        sleep "$THERMAL_SAMPLE"
    done
    # shellcheck disable=SC2086  # deliberate word splitting: a PID list
    kill $loadpids 2>/dev/null || true
    wait 2>/dev/null || true

    local peak
    peak=$(awk -F'\t' 'NR>1 && $4+0>m {m=$4+0} END {print m+0}' "$samples")
    measure THERMAL-PEAK "peak zone temperature ${peak} mC over ${THERMAL_SECONDS}s of all-core load"
    say "  cooling down; sampling for 300s"
    deadline=$(( $(date -u +%s) + 300 ))
    while [ "$(date -u +%s)" -lt "$deadline" ]; do
        printf '%s\tcooldown\t-\t%s\t%s\n' "$(date -u +%s)" \
            "$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)" \
            "$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null)" >>"$samples"
        sleep "$THERMAL_SAMPLE"
    done

    local summary rc=0
    summary=$(health_verdict) || rc=$?
    if [ "$rc" -ne 0 ]; then
        record thermal fail "the system was not healthy after ${THERMAL_SECONDS}s of load: $summary; peak ${peak} mC; samples in evidence/$STAGE/thermal-samples.tsv"
        return 0
    fi
    operator_note THERMAL-ENCLOSURE "what enclosure and airflow was this run done in? An open board on a bench and a sealed enclosure are different measurements."
    operator_step thermal \
        "confirm the unit stayed up and responsive through the load, and say whether it reached a trip point" \
        "the unit stays inside its thermal envelope; where it reaches a trip point, frequency drops and the system stays up. A reset, a hang or an emergency poweroff during the load is a fail -- CONFIG_THERMAL_EMERGENCY_POWEROFF_DELAY_MS=0 means a critical trip powers the board off immediately, so that outcome looks like a dead unit rather than a log line. Survived with peak ${peak} mC: $summary"
    operator_detail F3 \
        "bind the enclosure and airflow to this thirty-minute load and five-minute cooldown, then confirm responsiveness and any throttling" \
        "the board stays up, throttles at declared trip points and returns toward idle temperature without crash or emergency power-off"
}

stage_watchdog() {
    say "== watchdog : a deliberate hang, the reset, and the reset cause =="
    cap wd-before-class -- ls -l /sys/class/watchdog/
    cap wd-before-boots -- journalctl --list-boots --no-pager
    cap wd-before-dmesg -- dmesg
    detail_record W1 "not tested" "this collector has no supported pre-PID-1 hang point; retain one continuous serial trace of U-Boot arming, Linux takeover and PID 1 ownership before qualifying W1"

    if [ ! -e /dev/watchdog0 ] && [ ! -e /dev/watchdog ]; then
        record watchdog fail "no /dev/watchdog on the running system, while the board DTS sets /watchdog@2ace0000 okay and CONFIG_DW_WATCHDOG=y is built. There is nothing to arm; see evidence/$STAGE/wd-before-dmesg.txt"
        return 0
    fi
    if [ "$(cat /sys/class/watchdog/watchdog0/state 2>/dev/null)" != active ]; then
        record watchdog fail "the production watchdog is not active before fault injection"
        return 0
    fi
    require_operator watchdog "crashing the local bench kernel with panic restart disabled" || return 0
    say "  PID 1 already owns and feeds the non-disarmable hardware watchdog."
    say "  Disable panic's software restart and trigger a crash, stopping all pets."
    say "  Capture the external serial trace and measured reset interval."
    ask "press Enter to trigger, or Ctrl-C to abort" >/dev/null
    printf '%s kernel-crash-trigger\n' "$(date -u +%FT%TZ)" >>"$OUT/watchdog-marks.tsv"
    flush
    echo 0 > /proc/sys/kernel/panic
    echo c > /proc/sysrq-trigger
    record watchdog fail "kernel crash injection returned unexpectedly"

}

stage_watchdog_after() {
    cap wd-after-class -- ls -l /sys/class/watchdog/
    cap wd-after-boots -- journalctl --list-boots --no-pager
    cap wd-after-dmesg -- sh -c "dmesg | grep -iE 'watchdog|wdt|reboot|reset|bootstatus'"
    local cause=""
    if [ -e /sys/class/watchdog/watchdog0/bootstatus ]; then
        cause=$(cat /sys/class/watchdog/watchdog0/bootstatus 2>/dev/null)
        measure WD-BOOTSTATUS "$cause"
    else
        measure WD-BOOTSTATUS "ABSENT (CONFIG_WATCHDOG_SYSFS is not set on this kernel)"
    fi
    cap wd-after-deployment -- mica-deploy status
    measure WD-ATTEMPTS "Record the remaining attempts from native status and the serial trace. A spent trial stays spent; never refill counters to prepare another test. Use a fresh complete image for a new test series."
    operator_step watchdog \
        "say how long after the last pet the board reset, and what the console printed on the way down" \
        "a hung system is reset by the watchdog within the configured timeout, AND the reset cause is readable afterwards. Both halves. If no bootstatus attribute exists and nothing else names the cause, this row is a FAIL on its second half with the first half stated -- it is not a pass, because the row claims both."
    operator_detail W2 \
        "bind the reset interval, external serial/power trace, persisted trial count and readable reset cause to this post-PID-1 hang" \
        "the watchdog expires within its configured window, a trial remains spent, and the reset cause is readable after the healthy restart"
}

stage_update() {
    say "== update : signed component install, confirmation, and fallback =="
    local id
    id=$(booted_deployment) || true
    cap upd-before-deployment -- mica-deploy status
    api_get /api/v1/update upd-before-api || true
    if [ -z "$id" ]; then
        record ab-update "not tested" "no authenticated running deployment; see upd-before-deployment.txt"
        return 0
    fi
    printf '%s\n' "$id" >"$OUT/update-before.id"
    flush
    operator_step ab-update \
        "start from a complete current factory image. Import a signed GOOD offline update archive with mica-deploy import <archive>, install its verified descriptor with mica-deploy install /mica/updates/verified/<id>.json --objects /mica/updates/verified/objects, then reboot and observe health confirmation. Repeat for root-only, kernel-only and combined releases. Then import and install a signed BAD-health deployment and observe three failed trials and fallback without intervening. Capture native status and the serial trace on every boot." \
        "only the named changed components are written; firmware and reused object digests stay unchanged; three bad trials exhaust without refill; the retained confirmed deployment boots healthy. Confirmation happens only through the health gate."
    operator_detail U1 \
        "install a signed root-only update and retain archive/catalog hashes plus before/after deployment and component identities" \
        "root changes, kernel/support bytes are reused exactly, and required health confirms the deployment"
    operator_detail U2 \
        "install a signed kernel/support-only update and retain archive/catalog hashes plus before/after deployment and component identities" \
        "kernel/support changes, root bytes are reused exactly, and required health confirms the deployment"
    operator_detail U3 \
        "install a signed combined root and kernel/support update and retain every component identity" \
        "both new authenticated files publish atomically and required health confirms the deployment"
    operator_detail U4 \
        "install a higher-generation signed candidate that fails one required-health member and retain all three serial traces and record copies without refill" \
        "exactly three persisted trials are spent, the retained confirmed deployment is selected, and the failed ID remains suppressed"
    operator_detail U5 \
        "exercise the selected online or offline acquisition path while recording DATA staging/download/verified objects and native state before activation" \
        "authenticated lengths and hashes agree, and no partial candidate becomes boot-visible"
    operator_detail U6 \
        "apply the separately signed current firmware package on this identified unit, verify complete readback and compare both native record copies" \
        "firmware readback matches the signed receipt, native records remain valid, and normal OS update writes no firmware bytes"
    cap upd-after-deployment -- mica-deploy status
    booted_deployment >"$OUT/update-after.id" || true
    flush
}

stage_powercut() {
    say "== powercut : named transaction and boot-counter boundaries =="
    [ -s "$OUT/update-after.id" ] || die "stage update must first record an authenticated deployment"
    cap pc-current-deployment -- mica-deploy status
    capf pc-current-receipt /run/mica/boot.json
    capf pc-baseline "$OUT/update-after.id"
    # Status after a reboot cannot establish the exact cut boundary: fallback
    # may already have changed selection. Require the external serial/power trace.
    require_operator power-cut "external power control and serial capture" || return 0
    say "  Cut during download, object write, file fsync, directory publication,"
    say "  candidate activation, attempt decrement and health confirmation."
    say "  Record image/component IDs, the requested cut, the observed serial"
    say "  boundary, storage identity, and post-reset native status for every cut."
    say "  Repeat at least ten cuts per installation/activation boundary and"
    say "  fifty randomized redundant-record writes. Keep the external trace."
    say "  Never edit boot variables, replenish attempts, or source saved records."
    operator_step power-cut \
        "perform the cut matrix using the local bench power controller. Re-run this stage after each power-up and attach the external trace; mark an unobservable cut as inconclusive." \
        "each interruption exposes either the previous committed deployment or a fully staged candidate. Referenced objects remain complete; torn records are refused; persisted attempts never refill; exhaustion falls back or reaches the defined recovery stop. VM process kills do not establish this physical result."
    operator_detail P1 "perform at least ten externally timed cuts during download or offline import" "no incomplete candidate is boot-visible and the prior deployment boots after every cut"
    operator_detail P2 "perform at least ten externally timed cuts during destination object writes and file sync" "current/fallback descriptors and every referenced component file remain complete"
    operator_detail P3 "perform at least ten externally timed cuts on each object and descriptor directory-publication boundary" "every visible object matches its authenticated length and digest"
    operator_detail P4 "perform at least ten externally timed cuts during candidate activation" "selection is either the previous committed state or the fully durable candidate, never a partial record"
    operator_detail P5 "perform at least fifty randomized cuts during redundant trial-attempt record writes" "an unpersisted decrement refuses launch and a spent attempt never refills"
    operator_detail P6 "perform at least ten externally timed cuts during required-health confirmation" "reconciliation preserves the authenticated running deployment and retained fallback without refilling trials"
    operator_detail P7 "perform at least ten cuts during garbage collection plus the P5 record series" "every retained descriptor/object and at least one valid native record copy survive"
}

stage_storagefill() {
    say "== storagefill : DATA bulk/disposable quotas and protected reserve =="
    say "  COPY THE RUN DIRECTORY OFF THE DEVICE BEFORE THIS STAGE."
    cap fill-before-df -- df -h
    api_get /api/v1/storage/status fill-before-api || true
    capf emmc-health-now "$SYSTEM_SYS/device/life_time" "$SYSTEM_SYS/device/pre_eol_info"
    cap quota-projects -- repquota -P -n -O csv /mnt/data
    cap namespace-mounts -- sh -c 'for p in /var /mica /srv /mica/containers; do findmnt --raw --evaluate "$p"; done'
    cap namespace-stat -- stat -c '%n device=%d inode=%i mode=%a owner=%u:%g' /var /mica /srv /mica/containers
    cap container-storage -- podman info

    local lt peol
    lt=$(cat "$SYSTEM_SYS/device/life_time" 2>/dev/null || echo "")
    peol=$(cat "$SYSTEM_SYS/device/pre_eol_info" 2>/dev/null || echo "")
    if [ -n "$lt" ]; then
        measure EMMC-HEALTH "life_time='$lt' pre_eol_info='$peol' -- each life_time byte is a 10% bucket; 0x00 means the device does not define that estimate, which is not the same as healthy"
    else
        measure EMMC-HEALTH "not collected: $SYSTEM_SYS/device/life_time unreadable. ../design/storage.md section 4 says the surface must answer 'unsupported' with a reason rather than an empty object, and this is that case."
    fi

    operator_step storage \
        "verify /mica, /srv and /mica/containers have zero byte and inode limits. Exercise representative writes across writable /var, exhaust only the bounded /var project by bytes and inodes, and confirm state/meta plus apid remain available. For a container, verify bind, storage and tmp paths are independent/private, then reset and confirm isolation. Remove only the test filler and repeat health." \
        "the three unbounded namespaces retain zero byte and inode limits; whole /var is writable but bounded; container bind/storage/tmp are private and reset-isolated; state/meta reserve stays writable. Report eMMC health or an explicit unsupported reason."
    operator_detail S2 \
        "perform the current quota, representative /var write, bounded exhaustion and container reset-isolation matrix captured above" \
        "/mica, /srv and /mica/containers have zero byte and inode limits; /var is writable and bounded; private container data does not cross reset boundaries"
}

stage_display() {
    say "== display : HDMI presentation, tty2 and late attach =="
    cap drm-state -- sh -c 'for c in /sys/class/drm/card*-HDMI-A-*; do [ -e "$c/status" ] || continue; printf "%s status=%s\n" "$c" "$(cat "$c/status")"; cat "$c/modes" 2>/dev/null; done'
    cap fb-state -- sh -c 'for f in /sys/class/graphics/fb*; do [ -e "$f" ] || continue; printf "%s name=%s mode=%s\n" "$f" "$(cat "$f/name" 2>/dev/null)" "$(cat "$f/modes" 2>/dev/null)"; done'
    cap vt-units -- systemctl status getty@tty1.service getty@tty2.service
    capf cmdline /proc/cmdline
    operator_detail D1 \
        "connect the named HDMI sink before power-on, photograph the connector/mode and observe the screen through the 180-second health window" \
        "one centered Mica OS icon-and-wordmark gradient logo remains visible with no normal login prompt"
    operator_detail D2 \
        "with a named USB keyboard, use Alt+F2 and Ctrl+Alt+F2, authenticate on tty2, log out, and record tty1/tty2 unit state" \
        "both shortcuts reach ordinary authenticated tty2, no autologin occurs, and tty1 has no getty"
    operator_detail D3 \
        "after the tty2 login/logout test, return to tty1 and retain a photograph plus connector/fb state" \
        "the centered product presentation is restored without exposing stale diagnostic text"
    operator_detail D4 \
        "boot without an HDMI sink, record connector/fb state, then attach the named sink after the system is healthy" \
        "the product presentation appears on the new viewport without reboot or backing-allocation growth"
    detail_record D5 "not tested" "optional observation only: current row D5 is inherited from the historical PLAN-088 section 2.2 panic obligation (old bench D4) and is superseded by the current serial-only console policy; do not trigger an extra crash"
}

stage_accelerators() {
    say "== accelerators : NPU, encoder and decoder workloads =="
    cap accelerator-devices -- sh -c 'ls -l /dev/dri /dev/rga /dev/mpp_service /dev/rknpu* 2>/dev/null'
    cap accelerator-iomem -- sh -c "grep -iE 'rknpu|rkvenc|rkvdec|mpp|fdab|fdbd|fdc3' /proc/iomem"
    cap accelerator-dmesg -- sh -c "dmesg | grep -iE 'rknpu|rkvenc|rkvdec|mpp|iommu|reset|clock|thermal'"
    operator_detail A1 \
        "name the versioned NPU model, runner, input and expected digest; run it repeatedly while recording binding, IOMMU/MMIO ownership, clocks, power and errors" \
        "every inference output matches the expected digest and resources remain stable; unresolved MMIO ownership or EBUSY is a fail"
    operator_detail A2 \
        "name the versioned input, codec/settings and expected output checks; encode repeatedly on both VENC cores while recording device use, clocks and resets" \
        "both hardware encoder cores produce valid expected output and recover cleanly across repeated operation"
    operator_detail A3 \
        "name the versioned bitstream and expected frame/output checks; decode repeatedly while recording hardware use, clocks and resets" \
        "hardware decode produces valid expected frames and recovers cleanly across repeated operation"
}

stage_recovery() {
    say "== recovery : every recovery path, in the destructive order =="
    say "  THIS STAGE DESTROYS. Copy the run directory off the device first."
    cap rec-before-deployment -- mica-deploy status
    capf rec-board-recovery /usr/share/mica/release-identity.env
    api_get /api/v1/diagnostics/snapshots rec-diagnostics || true

    operator_step recovery \
        "walk ../user/recovery.md's current ordering, re-reading the system after each: read-only diagnosis; guarded rollback; configuration reset; application-data reset; confirm credential recovery and full factory reset are refused because BOARD_RECOVERY_ACTIONS is empty; then induce the documented invalid/exhausted native-record states, observe real RockUSB recovery, and restore the exact bound complete image from maskrom." \
        "every path in the dossier's Recovery method section restores a unit from the state it claims to handle, and the two refused rungs REFUSE -- a credential recovery or a factory reset that succeeded on this board would be a fail, not a pass. A path that could not be exercised at all records what was missing."
    operator_detail R1 \
        "exercise diagnostics, guarded rollback, configuration reset and application-data reset separately, comparing deployment, identity and namespace digests; also verify both unsupported destructive actions refuse" \
        "each operation preserves its declared survivors and credential/full-factory recovery refuse"
    operator_detail R2 \
        "induce invalid and exhausted native records, observe real RockUSB selection, then restore with the exact bound complete image from maskrom" \
        "unsigned boot and attempt refill are refused, and complete reflash restores the identified unit"
}

# ===========================================================================
# report
# ===========================================================================

last_for() {
    awk -F'\t' -v k="$1" '
        $3==k {
            r=$4; d=$5; e=$6
            if ($4=="pass" || $4=="fail") {decisive=$4; decisive_date=$5; decisive_evidence=$6}
        }
        END {
            if (decisive!="") printf "%s\t%s\t%s", decisive, decisive_date, decisive_evidence
            else if (r!="") printf "%s\t%s\t%s", r, d, e
        }
    ' "$RESULTS"
}

last_detail_for() {
    awk -F'\t' -v k="$1" '
        $3==k {
            r=$4; d=$5; e=$6
            if ($4=="pass" || $4=="fail") {decisive=$4; decisive_date=$5; decisive_evidence=$6}
        }
        END {
            if (decisive!="") printf "%s\t%s\t%s", decisive, decisive_date, decisive_evidence
            else if (r!="") printf "%s\t%s\t%s", r, d, e
        }
    ' "$DETAILS"
}

stage_for_row() {
    local entry key stage
    for entry in "${ROW_STAGE[@]}"; do
        IFS='|' read -r key stage <<<"$entry"
        if [ "$key" = "$1" ]; then printf '%s' "$stage"; return 0; fi
    done
    printf 'unknown'
}

do_report() {
    local entry key label class stage requirement found result date evidence

    printf '# cx3576 bench run %s\n\n' "$OUT"
    printf 'Collector v%s. Stages recorded as done: %s\n\n' \
        "$COLLECTOR_VERSION" "$(tr '\n' ' ' <"$STATE")"

    printf '## Qualification results\n\n'
    printf '| Row | Result | Date | Evidence / reason |\n'
    printf '|---|---|---|---|\n'
    for entry in "${ROWS[@]}"; do
        IFS='|' read -r key label <<<"$entry"
        found=$(last_for "$key")
        if [ -n "$found" ]; then
            IFS=$'\t' read -r result date evidence <<<"$found"
        else
            result="not tested"; date="—"
            evidence="not reached by this run; stage '$(stage_for_row "$key")' was not run"
        fi
        printf '| %s | %s | %s | %s |\n' "$label" "$result" "$date" "$evidence"
    done

    printf '\n## Current acceptance details\n\n'
    printf '| Id | Class | Result | Date | Requirement / evidence |\n'
    printf '|---|---|---|---|---|\n'
    for entry in "${DETAIL_ROWS[@]}"; do
        IFS='|' read -r key class stage requirement <<<"$entry"
        found=$(last_detail_for "$key")
        if [ -n "$found" ]; then
            IFS=$'\t' read -r result date evidence <<<"$found"
        else
            result="not tested"; date="—"
            evidence="not reached by this run; stage '$stage' was not run"
        fi
        printf '| %s | %s | %s | %s | %s — %s |\n' \
            "$key" "$class" "$result" "$date" "$requirement" "$evidence"
    done

    printf '\n## Gate D measurements\n\n'
    if [ -s "$MEASUREMENTS" ]; then
        printf '| Id | Stage | Finding |\n|---|---|---|\n'
        awk -F'\t' '{printf "| %s | %s | %s |\n", $3, $2, $4}' "$MEASUREMENTS"
    else
        printf 'No measurement was recorded by this run.\n'
    fi

    printf '\n## Where the evidence is\n\n'
    printf 'Run directory: `%s`\n\n' "$OUT"
    printf '```\n'
    ls -1 "$OUT" 2>/dev/null
    printf '```\n'
    printf '\nEvery capture file carries the command line and the exit status above\n'
    printf 'its output, so "the tool answered nothing", "the tool was absent" and\n'
    printf '"the tool failed" stay three different findings.\n'
}

# ===========================================================================
# dispatch
# ===========================================================================

if [ "$STAGE" = report ]; then
    do_report
    exit 0
fi

stage_assumes "$STAGE" >/dev/null || die "'$STAGE' is not a stage. Run '$0 stages'."
load_identity
if [ "$DRY_RUN" -eq 0 ] && [ ! -b "$SYSTEM_BLOCK" ]; then
    die "SYSTEM_BLOCK is not a block device on this unit: $SYSTEM_BLOCK"
fi
bind_run
EV=$(mktemp -d "$OUT/evidence/$STAGE/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX") || die "cannot allocate a new evidence capture directory"

say "=============================================================="
say "cx3576 bench collector v$COLLECTOR_VERSION -- stage '$STAGE'"
say "run directory: $OUT"
say "capture directory: $EV"
say "binding: source=$SOURCE_COMMIT image=$IMAGE_NAME sha256=$IMAGE_SHA256 target=$SYSTEM_BLOCK board=$BOARD_REVISION radio=$RADIO_SKU profile=$PROFILE"
[ "$DRY_RUN" -eq 1 ] && say "MODE: --dry-run (read-only probes; every mutation refused)"
interactive || say "MODE: no terminal on stdin -- operator steps will record 'not tested'"
say "=============================================================="

require_assumption

case "$STAGE" in
    install)     stage_install ;;
    firstboot)   stage_firstboot ;;
    inventory)   stage_inventory ;;
    warmboot)    stage_warmboot ;;
    network)     stage_network ;;
    fieldbus)    stage_fieldbus ;;
    thermal)     stage_thermal ;;
    watchdog)
        # Re-runnable: the first run arms and the board resets under it; the
        # second run, after the reset, is the one that reads the cause.
        if [ -s "$OUT/watchdog-marks.tsv" ]; then stage_watchdog_after; else stage_watchdog; fi ;;
    update)      stage_update ;;
    powercut)    stage_powercut ;;
    storagefill) stage_storagefill ;;
    display)     stage_display ;;
    accelerators) stage_accelerators ;;
    recovery)    stage_recovery ;;
    *)           die "'$STAGE' is not a stage. Run '$0 stages'." ;;
esac

mark_stage_done "$STAGE"
say ""
say "stage '$STAGE' recorded. Rows so far:"
do_report | sed -n '/^| Row /,/^$/p' | sed 's/^/  /' | tee -a "$LOG"
say ""
say "copy the run directory off the device before the next power cut:"
say "  tar -cf - -C $(dirname "$OUT") $(basename "$OUT")   # then read it on the host"
