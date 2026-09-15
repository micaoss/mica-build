#!/usr/bin/env bash
# Compose a product's root: the squashfs + dm-verity root image the signed
# root component takes.
# Usage: MICA_PRODUCT=<name> [MICA_ROOTFS_NO_CACHE=0|1] bash rootfs/build.sh
#
# THE PRODUCT IS THE ONE INPUT. products/<name>/product.env says which board,
# which profile, which features and components; tools/product.sh reads and
# validates it against the fetched board bundle and hands the result here.
# The variables that used to decide these things -- MICA_BOARD, MICA_PROFILE,
# WITH_MICAD, WITH_CONTAINERS, MICA_ROOTFS_WITHOUT, MICA_ROOTFS_COMPONENTS,
# MICA_META_DIR -- are refused by name below: an image is a product, declared
# before the build, not a combination of switches reconstructed after it.

# There is deliberately no ROOT_PASSWORD here. A Mica OS rootfs is a signed,
# byte-identical squashfs and the pack stage fails any build whose factory
# shadow carries a usable hash, so a baked Mica OS root password is unbuildable by
# design, not merely discouraged. Dev root access on Mica OS is the transient
# password set at runtime through micad (SetTransientRootPassword; cleared on
# the next boot by mica-shadow-reconcile) plus the serial console, whose root
# account stays locked until that password is set. See
# mica:docs/design/access.md section 4.1.

# Outputs (all under _out/<board>/). The first four are consumed by the image
# assembler, build/src/mkimage-cx3576.ts and mkimage-uefi.ts:
#   rootfs-verity.img: squashfs-zstd with the verity hash tree appended,
#     padded to a whole MiB
#   rootfs-verity.env: verity parameters, strict KEY=value
#   boot-cmdline-a.txt, boot-cmdline-b.txt: the kernel append line per slot

# The rest are records rather than assembler inputs:
#   rootfs-report.txt: package list + installed size
#   pkg-logs/: dpkg.log, alternatives.log and apt/, taken out of /var/log by
#     the finalizer before the package-manager purge removes them. They are
#     NOT in the image -- the purge takes them -- and they are kept because
#     dpkg.log with its timestamps stripped is the record of what APT
#     configured, in the order it configured it.
#   factory-root.oci: the packed root as an OCI image, in OCI-layout tar form.
#     NOT consumed by the assembler -- this is what the smoke runner executes
#     the self-built binaries in, so "it linked" and "it runs" stop being the
#     same claim. `docker load -i` it.
#   factory-root.txt: what that archive is -- ref, platform, size, sha256
#   rootfs-stages.txt: the Dockerfiles as built, in order, each with its content
#     hash and a `# declined:` line. Written by the driver over whatever
#     directory it was pointed at; it records which files ran, not what the
#     image is made of.
#   rootfs-packages.txt: the local packages installed, with the version,
#     architecture, archive sha256, source (the owning producer directory, or
#     the lock row for an imported archive), source repository and source
#     commit of each, read out of the pool index. PLAN-036 section 4's durable
#     composition record, and the one that says what this image is made of.
# rootfs/README.md, "Outputs to _out/<board>/", is the table version of this.

# Every layout constant is read from the board's board.env, out of the
# fetched board bundle under _out/boards/<board>/.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
# MICA_BOARD selects the layout, the output directory and the architecture.
# cx3576 is the default and its path is unchanged; x64 and virt-arm64 are the
# QEMU targets -- x64 so that the two things an arm64 build could not prove (a
# container actually starting, and containers.conf's values taking effect) have
# somewhere to be proven before hardware, and virt-arm64 so that the proving can
# happen on the ARCHITECTURE THE DEVICE RUNS rather than beside it.
for retired in MICA_BOARD MICA_PROFILE WITH_MICAD WITH_CONTAINERS MICA_ROOTFS_WITHOUT MICA_ROOTFS_COMPONENTS MICA_META_DIR; do
    [ -z "${!retired:-}" ] || {
        echo "error: ${retired} is set. It no longer selects anything: the product (MICA_PRODUCT=<name>, products/<name>/product.env) declares the board, the profile, the features, the components and the public manifest, and a switch beside it would be a second statement of one of them" >&2
        exit 1
    }
done
MICA_PRODUCT="${MICA_PRODUCT:-}"
[ -n "$MICA_PRODUCT" ] || {
    echo "error: MICA_PRODUCT is not set. A root is composed for a product; the products are: $(bash "$REPO_ROOT/tools/product.sh" --list | tr '\n' ' ')" >&2
    exit 1
}
# tools/product.sh refuses by name -- an unknown product, an unfetched board,
# a feature the board lacks -- so nothing is re-checked here.
PRODUCT_ENV="$(bash "$REPO_ROOT/tools/product.sh" "$MICA_PRODUCT")" || exit 1
eval "$PRODUCT_ENV"
MICA_BOARD="$BOARD"
LAYOUT_ENV="$BOARD_DIR/board.env"
# One composition per product: its root, record, inventory and build fact.
OUT_DIR="$REPO_ROOT/_out/products/${MICA_PRODUCT}/build"
MICA_PROFILE="$PROFILE"
FACTORY_SEEDED=0
[ -z "$PROVISIONING" ] || FACTORY_SEEDED=1
# Cold reproducibility checks need a cache-independent route through the same
# stages driver as an ordinary build. The driver already implements --no-cache;
# this explicit opt-in only bridges the rootfs entry point to that existing
# behavior and keeps normal developer builds cached by default.
ROOTFS_CACHE_ARGS=()
case "${MICA_ROOTFS_NO_CACHE-0}" in
0) ;;
1) ROOTFS_CACHE_ARGS=(--no-cache) ;;
*)
    echo "error: MICA_ROOTFS_NO_CACHE is '${MICA_ROOTFS_NO_CACHE}'; it must be exactly 0 or 1" >&2
    exit 1
    ;;
