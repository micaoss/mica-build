#!/bin/bash
# Run acceptance orchestration with the pinned Bun and static Docker client.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
repo=$PWD
command -v git >/dev/null
git_dir=$(git --no-optional-locks rev-parse --absolute-git-dir)
common_dir=$(git --no-optional-locks rev-parse --path-format=absolute --git-common-dir)
git_dir=$(cd "$git_dir" && pwd -P)
common_dir=$(cd "$common_dir" && pwd -P)
bun=$(bash tools/from.sh --ref IMAGE_MICA_BUILD_BASE)
cli=$(bash tools/from.sh --ref IMAGE_DOCKER_CLI_28)
stamp=$(printf '%s\n%s\n%s\n' "$bun" "$cli" "$(sha256sum verify/Dockerfile)" | sha256sum | cut -c1-16)
image="ai-agent/mica-acceptance-bun:$stamp"
if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker build --label ai-agent=true -t "$image" \
        --build-arg "MICA_BUN_IMAGE=$bun" --build-arg "MICA_DOCKER_CLI_IMAGE=$cli" \
        -f verify/Dockerfile verify
fi
host_path() {
    case "$1" in
        /work/*) printf '/srv/station/work/%s\n' "${1#/work/}";;
        /root/*) printf '/srv/station/root/%s\n' "${1#/root/}";;
        *) printf '%s\n' "$1";;
    esac
}
# sourceIdentity resolves the gitfile before opening its own read-only Toolbox.
# Protect metadata in the outer container too, including an ordinary .git dir.
identity_mounts=(-v "$(host_path "$common_dir"):$common_dir:ro")
if [[ "$git_dir" != "$common_dir" && "$git_dir" != "$common_dir/"* ]]; then
    identity_mounts+=(-v "$(host_path "$git_dir"):$git_dir:ro")
fi
if [[ -f "$repo/.git" ]]; then
    identity_mounts+=(-v "$(host_path "$repo/.git"):$repo/.git:ro")
fi
docker run --rm --label ai-agent=true --network traefik \
    -v "$(host_path "$repo"):$repo" "${identity_mounts[@]}" -v /var/run/docker.sock:/var/run/docker.sock \
    -w "$repo" "$image" bun "$@"
