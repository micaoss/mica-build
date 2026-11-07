#!/bin/bash
# Delta transfer on a device (mica-core:docs/mica-core.md 6.3 "Delta transfer"), over the runtime image a product
# already booted: the next build's root, served over HTTP with the transfer index of every object and its chunks as a
# release publishes them (src/release/transfer.ts), is fetched by mica-deploy from the chunks it lacks. The host
# reads what the guest asked the origin for and prints the bytes fetched beside the bytes of the whole objects.
#
#   bash tests/suites/lifecycle-uefi/delta.sh <runtime evidence> <cert> <key> <runkit> <board>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
certificate=${2:?public content certificate required}
key=${3:?external content key required}
runkit=${4:?compiled mica-runkit required}
board=${5:?board required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test ! -e "$evidence/offline"
out="$evidence/delta"
rm -rf "$out" "$evidence/www"
mkdir -p "$out"

# The next build: the same tree with one file changed, repacked and signed as generation 3 (update.ts root).
timeout 900s bun tests/suites/lifecycle-uefi/update.ts "$evidence" "$certificate" "$key" 3 root "$evidence/root" "$evidence/kernel" "$runkit" >&2
mv "$evidence/offline" "$out/deploy-3"
next=$(cat "$out/deploy-3/expected-id")
timeout 600s bun tests/suites/lifecycle-uefi/core-catalog.ts "$evidence/www/update" http://10.0.2.2:8000/update/ \
    --product "$out/deploy-3" --objects "$evidence/kernel" --transfer >&2

mkdir -p "$evidence/offline"
cat >"$evidence/offline/actions.sh" <<ACTIONS
r=\$(mica-deploy --max-bytes 536870912 fetch --source http://10.0.2.2:8000/update/) || fail 'the fetch of the served deployment'
echo "fetch: \$r"
echo "\$r" | grep -F '$next' >/dev/null || fail 'the fetch did not stage the served deployment $next'
echo "FILE_AB_STEP_PASS: delta over \$booted"
ACTIONS
docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
    -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
    bash /harness/boot.sh image/disk.img writable 300 "$arch" >"$out/fetch.log" 2>&1 || true
cp "$evidence/www.log" "$out/www.log"
rm -rf "$evidence/offline"
grep -F 'FILE_AB_STEP_PASS: delta' "$out/fetch.log" >/dev/null && grep -F FILE_AB_RUNTIME_PASS "$out/fetch.log" >/dev/null \
    || { echo "FAIL: the delta step did not pass; see $out/fetch.log" >&2; tail -n 60 "$out/fetch.log" >&2; exit 1; }

# What the guest asked for: the objects it lacked are those whose index it read; it fetched their indexes, the chunks
# it did not hold, and no whole object.
size() { stat -c %s "$evidence/www/update/$1"; }
paths=$(grep -o '"GET /update/[^ ]* HTTP/1.[01]" 200' "$out/www.log" | sed 's|^"GET /update/||; s| HTTP.*||')
missing=$(printf '%s\n' "$paths" | sed -n 's|^objects/\([0-9a-f]\{64\}\)\.index$|\1|p' | sort -u)
[ -n "$missing" ] || { echo "FAIL: the guest read no transfer index; see $out/www.log" >&2; exit 1; }
whole=0; for o in $missing; do whole=$((whole + $(size "objects/$o"))); done
fetched=0; requests=0
for p in $(printf '%s\n' "$paths" | grep -E '^(objects|chunks)/'); do fetched=$((fetched + $(size "$p"))); requests=$((requests + 1)); done
chunks=$(printf '%s\n' "$paths" | grep -c '^chunks/' || true)
if printf '%s\n' "$paths" | grep -cE '^objects/[0-9a-f]{64}$' >/dev/null; then echo "FAIL: the guest fetched a whole object; see $out/www.log" >&2; exit 1; fi
echo "objects lacked: $(echo "$missing" | wc -w), $whole bytes whole"
echo "fetched: $fetched bytes in $requests requests ($chunks chunks), $((fetched * 100 / whole))% of the whole objects"
[ $((fetched * 4)) -lt "$whole" ] || { echo "FAIL: the delta fetched a quarter or more of the whole objects" >&2; exit 1; }
rm -rf "$evidence/www"
echo "DELTA_PASS: $next fetched by delta, $fetched of $whole bytes"
