#!/bin/sh
# Install the selected local packages, and the upstream packages beyond the Base
# root they need, into the Base root with dpkg.
# mica-build-side: container -- runs in the composition stage, whose root is the Base root.
set -eu
fail() { echo "error: $*" >&2; exit 1; }
for v in MICA_ARCH MICA_BOARD MICA_PROFILE SOURCE_DATE_EPOCH; do
    eval "value=\${${v}:-}"
    [ -n "$value" ] || fail "$v is empty or unset"
done
POOL="/mica-debs/${MICA_ARCH}"
LIST=/mica-compose/packages.txt
for f in Packages SHA256SUMS manifest.txt; do
    [ -s "$POOL/$f" ] || fail "$POOL/$f is missing or empty; build the pool with make os-pool"
done
(cd "$POOL" && sha256sum -c SHA256SUMS) >/dev/null
[ -s "$LIST" ] || fail "$LIST is missing or empty"
WANT="$(tr '\n' ' ' <"$LIST")"
WANT_N="$(grep -c . "$LIST")"
printf '%s\n' '#!/bin/sh' 'exit 101' >/usr/sbin/policy-rc.d
chmod 0755 /usr/sbin/policy-rc.d

# The Base root is the upstream half: it carries exactly the upstream rows of
# its release's lock (upstream.tsv, written by rootfs/build.sh from the Base
# source at the release commit), checked before anything is added so a root
# that is not that release is refused before it is changed.
while IFS="$(printf '\t')" read -r name version arch sha url consumers; do
    actual=$(dpkg-query -W -f='${Version}\t${Architecture}\t${db:Status-Status}' "$name" 2>/dev/null || true)
    [ "$actual" = "$(printf '%s\t%s\tinstalled' "$version" "$arch")" ] ||
        fail "the Base root does not carry $name $version $arch from its release lock"
done </mica-compose/upstream.tsv

# The Debian packages Base pins for later stages that the selection needs
# (the upstream rows of locks/mica-system-base.lock): their bytes and control fields against the rows.
set --
while IFS="$(printf '\t')" read -r name version arch sha url consumers; do
    archive="/mica-upstream/${sha}.deb"
    [ "$(sha256sum "$archive" | cut -d' ' -f1)" = "$sha" ] || fail "$archive is not the pinned $name $version $arch"
    [ "$(dpkg-deb -f "$archive" Package Version Architecture | tr '\n' ' ')" = "Package: $name Version: $version Architecture: $arch " ] ||
        fail "$archive does not say Package $name, Version $version, Architecture $arch"
    set -- "$@" "$archive"
done </mica-compose/extra.tsv

# The units their maintainer scripts would enable, preset disabled before dpkg
# runs: deb-systemd-helper applies presets, so no enablement link is written.
install -D -m 0644 /mica-compose/system.preset /usr/lib/systemd/system-preset/40-mica-build.preset
install -D -m 0644 /mica-compose/user.preset /usr/lib/systemd/user-preset/40-mica-build.preset

