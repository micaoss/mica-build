#!/usr/bin/env bash
# mica-build-side: container -- index a pool directory: Packages, SHA256SUMS and manifest.txt over pool/*.deb.
#
# Run by src/pool/pool.ts (`bun src/cli.ts pool index --arch <arch>`) in mica-build-env:base, where
# dpkg-scanpackages and dpkg-deb are: /dist is the pool directory, /work/rows the package rows of locks/ and of
# this tree's own producers (package, version, architecture, sha256, repository, commit, file), ARCH the pool's
# architecture. An archive that is no row is refused by name. The block src/cli.ts pool index ran inline until
# 2026-09-22, unchanged.
set -euo pipefail
mapfile -t debs < <(cd pool && find . -maxdepth 1 -type f -name "*.deb" -printf "%f\n" | LC_ALL=C sort)
dpkg-scanpackages --multiversion pool >Packages 2>/dev/null
[ -s Packages ] || { echo "pool: error: empty Packages" >&2; exit 1; }
(printf "pool/%s\n" "${debs[@]}" | xargs -r sha256sum) >SHA256SUMS
{
    echo "# The imported package pool for ${ARCH}, read out of the archives by src/pool/pool.ts index."
    printf "#package\tversion\tarchitecture\tinstalled-size\tsha256\tfile\tsource-repo\tsource-commit\n"
    for d in "${debs[@]}"; do
        p="$(dpkg-deb -f "pool/$d" Package)"; a="$(dpkg-deb -f "pool/$d" Architecture)"
        pin="$(awk -F"\t" -v p="$p" -v a="$a" '$1 == p && $3 == a' /work/rows)"
        [ -n "$pin" ] || { echo "pool: error: pool/$d is not a package row of locks/" >&2; exit 1; }
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$p" "$(dpkg-deb -f "pool/$d" Version)" "$a" "$(dpkg-deb -f "pool/$d" Installed-Size)" \
            "$(sha256sum "pool/$d" | cut -d" " -f1)" "pool/$d" "$(printf "%s" "$pin" | cut -f5)" "$(printf "%s" "$pin" | cut -f6)"
    done
} >manifest.txt