esac
# FEATURES ARE THE PRODUCT'S SELECTION, opt-in. `selected` is the one
# question every consumer below asks; FEATURES is what tools/product.sh
# validated.
selected() { case " $FEATURES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
echo "product: $MICA_PRODUCT -- board $MICA_BOARD, profile $MICA_PROFILE, features: ${FEATURES:-(none, the minimal image)}${COMPONENTS:+, components: $COMPONENTS}"

# The image profile, /usr/lib/mica/profile.conf, comes from the product
# (dev or prod, validated there); micad fails closed to prod when the file
# is missing.

# HOW THE ROOT IS ASSEMBLED, and there is one answer.
#
# rootfs/compose/*.Dockerfile: the Base root of the pinned mica-system-base
# release (locks/mica-system-base.lock), one dpkg transaction adding
# the selected archives of the imported pool `make os-pool` fetches, and then
# the finalizer -- 90-pack.Dockerfile beside it, which closes the root, does
# the tree surgery, runs the assertions, builds the squashfs, appends the
# verity tree and writes both export surfaces.
#
# The numbered stage chain this replaced is gone (PLAN-036 section 5, last
# paragraph): the floor, the read-only-root wiring, the four feature stages and
# the board were Dockerfile numbers standing in for package metadata, and they
# are Debian packages now. What is left is not a chain of nine files with an
# order to defend -- it is one transaction and one finalizer.

# Existence was already refused, by name and with the board list, right after
# MICA_BOARD was read -- a second check here would be a second message for one
# condition, and the earlier one is the better message.
# shellcheck source=/dev/null
. "$LAYOUT_ENV"

# The architecture, from the board definition and from nowhere else.
#
# There is no fallback and no `case` behind this: the board file is the one
# statement of its architecture (see the refusal above), so a layout that does
# not make it has to say so here rather than be assigned one. Everything
# downstream -- the package pool it composes from, the docker platform it
# builds for, the emulation it may need -- follows from this line.
if [ -z "${MICA_ARCH:-}" ]; then
    echo "error: $LAYOUT_ENV sets no MICA_ARCH. The architecture is a board fact and is deliberately not derived from the board name -- two arm64 boards and one amd64 board share nothing in their names that says so, and a name-based guess would be a guess. Without it this build would choose a package pool and a docker platform for a board that has not said which it is" >&2
    exit 1
fi
DOCKER_PLATFORM="linux/${MICA_ARCH}"

# Board console facts. These describe a board's serial console, not its
# partition layout, so each boards/<board>/board.env carries its own
# BOARD_CMDLINE_ARGS and this refuses a layout that forgot to.
# The product's budget (tools/product.sh: the board's unless the product lowers it).
if [ -z "$SIZE_BUDGET_MB" ]; then
    echo "error: $LAYOUT_ENV sets no BOARD_SIZE_BUDGET_MB. Without a budget the root can grow past its slot and the first sign would be an image that does not fit" >&2
    exit 1
fi
if [ -z "${BOARD_CMDLINE_ARGS:-}" ]; then
    echo "error: $LAYOUT_ENV sets no BOARD_CMDLINE_ARGS. The kernel command line would carry no console= at all, so the board would boot with nowhere to print why it did not" >&2
    exit 1
fi

# There is deliberately no VERITY_UUID here. The pack formats with
# --no-superblock, because the cmdline this script writes below hands dm-init a
# verity v1 table whose hash_start_block the kernel reads as the tree's top
# level -- a superblock at that offset is what the kernel reports as a corrupt
# metadata block. The UUID lived IN that superblock, so with the superblock gone
# there is nothing left for a pinned UUID to pin, and veritysetup would take the
# option and discard the value. Reproducibility is unaffected: the field that
# used to be randomised no longer exists in the image at all.

# FILE_MTIME is the touch(1) form (@epoch); mksquashfs wants bare seconds.
#
# One instant, two consumers: this value is also what the driver is given as
# --source-date-epoch, which buildkit stamps into the OCI export of the packed
# root. It was three until PLAN-074, the third being the initrd that Debian's
# kernel postinst built under 10-compose's declared SOURCE_DATE_EPOCH; there is
# no initrd on either board now. Deliberately the same number and not separate
# pinned constants -- the squashfs and the OCI image are two encodings of one
# tree, and a second epoch would be a second answer to "when was this root made"
# that nothing would reconcile. The assembler spells it this way for mkimage's SOURCE_DATE_EPOCH.
SQUASHFS_TIME=${FILE_MTIME#@}

mkdir -p "$OUT_DIR"

# Validate the package pool before resolving the OpenSSL inspection container.
POOL_DIR="$REPO_ROOT/_out/debs/$MICA_ARCH"
pool_refusal() {
    echo "error: $1" >&2
    echo "       The rootfs composer installs from _out/debs/<arch>; it does not build a package." >&2
    echo "       Fetch the locked archives, build the rest and index both with: make os-pool" >&2
    exit 1
}
[ -d "$POOL_DIR" ] ||
    pool_refusal "$POOL_DIR does not exist, so there is no $MICA_ARCH package pool to compose from."
for f in Packages SHA256SUMS manifest.txt; do
    [ -s "$POOL_DIR/$f" ] ||
        pool_refusal "$POOL_DIR/$f is missing or empty, so the pool carries no usable index. APT takes an empty Packages file without complaint, so this would install none of this repository's own packages and report success."
done
[ -d "$POOL_DIR/pool" ] ||
    pool_refusal "$POOL_DIR/pool does not exist, so the index beside it describes archives that are not there."
pool_debs=$(find "$POOL_DIR/pool" -maxdepth 1 -type f -name '*.deb' | wc -l)
[ "$pool_debs" -gt 0 ] ||
    pool_refusal "$POOL_DIR/pool holds no .deb at all."

# STALE, sense 1: the index does not describe the archives beside it.
# tools/pool.sh index writes SHA256SUMS over exactly the pool it
# indexed, so a mismatch means an archive was rebuilt or removed afterwards
# and the Packages APT would read describes a different set of bytes.
( cd "$POOL_DIR" && sha256sum --quiet -c SHA256SUMS ) >/dev/null 2>&1 ||
    pool_refusal "$POOL_DIR/SHA256SUMS does not verify against the archives beside it, so the index and the pool have come apart."
indexed=$(grep -c '^' "$POOL_DIR/SHA256SUMS")
[ "$indexed" -eq "$pool_debs" ] ||
    pool_refusal "$POOL_DIR/pool holds $pool_debs archive(s) and SHA256SUMS lists $indexed. sha256sum -c only checks the listed ones, so an archive the index has never seen would be installable and unrecorded."

# STALE, sense 2: an archive is newer than the index over it. `find -newer`
# rather than a timestamp comparison, because that is the question --
# is there any archive the index has not seen.
newer=$(find "$POOL_DIR/pool" -maxdepth 1 -type f -name '*.deb' -newer "$POOL_DIR/manifest.txt" -printf '%f ')
[ -z "$newer" ] ||
    pool_refusal "these archives are newer than $POOL_DIR/manifest.txt, so the pool was rebuilt without being re-indexed: $newer"

# STALE, sense 3. This tree builds no package: every archive in the pool is a
# package row of locks/ (tools/pool.sh rows), at the locked version and sha256,
# from the locked source repository (its Mica-Source-Repo control field); its
# source commit is the release row of that lock. Anything else -- an archive
# the lock does not name, a locked archive at another digest -- is refused,
# naming the archive. The rule is implemented ONCE, in
# rootfs/runtime/source-lineage.py, which also writes the lineage record the
# release gate re-verifies; this script hands it the inputs and repeats
# nothing.
#
# MICA_POOL_UNLOCKED="<pkg> ..." waives the digest check for named IMPORTED
# packages -- the local development loop, where a package repository builds a
# dirty archive straight into this pool. The waiver is announced here, recorded in the lineage
# record and in rootfs-packages.txt, and build/src/release-manifest.ts
# refuses such an image in the candidate and stable channels. A name that is
# not a locked package is refused: there is nothing to waive.
MICA_POOL_UNLOCKED=${MICA_POOL_UNLOCKED:-}
if [ -n "$MICA_POOL_UNLOCKED" ]; then
    echo "note: MICA_POOL_UNLOCKED waives the lock digest check for:$(printf ' %s' $MICA_POOL_UNLOCKED)"
    echo "      this root is a development root; the release gate refuses it outside the development channel"
fi
LINEAGE_STAGE="$OUT_DIR/source-lineage.json"
# This tree builds no package: the package rows of locks/ are the whole pool.
bash "$REPO_ROOT/tools/pool.sh" rows --arch "$MICA_ARCH" >"$OUT_DIR/pool-rows.tsv" ||
    pool_refusal "the package rows of locks/ for $MICA_ARCH could not be read (see above)."
python3 "$REPO_ROOT/rootfs/runtime/source-lineage.py" \
    --composition-source "$REPO_ROOT" --pool "$POOL_DIR" --arch "$MICA_ARCH" \
    --epoch "$SQUASHFS_TIME" --rows "$OUT_DIR/pool-rows.tsv" --unlocked "$MICA_POOL_UNLOCKED" \
    --output "$LINEAGE_STAGE" >/dev/null ||
    pool_refusal "the $MICA_ARCH pool did not pass the two-class rule (see the refusal above)."
locked_n=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(len(r["lock"]))' "$LINEAGE_STAGE")
echo "pool: $POOL_DIR, $pool_debs archive(s), $locked_n imported by the lock${MICA_POOL_UNLOCKED:+, unlocked:$(printf ' %s' $MICA_POOL_UNLOCKED)}"

# --- the composition's inputs: the package pool, the resolution, the context ---
#
# The composer INSTALLS; it never compiles. Everything below either reads the
# pool `make os-pool` wrote or asks rootfs/packages/resolve.sh which packages
# this build's inputs select, and every refusal here names the make target that
# produces what is missing. A composer that built a component on demand would
# make "the pool is stale" invisible -- the build would simply take longer and
# then install something the pool never held.
COMPOSE_STAGE="$OUT_DIR/compose"
PACKAGES_RECORD="$OUT_DIR/rootfs-packages.txt"
rm -rf "$COMPOSE_STAGE"
# Removed first: a record left by a previous build would describe the package
# set of an image this run did not produce, and a run that dies before the
# record is written would leave it looking current.
rm -f "$PACKAGES_RECORD"

# WHAT TO INSTALL. resolve.sh takes every input as an ARGUMENT and
# deliberately re-derives nothing: which board file was read, which
# environment variable beats which file, and how the historical WITH_*
# spellings fold into one decline list are all decided above, in this
# script, and a second copy of that logic in the resolver would be the
# second table this repository keeps deleting. `echo` unquoted is what
# turns " containers micad " into "containers micad", which is the spelling
# its --without takes.
# shellcheck disable=SC2116,SC2086 # deliberate: collapse the padded list.
RESOLVED=$(bash "$REPO_ROOT/rootfs/packages/resolve.sh" \
    --board "$MICA_BOARD" \
    --board-dir "$BOARD_DIR/manifests" \
    --features "$FEATURES" \
    --components "$COMPONENTS")
resolved_n=$(printf '%s\n' "$RESOLVED" | { grep -c . || true; })
[ "$resolved_n" -gt 0 ] ||
    { echo "error: rootfs/packages/resolve.sh printed no package and exited 0" >&2; exit 1; }

# Every resolved package has to BE in the pool, refused here rather than
# inside the composition: APT would report "unable to locate package",
# which names the package and not the producer that was never built.
# `grep -c ... >/dev/null` and never `grep -q`: this file sets pipefail, and
# a -q reader exits at the first match, so the producer on its left dies of
# SIGPIPE and the pipeline reports failure exactly when the package IS
# present. tests/shell-pipefail-lint.sh polices the same trap.
pool_names=$(grep -v '^#' "$POOL_DIR/manifest.txt" | cut -f1)
missing_pkgs=""
for p in $RESOLVED; do
    printf '%s\n' "$pool_names" | grep -cx -- "$p" >/dev/null ||
        missing_pkgs="$missing_pkgs $p"
done
if [ -n "$missing_pkgs" ]; then
    echo "error: the resolution names package(s) the $MICA_ARCH pool does not contain:$missing_pkgs" >&2
    for p in $missing_pkgs; do
        if cut -f1 "$OUT_DIR/pool-rows.tsv" | grep -cx -- "$p" >/dev/null; then
            echo "       $p is a package row of locks/: make os-pool fetches it" >&2
        else
            echo "       $p is a package row of no lock, which rootfs/packages/resolve.sh should already have refused" >&2
        fi
    done
    exit 1
fi

# No package is built here, so every row's source is the lock.
PRODUCER_DIRS=""

# Only the unchanged validated public set enters the composition: the
# product's meta/ (its public factory manifest), and the GENERATED marker of
# the signing workspace when the keys are development-grade.
bash "$REPO_ROOT/rootfs/scripts/validate-public-meta.sh" "$META_DIR"
META_STAGE="$(mktemp -d "$OUT_DIR/meta-public.XXXXXX")"
mkdir -p "$META_STAGE/usr/share/mica/meta/updates"
manifest="$META_DIR/updates/manifest.json"
install -m 0644 "$manifest" "$META_STAGE/usr/share/mica/meta/updates/manifest.json"
# THE PRODUCT, in the root: what this image is, for the verifier to scope its
# register by (features the product did not select ship nothing to check)
# and for anything on the device that asks. Beside profile.conf, in the
# read-only root, for the same reason: it describes the image.
mkdir -p "$META_STAGE/usr/lib/mica"
printf 'PRODUCT=%s\nBOARD=%s\nPROFILE=%s\nFEATURES="%s"\nCOMPONENTS="%s"\n' "$MICA_PRODUCT" "$MICA_BOARD" "$MICA_PROFILE" "$FEATURES" "$COMPONENTS" > "$META_STAGE/usr/lib/mica/product.conf"
chmod 0644 "$META_STAGE/usr/lib/mica/product.conf"
if [ -s "${MICA_SIGNING_OUTPUT:-$REPO_ROOT/meta}/GENERATED" ]; then
    install -m 0644 "${MICA_SIGNING_OUTPUT:-$REPO_ROOT/meta}/GENERATED" "$META_STAGE/usr/share/mica/meta/GENERATED"
else
    rm -f "$META_STAGE/usr/share/mica/meta/GENERATED"
fi

mkdir -p "$COMPOSE_STAGE"
cp "$LINEAGE_STAGE" "$COMPOSE_STAGE/source-lineage.json"
printf '%s\n' "$RESOLVED" > "$COMPOSE_STAGE/packages.txt"
# The public set, audited above, handed to the composition context as the
# image-relative tree it will be installed as. Copied and not bound, because
# these files have to end up IN the image.
mkdir -p "$COMPOSE_STAGE/meta-public"
cp -a "$META_STAGE/." "$COMPOSE_STAGE/meta-public/"
echo "compose: $resolved_n package(s) resolved for $MICA_PRODUCT ($MICA_BOARD/$MICA_PROFILE)"
sed 's/^/  /' "$COMPOSE_STAGE/packages.txt"

# The builder is NAMED rather than inherited -- the same BUILDX_BUILDER
# register as mica-podman's build, and the same selection. BUILDX_BUILDER wins, because a caller who names a builder has made
# a decision. With nothing named, `default` is the docker driver on every
# docker installation, and it reaches linux/${MICA_ARCH} exactly when the host
# has binfmt registered for it. When it does not, the `mica-${MICA_ARCH}`
# docker-container builder is used, whose buildkit image bundles the
# emulators and needs no host registration.
#
# What changed, and why it used to refuse here. The finalizer opens `FROM
# ${MICA_STAGE_PREV}` -- the composition's image; on the docker driver that is a
# tag in the image store, which a docker-container builder cannot read
# (measured: "pull access denied", about an image that is right there). So for a
# while a cross build needed host binfmt and this script said so with the
# `tonistiigi/binfmt` command. The driver now hands one file's output to the
# next by OCI layout on any builder that is not the docker driver -- exported
# `type=oci,tar=false` under _out/<board>/stages/ and taken as a named build
# context -- and build/src/stages-cli.ts decides which mode from the
# builder's driver. Nothing here needs to know; it only has to name a builder
# that can execute the platform.
if [ -n "${BUILDX_BUILDER:-}" ]; then
    echo "note: using the builder BUILDX_BUILDER names (${BUILDX_BUILDER})"
    BUILDER="${BUILDX_BUILDER}"
else
    # `grep -c ... >/dev/null`, not `grep -q`: this file sets pipefail, and a
    # -q grep exits as soon as it matches, so the producer dies of SIGPIPE and
    # the pipeline reports failure exactly when the platform IS present.
    # tests/shell-pipefail-lint.sh caught the regression once already.
    default_platforms="$(docker buildx inspect default 2>/dev/null || true)"
    if printf '%s\n' "${default_platforms}" | grep -c "${DOCKER_PLATFORM}" >/dev/null; then
        BUILDER=default
    else
        BUILDER="mica-${MICA_ARCH}"
        echo "note: the 'default' builder cannot reach ${DOCKER_PLATFORM} on this host; using the docker-container builder '${BUILDER}', which bundles its own emulator, and passing the composition to the finalizer by OCI layout"
        docker buildx inspect "${BUILDER}" >/dev/null 2>&1 ||
            docker buildx create --name "${BUILDER}" --driver docker-container >/dev/null
    fi
fi
BUILDER_ARGS=(--builder "${BUILDER}")

log=$(mktemp)
trap 'rm -f "$log"' EXIT
# The pack tools image, resolved out of locks/mica-build-env.lock before a long build
# starts rather than at the FROM line that consumes it. It is a multi-
# architecture index digest, so a cross build picks the right manifest.
mapfile -t FROM_ARGS < <(bash "$REPO_ROOT/tools/from.sh" \
    MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim)
# mapfile cannot fail, so its status says nothing about the process inside the
# substitution; an empty array is what a refusal looks like from here, and it
# would reach docker as a build with no --build-arg at all.
if [ "${#FROM_ARGS[@]}" -ne 2 ]; then
    echo "error: tools/from.sh did not yield the pack tools image (see its message above); this build would have run with an unpinned or missing FROM" >&2
    exit 1
fi

# THE BASE ROOT: the platform manifest of the pinned mica-system-base rootfs
# (locks/mica-system-base.lock), and the upstream lock of that release's commit,
# which says what the root carries. compose-install.sh refuses a root that does not carry
# exactly those rows before it adds anything.
BASE_ROOTFS_IMAGE=$(bash "$REPO_ROOT/tools/from.sh" --ref "mica-system-base:rootfs@${MICA_ARCH}")
bash "$REPO_ROOT/tools/source.sh" mica-system-base
BASE_SOURCE="$REPO_ROOT/_out/src/mica-system-base"

# from.sh yields `--build-arg KEY=VALUE` pairs; the driver takes `--arg KEY=VALUE`.
# Rewritten here rather than teaching from.sh a second output shape: it has one
# caller that wants docker's spelling and one that does not, and a resolver that
# formats for whoever asks is a resolver two callers have to agree with.
DRIVER_FROM_ARGS=()
for a in "${FROM_ARGS[@]}"; do
    case "$a" in --build-arg) DRIVER_FROM_ARGS+=(--arg) ;; *) DRIVER_FROM_ARGS+=("$a") ;; esac