# The local half: every selected archive out of the imported pool. One the Base
# root already carries at the same version (mica-system and its siblings) is
# skipped by dpkg. dpkg itself refuses a Pre-Depends or Depends that the root
# and the set do not satisfy, naming the package.
for p in ${WANT}; do
    filename=$(awk -v package="$p" 'BEGIN { RS=""; FS="\n" }
        { name=""; file=""; for(i=1;i<=NF;i++) {
            if($i ~ /^Package: /) name=substr($i,10);
            if($i ~ /^Filename: /) file=substr($i,11);
        } if(name==package) print file }' "$POOL/Packages")
    case "$filename" in pool/*.deb) ;; *) fail "invalid archive path for $p: $filename";; esac
    case "$filename" in *..*) fail "unsafe archive path for $p";; esac
    [ -f "$POOL/$filename" ] || fail "missing archive for $p: $filename"
    set -- "$@" "$POOL/$filename"
done
export DEBIAN_FRONTEND=noninteractive
dpkg --unpack --skip-same-version "$@"
dpkg --configure -a

# Configuration must satisfy the declared dependencies and finish every trigger.
audit="$(dpkg --audit 2>&1)" ||
    fail "dpkg --audit exited non-zero: ${audit}"
[ -z "${audit}" ] ||
    fail "dpkg --audit reports packages that are not fully installed: ${audit}"


# Compare both local and upstream installed names and versions to the inputs.
sed -n 's/^Package: //p' "$POOL/Packages" | LC_ALL=C sort -u >/mica-compose/pool.names
local_n=0
while IFS= read -r p; do
    st="$(dpkg-query -W -f='${db:Status-Status}' "$p" 2>/dev/null || true)"
    [ "$st" = installed ] || continue
    local_n=$((local_n + 1))
    case " $WANT " in *" $p "*) ;; *) fail "unselected local package was installed: $p";; esac
done </mica-compose/pool.names
for p in ${WANT}; do
    st="$(dpkg-query -W -f='${db:Status-Status}' "$p" 2>/dev/null || true)"
    [ "$st" = installed ] || fail "resolved package was not installed: $p"
done
[ "$local_n" -eq "$WANT_N" ] || fail "installed local package count differs from the selection"
while IFS="$(printf '\t')" read -r name version arch sha url consumers; do
    actual=$(dpkg-query -W -f='${Version}\t${Architecture}\t${db:Status-Status}' "$name")
    [ "$actual" = "$(printf '%s\t%s\tinstalled' "$version" "$arch")" ] || fail "installed upstream package differs from lock: $name"
done </mica-compose/upstream.tsv
while IFS="$(printf '\t')" read -r name version arch sha url consumers; do
    actual=$(dpkg-query -W -f='${Version}\t${Architecture}\t${db:Status-Status}' "$name" 2>/dev/null || true)
    [ "$actual" = "$(printf '%s\t%s\tinstalled' "$version" "$arch")" ] || fail "upstream package $name $version $arch from locks/mica-system-base.lock was not installed"
done </mica-compose/extra.tsv
extra_n="$(grep -c . /mica-compose/extra.tsv || true)"
TOTAL_N="$(dpkg-query -W -f='.\n' | grep -c .)"
[ "$TOTAL_N" -eq "$((local_n + extra_n + $(wc -l </mica-compose/upstream.tsv)))" ] || fail 'unlocked package was installed'
# From here on the upstream identity is both halves: the Base root's rows and the upstream rows beyond it.
cat /mica-compose/extra.tsv >>/mica-compose/upstream.tsv
echo "compose: ${local_n} local and ${extra_n} upstream package(s) installed, ${TOTAL_N} packages in the root"

META_INSTALLED=""
meta_install() {
    install -D -m 0644 "/mica-compose/meta-public/$1" "/$1"
    META_INSTALLED="${META_INSTALLED} $1"
}

[ -s /mica-compose/meta-public/usr/share/mica/meta/updates/manifest.json ] ||
    fail "/mica-compose/meta-public/usr/share/mica/meta/updates/manifest.json is missing or empty. It is staged from meta/updates/manifest.json and it is where this image says which server its updates come from, on which channel and against which package signing key; an image without it has no configuration to read and no anchor to check a package against"
meta_install usr/share/mica/meta/updates/manifest.json

# The product the root is composed for (rootfs/build.sh writes it): the
# verifier reads it to scope its register, so a root without it is refused.
[ -s /mica-compose/meta-public/usr/lib/mica/product.conf ] ||
    fail "/mica-compose/meta-public/usr/lib/mica/product.conf is missing or empty; rootfs/build.sh writes it for every product"
meta_install usr/lib/mica/product.conf

# THE DEVELOPMENT-GRADE MARKER, whose ABSENCE IS THE SUPPORTED STEADY STATE and
# not an error. The two refusals above are the right shape for a required file
# and the wrong shape for this one: "missing -> fail" here would refuse every
# build made on production material, which is every release build.
#
# The condition read is the STAGED tree and nothing else. rootfs/build.sh has
# already enforced tree -> staged (the conditional entry is staged iff meta/
# carries it, and B1 counts what was resolved), and verify's
# packed-meta-is-the-public-set enforces tree -> image in both directions. So
# this step's job is staged -> image, exactly, and reading meta/ from in here
# would be reading a directory this container cannot see.
#
# STAGED AND EMPTY IS STILL AN ERROR, and it is the one case worth a line:
# build.sh treats an empty source as absent and never stages it, so a zero-byte
# or non-regular file at this path is one that was damaged between that audit
# and here -- and a marker that states nothing would be baked into the verity
# root as though it stated the grade.
#
# BOTH DISPOSITIONS ARE ANNOUNCED. This is the only member of the set whose
# correct behaviour includes doing nothing, and in a log a silent nothing reads
# exactly like the line that was never written.
META_MARKER=/mica-compose/meta-public/usr/share/mica/meta/GENERATED
if [ -e "${META_MARKER}" ]; then
    { [ -f "${META_MARKER}" ] && [ -s "${META_MARKER}" ]; } ||
        fail "${META_MARKER} exists and is empty or is not a regular file. rootfs/build.sh stages meta/GENERATED only when it has content and refuses a staged path that is not a regular file, so this is not the tree it audited; the marker is what says the signing material behind this image is development-grade, and an unreadable one is baked into the dm-verity root saying nothing"
    meta_install usr/share/mica/meta/GENERATED
    echo "compose: /usr/share/mica/meta/GENERATED installed -- this image was built on DEVELOPMENT-GRADE signing material, it reports that grade on GET /api/v1/system/info, and the release gate refuses to publish it to candidate or stable"
else
    echo "compose: no /usr/share/mica/meta/GENERATED -- meta/ carries no development-grade marker, so this image states production-grade signing material by shipping none. Not an error: that is what a production build looks like"
fi

# THE NAMED SET RECONCILED AGAINST THE STAGED SET, which is the safeguard the
# comment above costs. Every file build.sh staged was named on one of the lines
# above or it was not, and one that was not is a public-set entry that reached
# this build and stopped here: audited, copied, and then dropped, with every
# build-side check still reporting it as staged.
#
# NOT A WALK-INSTALL. Nothing is installed because it was found; the staged
# tree decides only whether this build STOPS. The allowlist in build.sh and the
# named lines above remain the two reviewed places a public file passes through.
meta_unnamed=""
for staged in $(find /mica-compose/meta-public -mindepth 1 ! -type d | sort); do
    rel="${staged#/mica-compose/meta-public/}"
    case " ${META_INSTALLED} " in
    *" ${rel} "*) ;;
    *) meta_unnamed="${meta_unnamed} ${rel}" ;;
    esac
done
[ -z "${meta_unnamed}" ] ||
    fail "rootfs/build.sh staged public-set file(s) this script installs nowhere:${meta_unnamed}. Each member of the set is named on its own line here, so a staged file with no line is an entry that was added to META_PUBLIC and not here -- it is audited and copied into the build and then dropped, and the image ships without it while the build log reports it staged. Add the line, or take the entry out of META_PUBLIC"
echo "compose: $(echo ${META_INSTALLED} | wc -w) public-set file(s) installed from meta/ --${META_INSTALLED}"


# NO INITRAMFS, asserted where the kernel and the root it must mount are
# finally in one tree together.
#
# This block used to assert the opposite. Until PLAN-074 x64 ran Debian's
# generic kernel, which has no CONFIG_DM_INIT and therefore ignored the
# dm-mod.create= verity table on the kernel command line; an initramfs
# re-implemented it, and what was checked here was that the initrd the kernel
# package's postinst had just built carried veritysetup and the local-top
# script. mica-kernel-x64 carries the device mapper, dm-verity and squashfs
# built in and reads that command line itself, so there is no initrd, no hook
# and no postinst run to get wrong.
#
# WHAT REPLACES IT IS NOT NOTHING. An absence proves itself only if something
# was there to look at, so this asserts three things rather than one: that the
# root carries exactly one kernel and the config it was built from, that the
# config declares the verity floor BUILT IN, and that no initrd file exists
# beside it. The first two are what would go red if Debian's kernel ever came
# back into this image -- its config has CONFIG_DM_INIT nowhere at all -- and
# the third is RFCT-281's guarantee in its stronger form: BusyBox cannot be an
# early-boot dependency of an image whose early boot has no userspace.
#
# Gated on a kernel being IN the root, which is an x64 fact: cx3576's kernel
# comes from its BSP and sits on the boot partition, so there is nothing here
# to look at. rootfs/scripts/pack-export-boot.sh makes the same assertions over
# what is EXPORTED; this one is earlier and names the cause.
if ls /boot/vmlinuz-* >/dev/null 2>&1; then
    kernels="$(ls /boot/vmlinuz-* | wc -l)"
    [ "${kernels}" = 1 ] ||
        fail "the composed root carries ${kernels} kernels in /boot. Which one the bootloader launches is not a question this composition can answer, and the assertions below would be about whichever sorted first"
    release="$(ls /boot/vmlinuz-* | sed 's|.*/vmlinuz-||')"
    [ -f "/boot/config-${release}" ] ||
        fail "the composed root carries /boot/vmlinuz-${release} and no /boot/config-${release} beside it. Nothing in the image then states how that kernel was configured, and the verity floor below cannot be read at all -- which is also what a distribution kernel installed by accident looks like"
    for option in DM_INIT BLK_DEV_DM DM_VERITY SQUASHFS; do
        grep -q "^CONFIG_${option}=y\$" "/boot/config-${release}" ||
            fail "/boot/config-${release} does not declare CONFIG_${option}=y. This board boots root=/dev/dm-0 from a dm-mod.create= table with no initramfs, so a kernel that has this as a module -- or, as Debian's amd64 kernel has CONFIG_DM_INIT, not at all -- assembles no root and hangs at rootwait with nothing on the console explaining why"
    done
    initrds="$(ls /boot/initrd.img-* /boot/initrd-* 2>/dev/null | tr '\n' ' ')"
    [ -z "${initrds}" ] ||
        fail "the composed root carries an initramfs: ${initrds}. Nothing here is supposed to build one -- the board ships no initramfs-tools hook and the bootloader passes no initrd -- so something reintroduced initramfs-tools and a kernel postinst that fires it, and early boot has grown a userspace this image does not verify"
    echo "compose: kernel ${release} carries the verity floor built in and the root has no initramfs (${kernels} kernel, 0 initrd)"
else
    echo "compose: no kernel in /boot; this board's bootloader is given its kernel by the BSP build"
fi

# Capture native ownership and archive identities before build-state disposal.
sh /mica-scripts/compose-capture.sh

# Everything the composition brought in that the device must not carry. The
# package-manager purge in the finalizer takes /etc/apt wholesale, so the
# source file below is belt and braces; policy-rc.d lives in /usr/sbin, which
# the purge does not sweep, and would ship as a file that makes every
# invoke-rc.d on the device refuse.
rm -f /usr/sbin/policy-rc.d
rm -rf /mica-compose /var/lib/apt/lists/* /var/cache/apt/archives
[ ! -e /usr/sbin/policy-rc.d ] ||
    fail "policy-rc.d survived; the image would refuse every invoke-rc.d on the device"

# /tmp is IMAGE CONTENT until the finalizer replaces it, so a scratch file left
# here ships in the signed root. This is not hypothetical: the first composed
# root carried /tmp/pool.names, and the dual-build gate reported it as an
# `added` path. The count is printed rather than the check being silent,
# because "nothing was left" and "nothing was looked at" are the same output
# otherwise.
tmp_left="$(find /tmp -mindepth 1 | wc -l)"
[ "${tmp_left}" -eq 0 ] ||
    fail "${tmp_left} path(s) are left under /tmp after composition: $(find /tmp -mindepth 1 | tr '\n' ' '). /tmp is image content here, so each one would ship inside the signed root"
echo "compose: /tmp is empty; no build-time scratch ships in the root"
