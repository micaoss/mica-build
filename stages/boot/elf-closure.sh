#!/bin/bash
# mica-build-side: container -- copy a target ELF closure without executing target-architecture programs.
#
#   bash /tools/elf-closure.sh <runtime> <destination> <x64|aa64> <source> <target>
#
# The ELF file at <source> lands at <destination>/<target>, and with it every shared library it needs and the
# interpreter it names, each found under the target root <runtime> in the loader's directories; the
# dependencies are read with the image's readelf. Shell rather than TypeScript, by the rule's own exception:
# the packager image is x86-64 by design and runs under emulation on an arm64 host (src/image/kernel-package.ts),
# and a JIT runtime does not survive that emulation (bun 1.4.2 aborted there in CI run 35728952530, where the
# same file as elf-closure.ts had packed every amd64 product). The Python it replaces ran there because the
# interpreter has no JIT. Rule for rule and message for message the Python's (elf-closure.py, 2026-09-22).
set -euo pipefail
runtime=$1 destination=$2 architecture=$3
case "$architecture" in
    x64) machine=62 triplet=x86_64-linux-gnu ;;
    aa64) machine=183 triplet=aarch64-linux-gnu ;;
    *) echo "KeyError: '$architecture'" >&2; exit 1 ;;
esac
# The work list is a stack, as the Python's was: two parallel arrays, the last entry taken first.
pending_source=("$4") pending_target=("$5")
declare -A copied=()

find_library() { # <name>: prints the file under the runtime and its target path, or fails by name
    local name=$1 directory
    for directory in "usr/lib/$triplet" "lib/$triplet" "usr/lib/$triplet/systemd" usr/lib lib; do
        if [ -f "$runtime/$directory/$name" ]; then
            printf '%s\n%s\n' "$runtime/$directory/$name" "/$directory/$name"
            return 0
        fi
    done
    echo "Missing target library: $name" >&2
    return 1
}

while [ "${#pending_source[@]}" -gt 0 ]; do
    last=$((${#pending_source[@]} - 1))
    source=${pending_source[$last]} target=${pending_target[$last]}
    unset "pending_source[$last]" "pending_target[$last]"
    pending_source=("${pending_source[@]+"${pending_source[@]}"}") pending_target=("${pending_target[@]+"${pending_target[@]}"}")
    [ -z "${copied[$target]+x}" ] || continue
    # \x7fELF, 64-bit, little-endian, and e_machine (bytes 18-19) the target's.
    read -r -a header <<<"$(head -c 20 "$source" | od -An -v -tu1 | tr -s ' \n' ' ')"
    if [ "${#header[@]}" -lt 20 ] || [ "${header[0]}" != 127 ] || [ "${header[1]}" != 69 ] || [ "${header[2]}" != 76 ] \
        || [ "${header[3]}" != 70 ] || [ "${header[4]}" != 2 ] || [ "${header[5]}" != 1 ] \
        || [ "$((header[18] + header[19] * 256))" != "$machine" ]; then
        echo "Wrong ELF architecture: $source" >&2
        exit 1
    fi
    output="$destination/${target#/}"
    mkdir -p "$(dirname "$output")"
    cp "$source" "$output"
    chmod 0755 "$output"
    copied[$target]=1
    while IFS= read -r library; do
        mapfile -t found < <(find_library "$library")
        [ "${#found[@]}" -eq 2 ] || exit 1
        pending_source+=("${found[0]}") pending_target+=("${found[1]}")
    done < <(readelf -d "$source" | sed -n 's/.*(NEEDED).*\[\([^]]*\)\].*/\1/p')
    while IFS= read -r interpreter; do
        mapfile -t found < <(find_library "$(basename "$interpreter")")
        [ "${#found[@]}" -eq 2 ] || exit 1
        pending_source+=("${found[0]}") pending_target+=("$interpreter")
    done < <(readelf -l "$source" | sed -n 's/.*\[Requesting program interpreter: \([^]]*\)\].*/\1/p')
done
