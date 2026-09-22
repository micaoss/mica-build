# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# stages/90-pack -- close the root, then pack it: squashfs-zstd + dm-verity.
# The last link in the chain (stages/README.md says what the chain is), and the
# only stage file with more than one FROM of its own.

# inventoried/captured preserve native inputs and the configured target tree.
# closed applies the existing device policy transformations in disposable state.
# pack-tools/pack run on the build platform, preserve the installed transfer,
# select an empty runtime tree offline, then measure and pack only that tree.
# factory-root exports the selected tree; factory-checked verifies that transfer.
# artifact exports the matching verity image, inventories and debug counterparts.

# Two export surfaces, not one, because they are different kinds of thing:
# `artifact` is files the assembler consumes, `factory-root` is an image a
# runtime consumes, and buildkit exports one target per invocation. The driver
# builds factory-root second, off the cache the first filled. `closed` is not a
# stage file of its own: closing the root and packing it are one operation with
# one output, nothing else can run between them, and a stage boundary that
# nothing can ever be inserted at only costs a reader a hop.

# The link back up the chain. MICA_STAGE_PREV is the local image tag the
# previous stage was written to; the driver passes it and refuses to build a
# stage that does not declare it. There is no default, so this file cannot be
# built standalone against whatever `FROM` happened to be typed.

# MICA_IMAGE_DEBIAN_TRIXIE is this file's own base, injected from
# locks/mica-build-env.lock by tools/from.sh, and declared here because the `pack` FROM below
# is the only line in the chain that consumes it. It is pinned because the byte layout of
# the packed image depends on which squashfs-tools and cryptsetup pack it, so
# the pack tools are a decision rather than a build date. No default, so this
# file cannot be built against a floating tag.
ARG MICA_STAGE_PREV
ARG MICA_IMAGE_DEBIAN_TRIXIE
ARG MICA_IMAGE_BUILD_BASE

# The bun the composition scripts run on (src/rootfs/runtime/, TypeScript): the one binary of the pinned build-env
# base image, copied out rather than that image being the pack tools, whose squashfs-tools and cryptsetup are
# Debian trixie's by decision (see above). bun links only glibc.
FROM --platform=$BUILDPLATFORM ${MICA_IMAGE_BUILD_BASE} AS bun-source

# Close the device root: pin the account dates, inventory, log capture, purge,
# report.
FROM --platform=$BUILDPLATFORM ${MICA_IMAGE_DEBIAN_TRIXIE} AS pack-tools
RUN apt-get update && apt-get install -y --no-install-recommends \
        squashfs-tools cryptsetup-bin libcap2-bin \
        binutils-x86-64-linux-gnu binutils-aarch64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
RUN dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' | LC_ALL=C sort > /pack-tools.tsv

FROM ${MICA_STAGE_PREV} AS inventoried

# The shadow last-change day, pinned for every account.

# That field is not content anyone chose: it is the BUILD DATE, leaking into a
# signed root through Debian's own maintainer scripts. useradd stamps today
# into it, and the accounts the distribution's postinsts create --
# systemd-network, messagebus, systemd-resolve -- therefore carry the day
# the image was built. Pinning it to the same epoch the Mica OS accounts already use
# makes the field a function of the tree again.

# It is quieter than the two surfaces beside it and worse for being quiet. The
# value is a DAY, so two builds in one session agree and every same-session test
# passes; only builds straddling midnight differ. A gate that compares two roots
# would go red at random, months from now, for a reason nobody would connect to
# a calendar.

# Here rather than in stages/10-base beside account-mica.sh, because this has to
# run after the LAST apt transaction that can create an account -- the kernel
# install in stages/40-board is the last of them -- and the three Mica OS accounts
# are pinned where they are created because nothing creates them but us. Before
# the purge below, which is what takes the package manager away; `chage` itself
# ships (90-pack's purge notes list it among the setgid binaries that stay).
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/account-pin-shadow-dates.sh && \
    sha256sum /mica-scripts/account-pin-shadow-dates.sh >> /mica-build-inputs/transform-sources.sha256

# Package inventory. Split from the size measurement below because the package
# manager is removed in between: dpkg-query needs /var/lib/dpkg, and TOTAL_MB
# has to weigh the root that actually ships.
RUN dpkg-query -W -f='${Package}\t${Installed-Size}\n' > /rootfs-report.pkgs

