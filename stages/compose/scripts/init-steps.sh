#!/bin/sh
# Run one init's steps at one position of the composition: <init>/<position>-*.sh beside this file, in name
# order. An init with no step at a position has nothing to do there. With a record file, each step's hash is
# appended to it.
set -eu
init=${1:?init required}
position=${2:?position required}
record=${3:-}
dir="$(dirname "$0")/${init}"
[ -d "${dir}" ] || { echo "error: there are no steps for INIT=${init} (${dir})" >&2; exit 1; }
n=0
for step in "${dir}/${position}"-*.sh; do
    [ -e "${step}" ] || continue
    sh "${step}"
    [ -z "${record}" ] || sha256sum "${step}" >>"${record}"
    n=$((n + 1))
done
echo "${position}: ${n} step(s) of ${init}"