done

# What the driver is handed: the board, the platform, the context, the output
# directory, the two pinned base images, the values the composition reads and
# the values the finalizer reads.
#
# The driver ENFORCES this list rather than trusting it: an --arg no file
# declares is refused (build/src/stages.ts, unusedArgs), because docker only
# warns about an unused --build-arg and a warning scrolls past in a build this
# size. So a stray argument is a refusal with its own name in it rather than a
# value that quietly does nothing.
#
# VERITY_UUID is deliberately absent, for the reason stated further up: the pack
# formats with --no-superblock and the UUID lived in that superblock. It is not
# merely unused -- passing it would fail the build by name.
#
# No --without either, and that is not an omission: the decline list reaches the
# image through the RESOLUTION, which names fewer packages. resolve.sh refuses a
# feature name nothing matches, with the features that exist -- so
# `MICA_ROOTFS_WITHOUT=contaners` is still a refusal and not a full image
# reported as a reduced one.
DRIVER_ARGS=(
    --board "$MICA_BOARD"
    --platform "$DOCKER_PLATFORM"
    --context "$REPO_ROOT"
    --dest "$OUT_DIR"
    ${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"}
    "${DRIVER_FROM_ARGS[@]}"
    --arg MICA_IMAGE_BASE_ROOTFS="$BASE_ROOTFS_IMAGE"
    --arg MICA_ARCH="$MICA_ARCH"
    --arg MICA_RADIOS="$RADIOS"
    --arg MICA_BOARD="$MICA_BOARD"
    --arg MICA_PROFILE="$MICA_PROFILE"
    --arg VERITY_SALT="$VERITY_SALT"
    --arg SQUASHFS_TIME="$SQUASHFS_TIME"
    --arg SOURCE_DATE_EPOCH="$SQUASHFS_TIME"
    --source-date-epoch "$SQUASHFS_TIME"
    --stages-dir "$REPO_ROOT/rootfs/compose"
    --arg COMPOSE_DIR="_out/products/$MICA_PRODUCT/build/compose"
)

# TWO DOCKERFILES, not one build. build/run.sh --build-rootfs sequences the
# *.Dockerfile files in --stages-dir in numeric order, handing each one's image
# to the next: 10-compose installs the resolved package set, and 90-pack closes
# and packs what it produced. Everything above this line -- the resolved package
# set, the layout checks, the verity parameters -- is this script's job. The
# driver decides only the order, the tags and which argument reaches which file,
# and it refuses an argument no file declares rather than letting docker warn
# about it.
# THE TWO EXPORT DIRECTORIES, EMPTIED FIRST (PLAN-086 S2). `-o type=local`
# MERGES into its destination: it writes what the stage holds and removes
# nothing that is already there. Both of these are sets whose membership is the
# point -- `boot/` is every boot input this root carried and `debug/` is one
# `.build-id/<id>.debug` per binary that was stripped -- so a file left behind
# by a previous build is a boot blob no image was assembled from, or debug
# information for a binary this image does not ship. The second is the worse
# one: a debug file that resolves a core against symbols from another build is
# a wrong answer where no file at all would have been an honest miss.
rm -rf "$OUT_DIR/boot" "$OUT_DIR/debug"

echo "rootfs: composing $MICA_BOARD on $BASE_ROOTFS_IMAGE"
# The Debian rows of the Base root for this architecture, in the name, version,
# architecture, sha256, url, consumers form the composition and the runtime
# selector read: the source rows of the Base source's locks/upstream.lock that
# packages.tsv selects for a consumer other than upstream-<root>. The packages
# pinned only for later stages (upstream-<root>) are never in the Base root.
awk -F'\t' -v arch="$MICA_ARCH" '
    FNR == NR { if (!/^#/) consumers[$1] = $2; next }
    $1 == "source" && ($3 == arch || $3 == "all") && ($2 in consumers) {
        n = split(consumers[$2], c, ","); root = 0
        for (i = 1; i <= n; i++) if (c[i] !~ /^upstream-/) root = 1
        if (root) print $2 "\t" $4 "\t" ($3 == "all" ? "all" : arch) "\t" $5 "\t" $6 "\t" consumers[$2]
    }' "$BASE_SOURCE/packages.tsv" "$BASE_SOURCE/locks/upstream.lock" | LC_ALL=C sort >"$COMPOSE_STAGE/upstream.tsv"
[ -s "$COMPOSE_STAGE/upstream.tsv" ] ||
    { echo "error: $BASE_SOURCE/locks/upstream.lock and packages.tsv name no $MICA_ARCH row of the Base root, so it could not be checked" >&2; exit 1; }
# The Debian packages mica-system-base pins for later stages that this
# selection needs (the upstream rows of locks/mica-system-base.lock), fetched and verified, and the
# units their maintainer scripts would enable, preset disabled in every root
# (rootfs/packages/presets.json). Their groups are Base's, seeded in every root.
bash "$REPO_ROOT/tools/base-packages.sh" fetch --arch "$MICA_ARCH"
bash "$REPO_ROOT/tools/pool.sh" index --arch "$MICA_ARCH"
bash "$REPO_ROOT/tools/base-packages.sh" select --arch "$MICA_ARCH" --packages "$(printf '%s ' $RESOLVED)" >"$COMPOSE_STAGE/extra.tsv"
jq -r '[.[].system[]] | unique[] | "disable " + .' "$REPO_ROOT/rootfs/packages/presets.json" >"$COMPOSE_STAGE/system.preset"
jq -r '[.[].user[]] | unique[] | "disable " + .' "$REPO_ROOT/rootfs/packages/presets.json" >"$COMPOSE_STAGE/user.preset"
echo "compose: $(grep -c . "$COMPOSE_STAGE/extra.tsv" || true) upstream package(s) beyond the Base root: $(cut -f1 "$COMPOSE_STAGE/extra.tsv" | tr '\n' ' ')"
if ! bash "$REPO_ROOT/build/run.sh" --build-rootfs \
        ${ROOTFS_CACHE_ARGS[@]+"${ROOTFS_CACHE_ARGS[@]}"} \
        "${DRIVER_ARGS[@]}" 2>&1 | tee "$log"; then
    if grep -qi 'exec format error' "$log"; then
        echo >&2
        echo "hint: the builder '${BUILDER}' could not execute ${DOCKER_PLATFORM}. On the default builder that means" >&2
        echo "      ${MICA_ARCH} emulation is not registered on this host (docker run --privileged --rm" >&2
        echo "      tonistiigi/binfmt --install ${MICA_ARCH}); on a docker-container builder, that a stage's" >&2
        echo "      base was resolved at the wrong architecture -- mica:docs/design/build-harness.md section 5.1." >&2
    fi
    exit 1
fi

# THE COMPOSITION RECORD, and it replaces rootfs-stages.txt as the durable
# statement of what this image is made of (PLAN-036 section 4). Written only
# after the build succeeded, for the reason the driver writes its own manifest
# then: a list of packages a failed build would have installed is a list of
# intentions.
#
# EVERY COLUMN IS READ OUT OF THE POOL INDEX, which tools/pool.sh index
# generated by asking dpkg-deb about each archive -- not out of a list kept
# anywhere. The one column that is not in the index is the source, and every
# archive is imported, so it is the lock. The NAME SET is not taken on trust either: the
# composition asserts inside the image that dpkg's installed local packages are
# exactly this list, in both directions, so a package that arrived through
# somebody's Depends cannot be missing from here.
#
# It is deliberately NOT staged into the image. Section 4 puts it under
# _out/<board>/, outside the packed root, which is where rootfs-stages.txt has
# always lived; inside the image it would be a second copy of facts dpkg's own
# database already carries at the point the finalizer purges it.
{
    echo "# The local packages composed into the $MICA_BOARD root, one per line."
    echo "# Read out of $POOL_DIR/manifest.txt, which tools/pool.sh index"
    echo "# generated from the archives themselves; never from a list kept by hand."
    echo "#"
    printf '#product\t%s\n' "$MICA_PRODUCT"
    printf '#board\t%s\n' "$MICA_BOARD"
    printf '#profile\t%s\n' "$MICA_PROFILE"
    printf '#features\t%s\n' "${FEATURES:-(none)}"
    printf '#components\t%s\n' "${COMPONENTS:-(none)}"
    printf '#factory-seeded\t%s\n' "$FACTORY_SEEDED"
    printf '#pool\t_out/debs/%s, %s imported by locks/\n' "$MICA_ARCH" "$locked_n"
    printf '#unlocked\t%s\n' "${MICA_POOL_UNLOCKED:-(none)}"
    printf '#package\tversion\tarchitecture\tsha256\tsource\tsource-repo\tsource-commit\n'
    for p in $RESOLVED; do
        awk -F'\t' -v pkg="$p" -v prods="$PRODUCER_DIRS" '
            $1 == pkg {
                n = split(prods, rows, ";")
                dir = "lock"
                for (i = 1; i <= n; i++) {
                    split(rows[i], kv, "=")
                    if (kv[1] == pkg) dir = kv[2]
                }
                printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $5, dir, $7, $8
            }' "$POOL_DIR/manifest.txt"
    done
} > "$PACKAGES_RECORD"
recorded=$(grep -vc '^#' "$PACKAGES_RECORD" || true)
[ "$recorded" -eq "$resolved_n" ] ||
    { echo "error: $PACKAGES_RECORD records $recorded package(s) and $resolved_n were resolved and installed. The record is read out of the pool index by name, so a short one means a name the index does not carry -- and a composition record that silently omits a package is worse than none" >&2; exit 1; }
echo
echo "=== rootfs-packages.txt ($recorded package(s)) ==="
cat "$PACKAGES_RECORD"

VERITY_ENV="$OUT_DIR/rootfs-verity.env"
IMG="$OUT_DIR/rootfs-verity.img"
REPORT="$OUT_DIR/rootfs-report.txt"
FACTORY_ROOT_OCI="$OUT_DIR/factory-root.oci"

# The OCI export, asserted here as well as in the driver, because the two
# statements are different. The driver checks the file it just wrote is not
# empty; this checks that a build which reported success left one at all -- the
# case that matters is a chain built by something OTHER than the current driver
# (an older tree, a hand-typed docker command) dropping its output into the same
# _out directory, where a stale or absent archive would be handed to the smoke
# runner as this build's root. index.json is the OCI-layout entry point, so its
# presence is what distinguishes an OCI archive from any other tar.
if [ ! -s "$FACTORY_ROOT_OCI" ]; then
    echo "error: $FACTORY_ROOT_OCI is missing or empty after a build that reported success." >&2
    echo "       the smoke run executes the self-built binaries inside this image; with no" >&2
    echo "       image there is nothing to execute them in, and an image that ships them unexecuted" >&2
    echo "       looks exactly like one whose smoke run passed." >&2
    exit 1
fi
if ! tar -tf "$FACTORY_ROOT_OCI" index.json >/dev/null 2>&1; then
    echo "error: $FACTORY_ROOT_OCI has no index.json, so it is not an OCI image layout." >&2
    echo "       Whatever wrote it did not write what \`docker load\` reads." >&2
    exit 1
fi

# Read the pack stage's output the same way the assembler does: by parsing
# KEY=value, never by sourcing a generated file.
env_get() { sed -n "s/^$2=//p" "$1" | tail -n1; }

for key in VERITY_ROOT_HASH VERITY_SALT VERITY_DATA_BLOCKS VERITY_HASH_START_BLOCK \
    VERITY_DATA_BLOCK_SIZE VERITY_HASH_BLOCK_SIZE VERITY_HASH_ALGO \
    VERITY_DATA_SECTORS SQUASHFS_BYTES IMAGE_BYTES; do
    if [ -z "$(env_get "$VERITY_ENV" "$key")" ]; then
        echo "error: $key missing from $VERITY_ENV" >&2
        exit 1
    fi
done

ROOT_HASH=$(env_get "$VERITY_ENV" VERITY_ROOT_HASH)
DATA_SECTORS=$(env_get "$VERITY_ENV" VERITY_DATA_SECTORS)
DATA_BLOCKS=$(env_get "$VERITY_ENV" VERITY_DATA_BLOCKS)
HASH_START_BLOCK=$(env_get "$VERITY_ENV" VERITY_HASH_START_BLOCK)
DATA_BLOCK_SIZE=$(env_get "$VERITY_ENV" VERITY_DATA_BLOCK_SIZE)
HASH_BLOCK_SIZE=$(env_get "$VERITY_ENV" VERITY_HASH_BLOCK_SIZE)
HASH_ALGO=$(env_get "$VERITY_ENV" VERITY_HASH_ALGO)
IMAGE_BYTES=$(env_get "$VERITY_ENV" IMAGE_BYTES)

if [ "$(env_get "$VERITY_ENV" VERITY_SALT)" != "$VERITY_SALT" ]; then
    echo "error: pack stage salt does not match the pinned VERITY_SALT" >&2
    exit 1
fi
img_bytes=$(stat -c %s "$IMG")
if [ "$img_bytes" != "$IMAGE_BYTES" ] || [ $((img_bytes % 4096)) -ne 0 ] || [ "$img_bytes" -eq 0 ]; then
    echo "error: $IMG is $img_bytes bytes, not a non-zero 4096-byte multiple matching IMAGE_BYTES=$IMAGE_BYTES" >&2
    exit 1
fi

total_mb=$(awk '/^TOTAL_MB/ {print $2}' "$REPORT")
if [ -z "$total_mb" ]; then
    echo "error: TOTAL_MB missing from $REPORT" >&2
    exit 1
fi
if [ "$total_mb" -gt "$SIZE_BUDGET_MB" ]; then
    echo "error: installed size ${total_mb} MB exceeds budget ${SIZE_BUDGET_MB} MB" >&2
    exit 1
fi
echo "installed size: ${total_mb} MB (budget ${SIZE_BUDGET_MB} MB)"

# The smoke run, and it is part of the build. A wrong-arch, missing-soname or
# version-skewed binary must fail the build, so every self-built binary is
# executed inside the base rootfs before an image ships it. That is this line:
# an image that ships them unexecuted looks exactly like one whose smoke run
# passed.

# It is here rather than in the Makefile because two make targets run this
# script, so does the CI deep lane, and anyone can run it directly; a step
# wired into the callers would be three copies to keep in step and would be
# bypassed by the fourth. The root is not handed to an assembler, to a bundle,
# or to a person, without its binaries having been executed.

# No skip and no opt-out: a flag that turned this off would make "the build
# passed" mean two things. `set -e` is what makes it a gate -- run.sh exits
# with the runner's own status, and a non-zero status here ends the build
# before $OUT_DIR is handed on. It adds no dependency this script did not
# already have: run.sh --smoke needs docker, which this script has needed since
# the first buildx line, and it needs to execute the target platform. When the
# daemon cannot, the runner executes inside the builder named here -- the one
# that just built the root, so it can execute what it built -- through one
# throwaway build per artifact. Same register, same judging, and the runner
# says which executor it used.
echo
echo "=== smoke: executing the self-built binaries inside the root just packed ==="
# The engine's pins the register reads, out of the pinned mica-podman archive of this pool.
bash "$REPO_ROOT/tools/podman-pool.sh" --check
MICA_PRODUCT="$MICA_PRODUCT" bash "$REPO_ROOT/verify/run.sh" --smoke --product "$MICA_PRODUCT" --builder "${BUILDER}"
