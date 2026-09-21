#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
collector=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/collect.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
check() {
    if ! "$@" >/dev/null; then
        printf 'FAIL: %s\n' "$*" >&2
        failures=$((failures + 1))
    fi
}

help=$work/help.txt
bash "$collector" --help >"$help"
check grep -F -- '--identity FILE' "$help"
check grep -F -- '--api URL' "$help"
if grep -F 'https://127.0.0.1' "$collector" >/dev/null; then
    printf 'FAIL: collector still carries a guessed API endpoint\n' >&2
    failures=$((failures + 1))
fi
check grep -F -- 'display' "$help"
check grep -F -- 'accelerators' "$help"

report_out=$work/report
mkdir -p "$report_out"
bash "$collector" --out "$report_out" report >"$work/report.md"
detail_rows=$(awk '
    /^## Current acceptance details$/ {inside=1; next}
    inside && /^## / {inside=0}
    inside && /^\| [A-Z][A-Z0-9]* \|/ {count++}
    END {print count+0}
' "$work/report.md")
if [ "$detail_rows" -ne 39 ]; then
    printf 'FAIL: expected 39 current acceptance detail rows, got %s\n' "$detail_rows" >&2
    failures=$((failures + 1))
fi
check grep -F '| D5 | optional |' "$work/report.md"
detail_unique=$(awk '
    /^## Current acceptance details$/ {inside=1; next}
    inside && /^## / {inside=0}
    inside && /^\| [A-Z][A-Z0-9]* \|/ {print $2}
' "$work/report.md" | sort -u | wc -l)
if [ "$detail_unique" -ne 39 ]; then
    printf 'FAIL: expected 39 unique current acceptance detail IDs, got %s\n' "$detail_unique" >&2
    failures=$((failures + 1))
fi
detail_ids=$(awk '
    /^## Current acceptance details$/ {inside=1; next}
    inside && /^## / {inside=0}
    inside && /^\| [A-Z][A-Z0-9]* \|/ {printf "%s%s", separator, $2; separator=" "}
' "$work/report.md")
expected_ids='I1 B1 B2 B3 B4 W1 W2 R1 R2 U1 U2 U3 U4 U5 U6 P1 P2 P3 P4 P5 P6 P7 S1 S2 D1 D2 D3 D4 D5 A1 A2 A3 N1 N2 N3 F1 F2 F3 F4'
if [ "$detail_ids" != "$expected_ids" ]; then
    printf 'FAIL: current acceptance IDs differ\nexpected: %s\nactual:   %s\n' \
        "$expected_ids" "$detail_ids" >&2
    failures=$((failures + 1))
fi

printf '%s\n' \
    $'1\tdisplay\tD1\tfail\t2026-09-10\tconnected display failed' \
    $'2\tdisplay\tD1\tnot tested\t—\tlater operator absent' >"$report_out/details.tsv"
printf '%s\n' \
    $'1\tfirstboot\tcold-boot\tfail\t2026-09-10\tcold boot failed' \
    $'2\tfirstboot\tcold-boot\tnot tested\t—\tlater cycle absent' >"$report_out/results.tsv"
bash "$collector" --out "$report_out" report >"$work/report-with-history.md"
check grep -F '| Cold boot | fail | 2026-09-10 | cold boot failed |' "$work/report-with-history.md"
check grep -F '| D1 | mandatory | fail | 2026-09-10 |' "$work/report-with-history.md"

missing_identity_out=$work/missing-identity
mkdir -p "$missing_identity_out"
if bash "$collector" firstboot --dry-run --out "$missing_identity_out" \
    >"$missing_identity_out/stdout.log" 2>"$missing_identity_out/stderr.log"; then
    printf 'FAIL: collector accepted a bench stage without --identity\n' >&2
    failures=$((failures + 1))
else
    check grep -F 'requires --identity FILE' "$missing_identity_out/stderr.log"
fi

identity=$work/identity.env
printf '%s\n' \
    'SOURCE_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    'SOURCE_TREE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    'IMAGE_NAME=mica-cx3576-20260910-120000.img' \
    'IMAGE_SHA256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' \
    'VERIFICATION_RECORD=/operator/evidence/image-verify.log' \
    'PROFILE=dev' \
    'BOARD_REVISION=CX3576-Z' \
    'RADIO_SKU=AIC8800D80' \
    'SYSTEM_BLOCK=/dev/mmcblk0' >"$identity"

stub=$work/bin
mkdir -p "$stub"
printf '%s\n' '#!/usr/bin/env bash' \
    'case "$*" in' \
    '  "is-system-running"*) echo degraded; exit 1 ;;' \
    '  "list-units --failed"*) echo "optional-example.service loaded failed failed optional"; exit 0 ;;' \
    '  "show -p Result --value mica-health.service") echo success; exit 0 ;;' \
    '  *) exit 0 ;;' \
    'esac' >"$stub/systemctl"
printf '%s\n' '#!/usr/bin/env bash' \
    'case "${1:-}" in' \
    '  booted) printf "%064d\n" 0 | tr " " a ;;' \
    '  *) echo "native status" ;;' \
    'esac' >"$stub/mica-deploy"
printf '%s\n' '#!/usr/bin/env bash' \
    'if [[ "$*" == *"mica-health"* ]]; then' \
    '  echo "required set: boot-settled micad apid"' \
    '  echo "required member boot-settled: OK"' \
    '  echo "required member micad: OK"' \
    '  [ "${STUB_HEALTH:-good}" = bad ] || echo "required member apid: OK"' \
    'fi' >"$stub/journalctl"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$1" >>"$STUB_SLEEP_LOG"' >"$stub/sleep"
printf '%s\n' '#!/usr/bin/env bash' \
    '[ "$#" -eq 8 ] && [ "$7" = s ] && [ -z "$8" ]' >"$stub/busctl"
printf '%s\n' '#!/usr/bin/env bash' \
    'if [ "${STUB_HEALTH:-good}" = dead-api ]; then exit 22; fi' \
    'if [ "${STUB_HEALTH:-good}" = late-api ] && [ -s "$STUB_SLEEP_LOG" ]; then exit 22; fi' \
    'printf "ok\n"' >"$stub/curl"
chmod +x "$stub"/*

run_firstboot() {
    local mode=$1 out=$work/firstboot-$1
    mkdir -p "$out"
    printf '%s\n' install >"$out/stage.state"
    STUB_HEALTH=$mode STUB_SLEEP_LOG=$out/sleep.log \
        PATH="$stub:/usr/bin:/bin" \
        bash "$collector" firstboot --dry-run --identity "$identity" \
            --api https://bench-fixture.invalid \
            --out "$out" >"$out/stdout.log" 2>"$out/stderr.log"
}

if run_firstboot good; then
    check grep -F $'\tgreen\t' "$work/firstboot-good/cycles-cold.tsv"
    check grep -Fx 180 "$work/firstboot-good/sleep.log"
    check grep -F 'optional-example.service' "$work/firstboot-good/stdout.log"
else
    printf 'FAIL: required-health good fixture did not run\n' >&2
    failures=$((failures + 1))
fi

if run_firstboot dead-api; then
    check grep -F $'\tred\t' "$work/firstboot-dead-api/cycles-cold.tsv"
else
    printf 'FAIL: unavailable live API fixture did not run\n' >&2
    failures=$((failures + 1))
fi

if run_firstboot late-api; then
    check grep -Fx 180 "$work/firstboot-late-api/sleep.log"
    check grep -F $'\tred\t' "$work/firstboot-late-api/cycles-cold.tsv"
else
    printf 'FAIL: API loss after the stability window fixture did not run\n' >&2
    failures=$((failures + 1))
fi

if timeout 5 bash "$collector" --identity >"$work/missing-value.log" 2>&1; then
    printf 'FAIL: collector accepted a missing option value\n' >&2
    failures=$((failures + 1))
else
    check grep -F 'missing value for --identity' "$work/missing-value.log"
fi

if STUB_HEALTH=good STUB_SLEEP_LOG=$work/firstboot-good/sleep.log \
    PATH="$stub:/usr/bin:/bin" \
    bash "$collector" firstboot --dry-run --identity "$identity" \
        --api https://different-bench.invalid --out "$work/firstboot-good" \
        >"$work/api-rebind.stdout" 2>"$work/api-rebind.stderr"; then
    printf 'FAIL: collector accepted a changed API endpoint in one run\n' >&2
    failures=$((failures + 1))
fi
check grep -Fx 'DRY_RUN=1' "$work/firstboot-good/exact-image.env"

before_captures=$(find "$work/firstboot-good/evidence" -name cold-end-deployment.txt | wc -l)
run_firstboot good
after_captures=$(find "$work/firstboot-good/evidence" -name cold-end-deployment.txt | wc -l)
check test "$after_captures" -gt "$before_captures"
check test "$(wc -l <"$work/firstboot-good/cycles-cold.tsv")" -eq 1

identity_other=$work/identity-other.env
sed 's/^IMAGE_SHA256=.*/IMAGE_SHA256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/' \
    "$identity" >"$identity_other"
if STUB_HEALTH=good STUB_SLEEP_LOG=$work/firstboot-good/sleep.log \
    PATH="$stub:/usr/bin:/bin" \
    bash "$collector" firstboot --dry-run --identity "$identity_other" \
        --out "$work/firstboot-good" >"$work/rebind.stdout" 2>"$work/rebind.stderr"; then
    printf 'FAIL: collector accepted a different image binding in one run directory\n' >&2
    failures=$((failures + 1))
else
    check grep -F 'already bound to a different exact image or target' "$work/rebind.stderr"
fi

if run_firstboot bad; then
    check grep -F $'\tred\t' "$work/firstboot-bad/cycles-cold.tsv"
else
    printf 'FAIL: required-health bad fixture did not run\n' >&2
    failures=$((failures + 1))
fi

check grep -F 'zero byte and inode limits' "$collector"
check grep -F 'maskrom' "$collector"
if grep -F 'complete latest rescue image' "$collector" >/dev/null; then
    printf 'FAIL: collector still asks for a rescue image\n' >&2
    failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
    printf 'CX3576_BENCH_COLLECTOR_FAIL: %s assertion(s) failed\n' "$failures" >&2
    exit 1
fi
printf 'CX3576_BENCH_COLLECTOR_PASS: explicit binding, current health/storage/recovery policy and 39-row detail report verified\n'
