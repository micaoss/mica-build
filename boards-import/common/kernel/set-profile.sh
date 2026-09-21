#!/usr/bin/env bash
# mica-build-side: container. Set a configured FIT kernel tree to one image
# profile: the board's forced command line (its BOARD_CMDLINE_ARGS, already in
# CONFIG_CMDLINE) plus exactly one mica.profile=<dev|prod> token.
#
#   set-profile.sh <source-tree> <dev|prod> <make variable>...
#
# The kernel forces its built-in command line (CMDLINE_FORCE), so the profile
# the assembly signs for a product is part of the kernel. A board builds its dev
# kernel first and then sets prod in the same tree, where Kbuild recompiles only
# the objects that read CONFIG_CMDLINE and relinks the image
# (boards/README.md; `make <board>-kernel-profile-test` compares that image with
# a clean prod build). The board line is the one without any profile token, so
# setting a profile twice replaces the token instead of adding one.
set -euo pipefail
[ "$#" -ge 2 ] || { echo "usage: set-profile.sh <source-tree> <dev|prod> <make variable>..." >&2; exit 1; }
SRC="$1" PROFILE="$2"
shift 2
case "${PROFILE}" in
dev | prod) ;;
*) echo "error: '${PROFILE}' is not the image profile dev or prod" >&2; exit 1 ;;
esac
cd "${SRC}"
line="$(sed -n 's/^CONFIG_CMDLINE="\(.*\)"$/\1/p' .config)"
[ -n "${line}" ] || { echo "error: the resolved .config carries no CONFIG_CMDLINE to add the profile to" >&2; exit 1; }
board_line="$(sed -E 's/ mica\.profile=(dev|prod)$//' <<<"${line}")"
case " ${board_line} " in *" mica.profile"* | *" mica.recovery"*) echo "error: the board's command line already names mica.profile or mica.recovery: ${board_line}" >&2; exit 1 ;; esac
scripts/config --set-str CMDLINE "${board_line} mica.profile=${PROFILE}"
make "$@" olddefconfig
grep -Fqx -- "CONFIG_CMDLINE=\"${board_line} mica.profile=${PROFILE}\"" .config || { echo "error: CONFIG_CMDLINE is not the board line with mica.profile=${PROFILE} after olddefconfig" >&2; exit 1; }
grep -Fqx -- CONFIG_CMDLINE_FORCE=y .config || { echo "error: CONFIG_CMDLINE_FORCE is not set; the profile would not be enforced" >&2; exit 1; }
echo "set-profile.sh: ${PROFILE}: CONFIG_CMDLINE=\"${board_line} mica.profile=${PROFILE}\""