# The image's own bill of materials, SHIPPED: /usr/share/mica/manifest.tsv.
# The purge below takes /var/lib/dpkg away, so on the device this file is the
# only record of what was installed and at which version -- and since every Mica
# OS package carries a DECLARED version (mica-podman 5.8.6-2, mica-deploy
# 0.1.0-2; decision mica:docs/decisions/2026-09-15-package-versions.md), the
# version column names a release's package rather than a commit. Sorted under
# LC_ALL=C so two builds of one set are byte-identical. Written before the purge
# for the same reason the inventory above is; verify asserts the file and its
# rows in packed-busybox-in-manifest.
RUN install -d -m 0755 /usr/share/mica && \
    { printf '#package\tversion\tarchitecture\n'; \
    dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' | LC_ALL=C sort; } \
    >/usr/share/mica/manifest.tsv && \
    cp /usr/share/mica/manifest.tsv /mica-build-inputs/manifest.tsv

# Read the configured target without running it or changing its metadata.
FROM pack-tools AS captured
RUN --network=none \
    --mount=type=bind,from=inventoried,source=/,target=/installed \
    --mount=type=bind,source=src/rootfs/runtime,target=/mica-runtime \
    mkdir /capture && \
    bun /mica-runtime/compose.ts snapshot --root /installed --output /capture/configured.json

FROM inventoried AS closed
COPY --from=captured /capture/configured.json /mica-build-inputs/configured.json



# The package-manager logs, taken out of the tree before the purge below
# removes them. They are not image content and never were -- the packed root
# ships them only because /var was moved wholesale to /usr/share/factory/var --
# but one of them is EVIDENCE, and that is why this step exists rather than a
# longer `rm -rf` list.
#
# `dpkg.log` records all 694 apt operations in the order they happened. Strip
# its timestamps and two builds are byte-identical, which is how the stage
# arrangement is checked: `../README.md` under "Running the gate", "Check the
# apt order directly", and `README.md` on why 30-feature-radios runs ahead of
# 31-feature-containers. That check compares two builds, so it cannot run
# inside one, and it needs the bytes to survive somewhere a human can reach
# them on both sides.
#
# Here rather than in the image: the tree surgery in `pack` moves this to
# /out/pkg-logs and the `artifact` stage exports it to _out/<board>/pkg-logs/,
# the same lifecycle /rootfs-report.txt already has -- produced in the root,
# moved out of it, never shipped. The comparison reads exactly the same bytes
# it read before; only where it picks them up changed. The purge refuses to run
# if this step did not, so the two cannot come apart.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/package-manager-logs-capture.sh

# The static hardware database, out of the root (PLAN-086 S4).
#
# 22.9 MB on cx3576 -- 13.5 MB of compiled /usr/lib/udev/hwdb.bin and 9.3 MB of
# the .hwdb sources it is compiled from -- for a device whose hardware is fixed
# at manufacture. What that database supplies is descriptive: vendor and model
# strings, input-device quirks, autosuspend hints for laptop peripherals. None
# of it is a device this board has, and none of it is read by anything Mica OS runs.
#
# HERE, IN `closed`, and not in `pack` below, for the reason the purge under it
# is here: this is a decision about the DEVICE ROOT rather than about the
# assembled tree, and TOTAL_MB is measured further down over the root that
# ships, so a removal after that point would leave the budget gate weighing
# bytes the image does not carry. Before the purge because the purge takes
# /var/lib/dpkg with it and the survivor checks want a root that is still a
# Debian system.
#
# THE RULE EDITS ARE THE CAREFUL PART. Thirteen shipped rule files query hwdb
# and almost all of them do something else in the same rule --
# 50-udev-default.rules assigns the tty, input and disk groups on lines that
# also import from it, 60-serial.rules builds /dev/serial/by-id, and
# 75-net-description.rules ends at IMPORT{builtin}="net_id". So the script
# removes CLAUSES, token by token, and then asserts by name that the actions
# sharing those lines are still there. A rule left with no action at all is
# dropped rather than shipped, because udev logs "takes no effect" for those.
#
# WHY NOT LEAVE THE RULES AND JUST DELETE THE DATABASE: a missing hwdb.bin does
# not make an IMPORT disappear, it makes it FAIL -- 33 failing builtin calls per
# matching uevent, forever. It also arms systemd-hwdb-update.service, whose
# conditions include `ConditionPathExists=|!/usr/lib/udev/hwdb.bin`: deleting
# the database is exactly what makes that unit start running, against a
# read-only /usr, on every boot. The unit and its enablement go with the data.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/hwdb-remove.sh && \
    sha256sum /mica-scripts/hwdb-remove.sh >> /mica-build-inputs/transform-sources.sha256

# Reconcile the enablement links with the preset policy this root SHIPS
# (PLAN-088). Here, in `closed`, and above the purge, for the same reasons the
# hwdb removal is: it is a decision about the device root, TOTAL_MB is measured
# below over the root that ships, and the purge takes /var/lib/dpkg with it.
#
# WHAT IT IS FOR, and it is not a duplicate of the preset files. A preset
# prevents a link from being WRITTEN, and mica-system's nftables rule works
# because that package is unpacked before nftables is configured. cx3576's
# getty@tty1 rule cannot work that way: systemd is configured before the board
# package carrying the rule is unpacked, so the assembled image shipped the
# preset AND the link -- measured, on the first image built with it. The preset
# remains the decision that survives a `systemctl preset-all`; this step removes
# the link the decision was too late to prevent.
#
# It reads the policy rather than naming a unit, so it is board-agnostic code
# with a board-specific effect: cx3576 ships a `disable getty@.service` rule and
# uefi-x64 does not, and uefi-x64's VC getty is therefore untouched. Measured on the
# composed cx3576 root: 37 rules, 104 enablement links examined, exactly 1
# removed.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/preset-enforce.sh && \
    sha256sum /mica-scripts/preset-enforce.sh >> /mica-build-inputs/transform-sources.sha256

# Remove package management from the packed root. Nothing can install a
# package on this device: the root is a read-only dm-verity squashfs and
# updates replace immutable signed root objects, so apt, dpkg and the perl-base dpkg
# pre-depends on are build-time tools. Shipping them costs ~21 MB of dead
# weight and hands a working package manager to anyone who reaches a shell on a
# device whose whole security model is that its root cannot change. The
# self-checks below are what make this step able to fail; a purge that silently
# removed too much would surface as a device that does not boot, days later.

# Measured before removing, not assumed. Nothing in overlay, in micad or in
# apid invokes dpkg or apt at runtime -- the only two mentions in the overlay
# are comments. Every perl script in the image is maintainer-script tooling
# that runs during installation and never after (deb-systemd-helper,
# deb-systemd-invoke, debconf-*, ucf*, and the /usr/sbin set: adduser, deluser,
# update-rc.d, pam-auth-update, pam_getenv, dpkg-fsys-usrunmess), and they are
# removed here too -- a script whose interpreter is gone is a trap, not a
# leftover. dash, grep and gzip declare `Pre-Depends: dpkg`, a packaging-time
# relation their binaries never call; gpgv is reachable only from apt-key.

# The checks test a property, not a package name -- a copyright count, a
# version glob -- because a check pinned to a version of the thing it is
# checking fails on the upgrade it exists to survive. The dangling-interpreter
# check below is a build failure and not a warning, because it is what
# enumerates the /usr/sbin set a hand survey misses. adduser and deluser are
# safe to remove for a second, independent reason: /etc/passwd is inside the
# read-only verity root (only /etc/shadow is symlinked onto STATE), so no
# account can be created on a running device whether or not the tool is there.

# The apt and dpkg timers go too. Removing /usr/bin/apt does not remove
# apt-daily.timer, apt-daily-upgrade.timer or dpkg-db-backup.timer, and all
# three are enabled by their packages into
# /etc/systemd/system/timers.target.wants. On a device with no package manager
# they fire daily and fail daily, and nothing else in the image is wrong enough
# to notice.

# linux-base's four helpers and update-initramfs are NOT in the purge list any
# more, and their absence from it is the statement. They arrived with
# linux-base, which uefi-x64 pulled in through Debian's linux-image-amd64 and cx3576
# never installed. Since PLAN-074 uefi-x64 installs mica-kernel-uefi-x64 instead -- a
# payload of a bzImage, its config and its modules, with no Depends and no
# maintainer script -- so linux-base reaches neither board and there is nothing
# to remove. A purge of paths nothing can create reads like a safeguard and is
# not one.

# /usr/share/doc is kept, deliberately, and this is where the usual "slim
# image" recipe goes wrong: it is 2.75 MB, of which 2.06 MB is 159 `copyright`
# files -- the licence texts Debian ships to satisfy the redistribution terms
# of the GPL and friends. Deleting the directory would save 0.69 MB of
# changelogs and breach those terms to do it. coreutils (17.6 MB) is kept by
# decision too: busybox would save most of it but every script in the image and
# in the verifier would then run against different tool semantics.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/package-manager-purge.sh && \
    sha256sum /mica-scripts/package-manager-purge.sh >> /mica-build-inputs/transform-sources.sha256

# Build report (moved out of the tree by the pack stage; never ships in the
# image).
#
# TOTAL_MB IS NOT MEASURED HERE ANY MORE, and the move is PLAN-086 S2's. It
# used to be taken at this line, after the purge, so that the budget gate in
# build.sh weighed the root that ships rather than the one that was built --
# and that reason is unchanged. What changed is where the shipping root is
# finished: the pack stage now strips the debug information out of the
# self-built binaries and takes the boot blobs out of the tree, roughly 95 MB
# on either board, so a number taken here would overstate what ships by that
# much and the budget gate would weigh a root nothing flashes. It is measured
# over /rootfs in `pack`, at the last moment before mksquashfs reads it, and
# appended to this same report in this same position.
RUN mv /rootfs-report.pkgs /rootfs-report.txt

# Pack: squashfs-zstd + appended dm-verity hash tree.
FROM pack-tools AS pack
# ARG is per-stage. MICA_RADIOS -- the radios the product selected, not the
# board's hardware -- is declared again here because the pack stage asserts
# properties of the assembled root that depend on it: which state directories
# are precious, and therefore which mount units must exist. Declared only in
# an earlier stage file it would expand empty here, which under `set -u` is a
# build failure rather than a check that silently reads "no radios" on a root
# that carries them.
ARG MICA_RADIOS=""
# MICA_ARCH and MICA_BOARD are declared here for the same reason, and PLAN-086 S2
# is what needs them. MICA_ARCH picks which of the two cross binutils below
# rewrites the board's ELF -- this stage runs on the BUILD platform, so the
# native objcopy is the wrong one for the tree it is pointed at. MICA_BOARD names
# the one directory under /usr/lib/mica/board/ that carries this board's boot
# blobs; a glob would find it too, and would also find a second one without
# saying which was meant.
ARG MICA_ARCH
ARG MICA_BOARD
# No initramfs-tools-core here since PLAN-074. It was installed for one
# binary, lsinitramfs, which stages/compose/scripts/pack-export-boot.sh used to list
# the exported initrd and assert veritysetup, the mica-verity script and the
# absence of busybox in it. There is no initrd on either board now -- uefi-x64's
# kernel assembles the dm-verity root from the command line, as cx3576's always
# did -- so that script asserts the absence instead and reads nothing.
# BOTH cross binutils, not the one MICA_ARCH selects. They are 60 MB together
# and this apt layer is then keyed on nothing but the base digest, so an amd64
# board and an arm64 board share it; installing only the selected one would put
# MICA_ARCH in the cache key and rebuild this layer every time the board changed.
# Transfer via tar so native hardlinks, owners, capabilities and xattrs survive.
RUN --network=none \
    --mount=type=bind,from=closed,source=/,target=/installed \
    --mount=type=bind,source=src/rootfs/runtime,target=/mica-runtime \
    mkdir /rootfs /out && \
    bun /mica-runtime/compose.ts snapshot --root /installed --output /out/closed.json && \
    bash -o pipefail -c 'tar -C /installed --numeric-owner --xattrs --xattrs-include="*" --one-file-system -cf - . | tar -C /rootfs --same-owner --xattrs --xattrs-include="*" -xf -' && \
    bun /mica-runtime/compose.ts compare --root /rootfs --snapshot /out/closed.json && \
    mv /rootfs/mica-build-inputs /out/build-inputs && \
    cp /pack-tools.tsv /out/build-inputs/pack-tools.tsv


# Guard the mica-owned files against CJK text (repo rule: code and docs are
# English). The scanned set is the overlay's mount units, seed scripts,
# repart.d definitions and fw_env.config. Only our own paths are scanned;
# vendor packages ship translations and are none of our business.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-cjk-guard.sh

# What the ASSEMBLY left behind, removed here because no package can own it.
#
# Two things today. SSH host keys: a host key in a signed rootfs is one private
# key the whole fleet shares, and a random one would move the verity root hash
# on every cold build. dropbear-bin generates none and mica-dropbear-prestart
# makes the device's key on STATE at the first start, so this is a tripwire.
# /usr/sbin/policy-rc.d: the Debian docker image ships it so that a maintainer
# script cannot start a daemon during a build, and on a device it is a file that
# answers 101 to every invoke-rc.d for a reason that stopped applying when the
# image was packed.
#
# HERE, in the finalizer, because each is a statement about the assembled root
# rather than about any one package -- and policy-rc.d comes with the BASE
# IMAGE, so there is no producer in this repository that could ship or withhold
# it. The script prints both counts, so neither number can be vacuous unseen.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-strip-build-residue.sh

# Tree surgery that cannot happen in the rootfs stage, either because buildkit
# bind-mounts the file during RUN or because it would break dpkg.
#  - /etc/resolv.conf -> /run, the only writable place with / read-only.
#  - /etc/machine-id must exist and be empty: systemd cannot write it on a
#    read-only /etc. mica-runkit (init) binds the persistent DATA identity over it
#    before executing systemd.
#  - /var supplies the initial template for the persistent DATA bind. Protected
#    state mountpoints exist before systemd creates service mount namespaces.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-tree-surgery.sh

# Assert the whole-var bind and protected DATA/state credential mounts.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-assert-var-disposable.sh

# Persistent extensions require a pre-existing mountpoint on the immutable root.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-assert-extension-dir.sh

# /etc/shadow moves onto STATE. Every device gets its own root password, and
# pam_unix reads it from /etc/shadow -- which on Mica OS sits on the dm-verity
# squashfs, where nothing can ever write it. The only writable paths under /etc
# are the /etc/hostname and other state binds, and a bind-mounted file cannot be
# replaced by rename, which is how micad writes a credential safely. So the file
# ships as a symlink into /var/lib/mica, the bind target of var-lib-mica.mount,
# whose source is /mnt/state/mica.

# The image copy is retained at /usr/share/factory/etc/shadow -- systemd's
# standard place for a factory template, the same idea this stage already uses
# for /var -- and mica-shadow-reconcile derives the STATE file from it on every
# boot. /etc/passwd and /etc/group deliberately stay in the image, read-only:
# only the secret-bearing file moves, so account definitions remain part of the
# signed, verity-covered root. Done here and not in the rootfs stage because
# every package postinst still needs a real file: a tool like chpasswd would
# follow a symlink laid down earlier and write through it.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-shadow-relocate.sh

# Assert the whole chain, at build time, so it can only pass for the intended
# artifact. Each of these is a defect that would otherwise be invisible: a
# regular /etc/shadow shadowing the symlink, a factory copy the reconciler
# cannot read, a unit installed but never enabled, an ordering directive naming
# a unit that does not exist (systemd drops those silently), or a real password
# hash baked into a rootfs that is byte-identical across the entire fleet.

# The locked-password test runs over every account in /etc/passwd, not just
# root: an empty field is not a locked marker, it is passwordless, and scoping
# the test to root would leave every other account exposed. root keeps its own
# dedicated case above it because a baked root credential is the single most
# likely way a hash reaches this file, and this assertion is what keeps the
# tree free of a ROOT_PASSWORD build arg; the loop below is the class, not the
# instance. The two failure modes get two messages on purpose: an empty field
# means the account accepts any password, while a usable hash means a
# credential that every device in the fleet shares.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-assert-shadow-chain.sh

# PLAN-086 S2 -- the two exports that take content OUT of the root, both of
# them here rather than after the pack: everything below this point measures or
# reads /rootfs, so a removal made after any of it would be a removal none of
# those numbers describe.

# Root owns userspace only. Reject boot and support payloads in this tree;
# independent kernel and firmware producers package them from explicit inputs.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    MICA_BOARD="${MICA_BOARD}" sh /mica-scripts/pack-export-boot.sh

# THE DEBUG INFORMATION. Thirteen binaries in this root carry `.debug*`,
# `.symtab` or `.strtab` -- 42.7 MB of it, and every one of the thirteen is
# built by this repository; Debian ships its own stripped. They are stripped
# here and the debug halves are written to /out/debug/.build-id/, matched to the
# binary they came from by GNU build-id, which is the note gdb and every other
# consumer of separated debug information resolves on. Kernel modules are not
# touched: their symbol tables are what the module loader relocates against.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    MICA_ARCH="${MICA_ARCH}" sh /mica-scripts/pack-export-debug.sh && \
    sha256sum /mica-scripts/pack-strip-build-residue.sh /mica-scripts/pack-tree-surgery.sh \
      /mica-scripts/pack-shadow-relocate.sh /mica-scripts/pack-export-boot.sh \
      /mica-scripts/pack-export-debug.sh >> /out/build-inputs/transform-sources.sha256

# Installation and transformations end here. Only this selected scratch tree
# reaches measurement, SquashFS and factory-root export; selection has no network.
ARG SQUASHFS_TIME
RUN --network=none \
    --mount=type=bind,source=src/rootfs/runtime,target=/mica-runtime \
    bun /mica-runtime/compose.ts compose --root /rootfs --output /runtime \
      --inputs /out/build-inputs --arch "$MICA_ARCH" --epoch "$SQUASHFS_TIME" \
      --debug /out/debug --report /out/rootfs-report.runtime.json && \
    bun /mica-runtime/select.ts verify --root /runtime --report /out/rootfs-report.runtime.json

# TOTAL_MB, measured HERE rather than in `closed`, because the two lines above
# are what finish the shipping root: a number taken before them describes a tree
# that is roughly 95 MB larger than anything this build writes to a slot, and
# build.sh's budget gate reads this number. Appended to the report in the
# position it has always occupied, so the file's shape does not move.
RUN echo "TOTAL_MB $(du -sxm /runtime | cut -f1)" >> /out/rootfs-report.txt

# Privilege inventory of the SOURCE tree, captured before packing so the packed
# image can be diffed against it. Numeric uid/gid deliberately: the tree is
# arm64 Debian but this stage runs on the build platform, whose /etc/passwd
# cannot resolve ids like _ssh or messagebus, so names would not round-trip.
# %M is the symbolic mode, which is exactly what `unsquashfs -lln` prints, so
# the two inventories are directly comparable.
RUN find /runtime -xdev -perm /6000 -printf '%M %U %G %P\n' 2>/dev/null \
        | sort > /out/privileged-src.txt

# File capabilities depend on xattrs surviving both the buildkit layer export
# and CONFIG_SQUASHFS_XATTR in the kernel, so they are recorded rather than
# assumed. This is the tripwire for the day a capability-carrying package is
# added to the allowlist.
RUN { echo; \
      echo "== file capabilities =="; \
      getcap -r /runtime 2>/dev/null | sed 's|^/runtime||' | sort; \
    } >> /out/rootfs-report.txt

# Pack, in three steps so each can carry its own explanation and cache
# independently: squash, assert, then hash.
ARG VERITY_SALT
ARG SQUASHFS_TIME
ARG VERITY_HASH_ALGO=sha256
ARG VERITY_DATA_BLOCK_SIZE=4096
ARG VERITY_HASH_BLOCK_SIZE=4096

# Step 1 -- squash. Every knob that would otherwise vary between builds is
# pinned:
#   -processors 1         multi-threaded mksquashfs is NOT byte-reproducible
#   -mkfs-time/-all-time  no wall clock in the superblock or in any inode
#   -noappend             never merge into a pre-existing image
#   -no-exports           drop the NFS export table (unused, extra bytes)

# There is deliberately no -all-root, and no -force-uid/-force-gid either. They
# rewrite ownership but NOT mode bits, so every setgid binary whose group was
# not root would ship setgid-root: ssh-agent (_ssh), chage / expiry /
# unix_chkpwd (shadow), dbus-daemon-launch-helper (messagebus). That widens a
# privilege boundary inside the one part of the system that is supposed to be
# the trustworthy part. It also breaks unix_chkpwd in the other direction: it
# needs egid shadow to read /etc/shadow, and egid root does not grant that, so
# non-root PAM password verification stops working. Ownership does not need
# forcing to be deterministic -- it comes from a pinned base image and a pinned
# package set, and step 2 is what keeps it honest.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-squashfs.sh

# Step 2 -- ownership/mode gate. mksquashfs must carry the source tree's
# uid/gid through untouched, and -all-root is exactly what breaks that. Diff
# the packed image's setuid/setgid inventory against the source inventory
# captured before packing, and fail the build on ANY difference, so this class
# of bug is a build error instead of something a reviewer has to spot.
# -lln prints numeric ids, matching how privileged-src.txt was written.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-assert-privileged.sh
RUN --network=none \
    --mount=type=bind,source=src/rootfs/runtime,target=/mica-runtime \
    unsquashfs -no-progress -d /roundtrip /out/rootfs.squashfs && \
    bun /mica-runtime/select.ts verify --root /roundtrip --report /out/rootfs-report.runtime.json

# Step 3 -- dm-verity. veritysetup gets the pinned salt, whose default is
# random, and --no-superblock, and the two are one decision: without a
# superblock there is no UUID field left to randomise, so the salt is the only
# remaining source of variation and the pack stays reproducible with one pin
# instead of two.
#
# The native early loader uses the explicit no-superblock verity geometry
# bound by the signed root descriptor. Append the tree after the SquashFS data.
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/pack-verity.sh
RUN --network=none \
    --mount=type=bind,source=src/rootfs/runtime,target=/mica-runtime \
    bun /mica-runtime/compose.ts measure-packed --root /runtime --out /out


# The factory root as an OCI image.

# Eleven artifacts in this image are built by this repository -- micad, apid,
# mica-mqttd, mica-mqtt-broker, mica-deploy, podman, quadlet, crun, conmon, netavark,
# aardvark-dns -- and "it linked" and "it runs" are different claims: a
# wrong-architecture binary, a missing soname, or a version that does not match
# the pin in mica-podman's upstream.lock all survive to first boot. The smoke runner executes
# each of them before the image ships, and an executor needs a root to execute
# them in. This is that root, in the one form a container runtime can be handed
# directly.

# /runtime is the exact selection verified before mksquashfs. Installation,
# account configuration and the existing whole-var/shadow/DNS transformations
# are finished before this tree is copied. Disposable installation databases,
# archives and debug counterparts live outside the selected tree.

# There is no `--platform` flag here, so the stage is built for TARGETPLATFORM
# and the image declares the board's architecture, which is what makes `docker
# run` reach for binfmt/qemu-user on an arm64 image. Nothing in this stage
# executes anything from the root, so producing it needs no emulation even with
# binfmt_misc unmounted. Building the arm64 root is still gated on emulation;
# exporting one is not.
FROM scratch AS factory-root
COPY --from=pack /runtime/ /

# The artifact build verifies the candidate factory stage before its OCI export.
# A lossy COPY must fail here; final OCI serialization still needs B7 extraction.
FROM pack AS factory-checked
RUN --network=none \
    --mount=type=bind,from=factory-root,source=/,target=/factory-check \
    --mount=type=bind,source=src/rootfs/runtime,target=/mica-runtime \
    bun /mica-runtime/select.ts verify --root /factory-check --report /out/rootfs-report.runtime.json

FROM scratch AS artifact
COPY --from=factory-checked /out/pkg-logs/ /pkg-logs/
COPY --from=factory-checked /out/rootfs-verity.img /
COPY --from=factory-checked /out/rootfs-verity.env /
COPY --from=factory-checked /out/rootfs-report.txt /
COPY --from=factory-checked /out/rootfs-report.runtime.json /
# What the selection left behind and why (compose.ts). It leaves the container
# because a count in a build log is read once and a file can be diffed.
COPY --from=factory-checked /out/rootfs-report.runtime.json.drops.tsv /
COPY --from=factory-checked /out/build-inputs/ /build-inputs/
COPY --from=factory-checked /out/boot/ /boot/
# The separated debug information, one `.debug` per shipped binary plus the
# manifest that names the build-id tying each to its binary. Outside the root by
# construction -- this is the whole point of the split -- and read by the image
# contract's debug-export family out of _out/<board>/debug/.
COPY --from=factory-checked /out/debug/ /debug/
