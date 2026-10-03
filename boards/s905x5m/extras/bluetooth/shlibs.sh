#!/bin/bash
# The shlibs:Depends value of a staged tree: dpkg-shlibdeps over every ELF file under it, printed for
# `deb pack --substitute shlibs:Depends=<value>` (mica-build-tools leaves the substitution to its caller).
#
#   shlibs.sh <staged root> <package>
#
# dpkg-shlibdeps expects debian/<package>/ and a debian/control beside it; DEB_HOST_ARCH and DEB_BUILD_ARCH
# are set because dpkg-architecture otherwise asks the C compiler what it targets, and this image has none.
set -euo pipefail
root=${1:?staged root required} package=${2:?package required}
arch=$(dpkg --print-architecture)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/debian/$package"
cp -a "$root/." "$work/debian/$package/"
printf 'Source: %s\n\nPackage: %s\nArchitecture: %s\n' "$package" "$package" "$arch" >"$work/debian/control"
elves=()
while IFS= read -r -d '' f; do
    case "$(file -b "$f")" in ELF*) elves+=("$f") ;; esac
done < <(find "$work/debian/$package" -type f -print0)
[ "${#elves[@]}" -gt 0 ] || { echo "shlibs.sh: error: no ELF file is staged under $root" >&2; exit 1; }
out=$(cd "$work" && DEB_HOST_ARCH="$arch" DEB_BUILD_ARCH="$arch" dpkg-shlibdeps -O "${elves[@]}")
value=$(printf '%s\n' "$out" | sed -n 's/^shlibs:Depends=//p')
[ -n "$value" ] || { echo "shlibs.sh: error: dpkg-shlibdeps resolved no shared-library dependency" >&2; exit 1; }
printf '%s\n' "$value"
