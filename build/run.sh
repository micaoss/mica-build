#!/usr/bin/env bash
# Current component producers and their build gate.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
MODE=suite
case "${1:-}" in
--help|-h)
    echo 'Usage: build/run.sh [test filters]'
    echo '       build/run.sh --components COMMAND [options]'
    echo '       build/run.sh --release assemble|gate [options]'
    echo '       build/run.sh --build-rootfs [options]'
    echo '       build/run.sh --compare-roots [options]'
    exit 0;;
--components) MODE=components; shift;;
--release) MODE=release; shift;;
--build-rootfs) MODE=build-rootfs; shift;;
--compare-roots) MODE=compare-roots; shift;;
--*) echo "error: unknown build mode: $1" >&2; exit 2;;
esac
BUN=${MICA_BUILD_BUN:-}
DOCKER=${MICA_BUILD_DOCKER:-docker}
command -v "$DOCKER" >/dev/null
if [ -n "$BUN" ] && [ "${MICA_BUILD_CONTAINER:-0}" = 1 ]; then
    echo 'error: select MICA_BUILD_BUN or MICA_BUILD_CONTAINER' >&2; exit 2
fi
if [ -z "$BUN" ] && [ "${MICA_BUILD_CONTAINER:-0}" != 1 ]; then
    BUN=$(command -v bun || true)
    if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
fi
if [ -n "$BUN" ]; then
    command -v "$BUN" >/dev/null
    run_bun() { (cd "$HERE" && "$BUN" "$@"); }
    echo "build: $($BUN --version) at $BUN"
else
    bun_image=$(bash "$REPO_ROOT/tools/from.sh" --ref IMAGE_MICA_BUILD_BASE)
    cli_image=$(bash "$REPO_ROOT/tools/from.sh" --ref IMAGE_DOCKER_CLI_28)
    stamp=$(printf '%s\n%s\n%s\n' "$bun_image" "$cli_image" "$(sha256sum "$HERE/Dockerfile")" | sha256sum | cut -c1-16)
    tools_image="ai-agent/mica-build-bun:$stamp"
    if ! "$DOCKER" image inspect "$tools_image" >/dev/null 2>&1; then
        "$DOCKER" build --label ai-agent=true -t "$tools_image" \
            --build-arg "MICA_BUN_IMAGE=$bun_image" --build-arg "MICA_DOCKER_CLI_IMAGE=$cli_image" \
            -f "$HERE/Dockerfile" "$HERE"
    fi
    case "$REPO_ROOT" in
    /work/*) host_project="/srv/station/work/${REPO_ROOT#/work/}";;
    /root/*) host_project="/srv/station/root/${REPO_ROOT#/root/}";;
    *) host_project=$REPO_ROOT;;
    esac
    run_bun() {
        "$DOCKER" run --rm --label ai-agent=true --network traefik \
            -v "$host_project:$host_project" -v /var/run/docker.sock:/var/run/docker.sock \
            -w "$host_project/build" -e MICA_BUILD_DOCKER=docker "$tools_image" bun "$@"
    }
    echo "build: in $bun_image (pinned container)"
fi
[ -d "$HERE/node_modules" ] || run_bun install --frozen-lockfile
run_bun run typecheck
case "$MODE" in
components) run_bun run src/component-cli.ts "$@";;
release) run_bun run src/release-cli.ts "$@";;
build-rootfs) run_bun run src/stages-cli.ts "$@";;
compare-roots) run_bun run src/compare-roots-cli.ts "$@";;
suite)
    mkdir -p "$REPO_ROOT/.tmp"
    output=$(mktemp "$REPO_ROOT/.tmp/build-suite.XXXXXX")
    result=0
    run_bun test "$@" 2>&1 | tee "$output" || result=$?
    [ "$result" = 0 ] || exit "$result"
    grep -Ec '^Ran [1-9][0-9]* test' "$output" >/dev/null || { echo 'error: no build tests executed' >&2; exit 1; }
    ;;
esac
