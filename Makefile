.PHONY: product-repart-test help os-apid-api-spec-pins os-apid-api-test os-bare-host-gate os-boot-test os-boot-tools os-build-test os-components os-devkeys os-pool os-factory-root-gate os-fit-records-test os-host-toolchain-lint os-host-toolchain-lint-test os-image os-install-closure-gate os-layout-lint os-netavark-kernel-test os-quadlet-doc-test os-repart-test os-rootfs os-rootfs-manifest-test os-product-test os-board-name-lint os-board-name-lint-test product product-verify products lifecycle-uefi os-shell-pipefail-lint os-smoke-negative-test os-smoke-test os-verify os-verify-test board-fetch board-fetch-all os-pool-check os-pool-test os-offline-chain-test offline-chain

# Mica OS top-level build entry. Heavy lifting stays in each component; this file
# only routes. Board targets: make <board>-<component>, e.g. cx3576-kernel.


# The <board>-% delegation rules are NOT listed here: .PHONY does not accept
# patterns, so an entry like `cx3576-%` matches nothing and silently declares
# nothing. They stay pattern rules (unlisted) because the delegated names are
# open-ended; a stray file named e.g. `cx3576-kernel` in this directory shadows
# the delegation, which is a visible "Nothing to be done" rather than a wrong
# build.

help:
	@echo "  os-image            assemble two signed deployments (MICA_BOARD, MICA_IMAGE_RECORDS, MICA_METADATA_PUBLIC_KEYS, MICA_FIRMWARE_PACKAGE, MICA_IMAGE_OUT)"
	@echo "  product             one product's closure: fetch, compose, sign root/kernel/firmware, two deployments, the image and the update archive into _out/products/<name> (PRODUCT=<name>; reused when its receipt is unchanged)"
	@echo "  product-verify      verify that product's image against the contract"
	@echo "  lifecycle-uefi      the QEMU lifecycle suite (boot, runtime, updates, faults, reset, shutdown) over a built UEFI product (PRODUCT=<name>)"
	@echo "  products            product, for every product whose board is a release target"
	@echo "  os-rootfs           compose a product's root (PRODUCT=<name>; products/*/product.env, tools/product.sh --list)"
	@echo "  os-product-test     every product validates against its board, and each refusal of the product contract fires"
	@echo "  os-board-name-lint  no board name in the engine: the assembly dispatches on board facts, never on a name (tests/board-name-lint.sh)"
	@echo "  os-board-name-lint-test  ...and that lint goes red on a planted literal"
	@echo "  os-keys-init        detect or create development keys in meta (MICA_SIGNING_OUTPUT overrides)"
	@echo "  os-devkeys          create explicit development inputs (MICA_SIGNING_OUTPUT, default meta; refuses existing output)"
	@echo "  os-layout-lint      check the current three-partition contracts"
	@echo "  os-fit-records-test verify bounded native FIT record parsing"
	@echo "mica build targets:"
	@echo "image (signed component files on SYSTEM with unified DATA):"
	@echo "  os-boot-tools       build the UKI/systemd-boot packager image (boot/; loader from the Base pool, MICA_BOOT_TARGET=x64|aa64)"
	@echo "  os-boot-test        the boot-tools launcher, the trust domains, and the initramfs and compression in the x64 image (docker)"
	@echo "  board-fetch         read a board's bundle -- board.env, manifests, kernel, firmware, U-Boot -- out of the board artifact its board row of locks/ names into _out/boards/<board> (BOARD=<board>)"
	@echo "  board-fetch-all     the same for every board row of locks/; os-pool runs it"
	@echo "  os-components      build independent components (MICA_COMPONENT_ARGS='root|kernel|firmware|deployment|image|archive ...')"
	@echo "  os-verify verify the assembled mica image against the mica image contract (docker)"
	@echo "  os-smoke-test       execute every self-built binary inside the factory root, assert its pin (docker)"
	@echo "  os-smoke-negative-test  break that root three ways and require each to turn the run red (docker)"
	@echo "  os-factory-root-gate    prove the root the smoke run executes in is the root the device ships (docker)"
	@echo "  os-repart-test      prove first-boot repart growth grows DATA and cannot wipe the loader (privileged docker)"
	@echo "  os-host-toolchain-lint  no compiler, filesystem maker or assembler runs on the host (mica:docs/design/build.md section 0)"
	@echo "  os-host-toolchain-lint-test  plant a host invocation, a stale exemption and a broken declaration; require each red"
	@echo "  os-bare-host-gate   climb PLAN-080 section 4's ladder for real: clone HEAD into the pinned docker-cli image and build from it (docker)"
	@echo "  os-verify-test      run the verify bun+TypeScript suite (typecheck + bun test)"
	@echo "  os-build-test       run the build bun+TypeScript suite: board geometry and the toolset wrappers (docker)"
	@echo "  os-netavark-kernel-test  assert every board kernel config carries the symbols netavark programs rules against"
	@echo "  locks-verify        locks/: every lock and pin, each release's SHA256SUMS lists exactly its lock (network), every image selector resolves"
	@echo "  os-pool             fetch every archive the package rows of locks/ name out of its pool, verify it and index both pools (docker, network)"
	@echo "  os-pool-check       read every pinned archive out of its pool manifest without downloading (network)"
	@echo "  offline-chain       build products from the side-by-side checkouts' make offline builds in throw-away clones (MICA_WORKSPACE, PRODUCTS; docker, long)"
	@echo "  os-offline-chain-test  tools/offline-chain.sh over a fixture workspace: clones, order, refusals, summary (git, make)"
	@echo "  os-pool-test        tools/pool.sh against a local release server and registry: every refusal by name (docker)"
	@echo "  os-release-test     tools/release.sh: plan, collect and publish into a local registry (docker)"
	@echo "  os-board-bundle-test  the board bundle rules and the profile kernel directory over fixture bundles"
	@echo "  os-image-kinds-test the image kind executor over a fake board packer: interface, subset, double pack, refusals (docker)"
	@echo "  os-install-closure-gate  dpkg-install both pools into Base roots: closure, ldd, accounts, versions (docker)"
	@echo "  os-rootfs-manifest-test  resolve every product and every legal feature set of every board; prove each refusal and that no package is unreachable"
	@echo "  os-quadlet-doc-test run mica:docs/design/containers.md's examples through Quadlet"
# NEEDS THE arm64 POOL. The root is composed from _out/debs/arm64 now, so this
# target refuses until `make os-pool` has built it -- by name, rather than by
# compiling a component on demand. That refusal is the composer's, not this
# file's; see rootfs/build.sh.
os-rootfs:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required, e.g. make os-rootfs PRODUCT=<board>-dev; the products are: $$(bash tools/product.sh --list | tr '\n' ' ')" >&2; exit 1; }
	MICA_PRODUCT=$(PRODUCT) bash rootfs/build.sh
os-product-test:
	bash tests/product-test.sh
product:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required; the products are: $$(bash tools/product.sh --list | tr '\n' ' ')" >&2; exit 1; }
	bash tools/product-build.sh "$(PRODUCT)"
# The UEFI lifecycle suite (boot, runtime, updates, faults, reset, shutdown
# under QEMU) over a built product; tests/lifecycle-uefi/product-inputs.sh
# derives the suite's inputs from _out/products/<name>.
lifecycle-uefi:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required" >&2; exit 1; }
	bash tests/lifecycle-uefi/run.sh "$(PRODUCT)"
product-verify:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required" >&2; exit 1; }
	bash tools/product-build.sh "$(PRODUCT)" --verify
# Every product whose board is a release target, discovered from products/ and the fetched boards.
products:
	@set -e; for p in $$(bash tools/product.sh --list); do \
	    b="$$(bash tools/product.sh "$$p" | sed -n 's/^BOARD=//p')"; \
	    grep -qx 'BOARD_RELEASE_TARGET=1' "_out/boards/$$b/board.env" || { echo "products: $$p skipped, board $$b is not a release target"; continue; }; \
	    bash tools/product-build.sh "$$p"; \
	done
os-board-name-lint:
	bash tests/board-name-lint.sh
os-board-name-lint-test:
	bash tests/board-name-lint.sh --test


# THE IMAGE CONTRACT: read the assembled image back and check it against the
# contract, check by check.
#
# Needs DOCKER on a host without sgdisk/mtools/debugfs/unsquashfs/veritysetup --
# it reads them out of the pinned upstream:alpine:3.24.1. Verify the other board
# with --board.
os-verify:
	@test -n "$(MICA_BOARD)" -a -n "$(MICA_VERIFY_IMAGE)" -a -n "$(MICA_METADATA_PUBLIC_KEY_FILES)"
	bash tools/micad-pool.sh --source
	bash verify/run.sh --verify --board "$(MICA_BOARD)" --image "$(MICA_VERIFY_IMAGE)" $(foreach key,$(MICA_METADATA_PUBLIC_KEY_FILES),--public-key "$(key)")

# Every self-built binary EXECUTED inside the root that ships it, with the
# version it reports required to equal the version this repository pinned.
# `os-verify` reads the image; this one runs what is in it.
#
# THIS IS NOT THE ONLY THING THAT RUNS IT: `rootfs/build.sh` runs the same
# command as its last step, under `set -e`, so a root whose binaries do not run
# does not become an image. This target is how to ask the question on its own,
# against a root that is already built.
#
# Needs DOCKER, and for a stronger reason than the verifier does: it executes
# binaries built for the BOARD, so the host must be able to run that platform --
# which on cx3576 means binfmt_misc. It refuses rather than skipping when the
# image is absent, and refuses before concluding anything when the host cannot
# execute it. MICA_BOARD selects the board; there is no default.
os-smoke-test:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required; the smoke run executes _out/products/<name>/build/factory-root.oci" >&2; exit 1; }
	MICA_PRODUCT=$(PRODUCT) bash verify/run.sh --smoke --product $(PRODUCT)

# The three negative tests, which are a check on the check above.
#
# Each builds an image from that board's real factory root carrying one
# deliberately made defect -- a wrong-arch binary, a binary whose NEEDed library
# has been taken away, a binary that reports a version other than its pin -- and
# requires the smoke run to go red naming the RIGHT cause and taking no other
# artifact with it. Every mutation asserts its own before-and-after and fails
# the image build rather than producing an unmutated image, so a case cannot
# pass without having made its defect.
#
# It is a separate target from os-smoke-test rather than a flag on it because
# these are three image builds and three deliberate defects, and putting them in
# front of every rootfs build would make "the smoke run passed" mean two
# different things depending on which invocation produced it.
os-smoke-negative-test:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required; the negative runs break _out/products/<name>/build/factory-root.oci" >&2; exit 1; }
	MICA_PRODUCT=$(PRODUCT) bash verify/run.sh --smoke-negative --product $(PRODUCT)

# The assumption every smoke result rests on and nothing else checks: that the
# OCI image the smoke run executes in is byte-for-byte the tree the device
# ships. The two are produced by two exports of one stage, so nothing about
# their agreement is structural -- and a smoke run inside a DIFFERENT tree is a
# measurement of something that never boots.
#
# It compares the two trees four ways and then BREAKS each comparison in turn
# and requires each to go red. Needs docker (neither side is readable on the
# build host -- no unsquashfs, no getcap) and a built rootfs, like
# os-verify. MICA_BOARD selects the board; there is no default.
os-factory-root-gate:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required; the gate reads _out/products/<name>/build" >&2; exit 1; }
	bash tests/factory-root-gate/gate.sh _out/products/$(PRODUCT)/build
# Behavioural check on first-boot growth: a real systemd-repart, with discard
# enabled, over a copy of each assembled image on a loop device. It proves two
# things the image contract cannot — that growth does not wipe the Rockchip
# idbloader at LBA 64, and that the definitions the Mica OS image ships actually GROW
# DATA rather than refusing the run (a refusal looks exactly like a clean exit).
# Needs privileged docker, so it is a dedicated target rather than part of
# os-verify; it fails loudly when it cannot run rather than skipping.
os-repart-test:
	bash tests/repart-loader-test.sh "$(MICA_BOARD)" "$(MICA_VERIFY_IMAGE)" "$(MICA_VERIFY_ROOT_IMAGE)"
# The same over a built product: its board, its image and its root component.
product-repart-test:
	@test -n "$(PRODUCT)" || { echo "error: PRODUCT=<name> is required" >&2; exit 1; }
	bash -c 'eval "$$(bash tools/product.sh "$(PRODUCT)")" && bash tests/repart-loader-test.sh "$$BOARD" "_out/products/$(PRODUCT)/image/$$(awk "NR == 1 { print \$$2 }" _out/products/$(PRODUCT)/image/SHA256SUMS)" "_out/products/$(PRODUCT)/root/rootfs.img"'
# The cx3576 flash read-back, driven against a stub rkdeveloptool: the argv the
# BSP's flash targets build, the sector arithmetic they derive from
# boards/cx3576/board.env, and the failure this suite exists for -- a write that
# reports success and leaves the previous build's bytes in boot-a, which must
# turn the flash red BEFORE `rd` reboots the board into it. The old 16 MiB
# read-back is run over the same medium and required to pass, so the new
# result is attributable to the widened window rather than to the fixture.
#
# The verify bun+TypeScript suite, entered through one script.
#
# verify/run.sh finds bun, installs the dev dependencies if they are absent,
# typechecks and runs the suite -- and turns a run that asserted nothing red,
# which bun does not: `bun test` exits 0 on a test file that declares no tests.
# A host with no bun runs all of that in the container pinned as mica-build-env:base in
# locks/mica-build-env.lock, automatically and with the route announced; CI
# installs no bun, so that is the route it takes.
os-verify-test:
	bash tools/micad-pool.sh --source
	bash verify/run.sh

# The TypeScript build driver: the typed board geometry the assemblers read, and
# the Bun.$ wrappers for the toolset they drive.
#
# It needs DOCKER, which os-verify-test does not: the suite runs sgdisk, mtools,
# sgdisk, veritysetup, e2fsprogs and mtools in their pinned containers. Nothing is skipped: a tool reachable neither way is a
# failure, not a gap.
os-build-test:
	bash build/run.sh
# THE IMPORTED POOL: every archive a package row of locks/ names, read out of
# the pool manifest of its release by digest, verified by digest and by its
# control fields, then indexed. This tree builds no package; the producers
# publish theirs.
os-pool:
	bash tools/pool.sh fetch --arch amd64
	bash tools/pool.sh index --arch amd64
	bash tools/pool.sh fetch --arch arm64
	bash tools/pool.sh index --arch arm64
	bash tools/podman-pool.sh --check
	bash tools/deploy-pool.sh --check
	bash tools/board-pool.sh --fetch-all
os-pool-check:
	bash tools/pool.sh fetch --arch amd64 --check
	bash tools/pool.sh fetch --arch arm64 --check
os-pool-test:
	bash tests/pool-test.sh
# tools/release.sh: the plan over fixture releases, the collection and the publication into a local registry.
.PHONY: os-release-test
os-release-test:
	bash tests/release-test.sh
# The offline chain over a fixture workspace: clones, order, refusals and summary, without a build.
os-offline-chain-test:
	bash tests/offline-chain-test.sh
# The offline chain: products from the side-by-side checkouts' own builds (MICA_WORKSPACE, default the parent directory).
offline-chain:
	bash tools/offline-chain.sh --workspace "$(or $(MICA_WORKSPACE),..)" $(if $(PRODUCTS),--products "$(PRODUCTS)")
# The board bundle rules (kernel/dev and kernel/prod on a FIT board, one kernel/
# on a UEFI board) over fixture bundles.
.PHONY: os-board-bundle-test
os-board-bundle-test:
	bash tests/board-bundle-test.sh
# The image kind executor over a fake board packer: the builtin disk, the packer interface, the product
# subset, the release double pack and size limit, and every refusal.
.PHONY: os-image-kinds-test
os-image-kinds-test:
	bash tests/image-kinds-test.sh

# The inputs (mica:docs/design/release-lock.md): the reader passes the spec's
# vectors; every lock and pin of locks/ follows its rules and each pinned
# release's SHA256SUMS hashes to its pin and lists exactly its committed lock;
# every image selector resolves to a digest; and the presets name only packages
# the Base lock pins.
.PHONY: locks-verify
locks-verify:
	bash tests/release-lock-test.sh
	python3 tools/locks.py verify
	bash tools/from.sh --check
	bash tools/base-packages.sh check


# The INSTALL-time gates over the imported pools: dpkg installs the set
# rootfs/packages/resolve.sh yields into the Base root of the pinned
# mica-system-base release, once per architecture, and again with optional
# services declined; the three radio packages go into three separate roots.
# Nothing that reads archives can tell whether the Base root satisfies the
# closure, whether a wants-symlink lands on a unit somebody shipped, or what a
# binary reports when it is asked.
os-install-closure-gate:
	bash tests/install-closure-gate.sh

# Every shell script that enables pipefail, checked for an early-exiting reader
# on the right of a pipe. `producer | grep -q PATTERN` inverts its own answer
# there: -q exits at the first match, the producer dies of SIGPIPE, and pipefail
# hands back that failure -- so the pipeline reports "not found" BECAUSE the
# pattern was found. The rationale is at the top of the script.
os-shell-pipefail-lint:
	bash tests/shell-pipefail-lint.sh

# THE BUILD POLICY, made to fail. mica:docs/design/build.md section 0 is the rule --
# no toolchain on the host, no compilation on the host, no assembly on the host
# -- and this is what goes red when a new path breaks it. That page carried the
# claim long before anything enforced it, which is the whole reason this target
# exists: a documented rule with no check is a sentence, not a gate.
#
# It scans every tracked shell script, Makefile and workflow for a producer
# binary in command position. A file or a block that runs INSIDE an image says
# so at the site with `# mica-build-side: container -- <why>`, and the
# invocations that cannot move yet are registered in
# tests/host-toolchain-exemptions with their reasons -- where an entry matching
# NOTHING is itself a failure, so a waiver cannot outlive what it waived.
#
# No docker, no bun: bash, awk and git. It runs in the CI lane that says its
# suites need neither.
os-host-toolchain-lint:
	bash tests/host-toolchain-lint.sh

# The check on that check. Fifteen cases, each planting ONE defect in a
# throwaway git checkout and requiring the lint to go red naming it -- plus two
# that plant something legitimate and require green, because a rule whose
# findings are false positives teaches people to ignore it. Among them the
# positive control driven directly: a scan that saw no container-side producer
# at all has not found this repository's build and must not report clean.
os-host-toolchain-lint-test:
	bash tests/host-toolchain-lint-test.sh

# THE CRITERION ITSELF, RUN. `os-host-toolchain-lint` above reads the tree and
# says whether it looks compliant; this one takes a host that IS the criterion's
# host -- the pinned docker-cli image, docker and git and a busybox userland,
# plus the bash and make PLAN-080 section 1 permits -- clones HEAD into it, and
# climbs. It exists because section 9 named the absence of it as that record's
# largest risk: section 4 was run by hand once, nothing re-ran it, and the next
# path that needs a host tool would pass every static check and break the
# criterion silently.
#
# The ceiling is rungs 1-3: the docs gates, the policy lint, the board layout
# lint and the 1270-test verify suite, all with no bun on the host. It does NOT
# assemble an image -- that is rung 4 and it needs the amd64 package pool.
# tests/bare-host-gate/ladder.sh names what the lower ceiling stops covering.
#
# Needs docker and the network: it pulls the pin if it is absent and adds bash
# and make into the running container with apk.
os-bare-host-gate:
	bash tests/bare-host-gate/gate.sh

# rootfs/packages/resolve.sh over every board, profile, radio set and feature
# set this repository supports, plus the reverse direction: every package a
# producer declares has to be reachable by SOME legal resolution. That half is
# the one nothing else can see -- a package no manifest can name is simply never
# installed, and every check downstream of composition runs over the set that
# WAS. No docker and no pool: this reads manifests and the pins (tools/pool.sh rows).
os-rootfs-manifest-test:
	bash tests/rootfs-manifest-test.sh

# Explicit runtime closure and metadata preservation on small offline roots.
.PHONY: os-rootfs-runtime-test
os-rootfs-runtime-test:
	bash tools/pool.sh fetch --arch amd64
	bash tests/rootfs-runtime-test.sh

# Documentation gates (tools/docs/): the docs/README.md catalog in both
# directions, relative links, truth-status evidence, zh coverage, board
# dossiers, the /pma tracking indexes against their records, and stale terms or
# dead record citations in permanent documents.
# Every example in mica:docs/design/containers.md, fed to the aarch64 Quadlet
# generator the image ships. A configuration example nothing executes is a claim
# that cannot fail; this makes the document part of the suite.
os-quadlet-doc-test:
	bash tests/quadlet-doc-test.sh

# The container engine is built and released by micaoss/mica-podman and
# imported here through locks/mica-podman.lock; tools/podman-pool.sh takes the
# upstream.lock the pinned archives carry (what the smoke register, the
# install-closure gate and the netavark kernel check compare against) and the
# aarch64 quadlet tests/quadlet-doc-test.sh runs out of them.

# The kernel side of the same engine. netavark writes nftables rules -- masquerade,
# dnat, `fib daddr type local` -- into one inet table, and a board kernel built
# without the symbols behind any of them fails EVERY bridge network at container
# start, with nothing in this tree having noticed. cx3576 shipped exactly that
# gap: NFT_FIB_IPV4/IPV6 unset and NFT_FIB_INET absent. The list is derived from
# netavark source at the tag mica-podman's upstream.lock pins, and each entry cites the line
# that needs it. Offline, bash only.
os-netavark-kernel-test:
	bash tools/pool.sh fetch --arch amd64
	bash tools/pool.sh fetch --arch arm64
	bash tools/podman-pool.sh --check
	bash tools/board-pool.sh --fetch-all
	bash tools/board-pool.sh --source
	bash tests/netavark-kernel-config-test.sh



# x64 HAS a BSP build now, and it has exactly one target: the kernel. This
# rule used to be a refusal saying the board had none, which was true until
# PLAN-074 -- a UEFI machine's firmware provides the boot chain, so there is
# still no U-Boot and no vendor rootfs here, but the kernel is this
# repository's since it stopped being Debian's. The image is still assembled
# with `bash build/run.sh --mkimage-uefi --board x64`.

# virt-arm64, the QEMU aarch64 board, has the same one BSP target for the same
# reason x64 does: its firmware is AAVMF and provides the boot chain, so nothing
# here compiles a bootloader. The kernel IS built, and not by preference -- the
# authenticated initramfs needs built-in storage, signed verity and watchdog
# support. See boards/virt-arm64/board.env.
#
# The stem cannot collide with x64-%: a target has to begin `x64-` to match
# that rule, and `virt-arm64-kernel` does not.

# The apid API suite: boot the x64 image in QEMU with apid's port forwarded,
# wait for the daemon to answer, and drive it over a real socket. It is the
# only thing in this repository that TALKS TO apid rather than reading it --
# os-verify inspects the binary and the image, micad's own tests
# exercise handlers in-process, and neither can tell a route that exists in
# routes.rs from a route the running daemon actually serves. A session cookie
# that is missing Secure, a redirect that names a port nothing can reach, an
# auth gate that lets one route through unauthenticated: all of them are
# invisible from inside the process and obvious from outside it.
#
# IT BUILDS NOTHING and assumes _out/x64/x64-mica-latest.img already exists;
# a missing image is refused by name, with the two commands that make it. A
# target that quietly rebuilt would turn a check into a forty-minute build and
# would then be testing the tree rather than the artefact under test.
#
# THE RUN DIRECTORY IS SHARED. The harness boots out of the single fixed path
# _out/x64/.qemu, and _out is per-checkout and gitignored -- so a worktree points
# it at the checkout that built the image and TWO SUCH RUNS CANNOT GO AT ONCE:
# each overwrites the other's disk.img and the loser fails somewhere unrelated. The harness refuses to start while
# another container holds that directory rather than discovering the collision
# halfway through a nine-minute boot.
#
# `bash tests/apid-api/run.sh --dry-run` performs the preconditions and the
# network discovery and boots nothing; it is how to check the harness in
# seconds. Needs docker, and it fails loudly when it cannot run rather than
# skipping.
os-apid-api-test:
	bash tests/apid-api/run.sh

# The BUILD-TIME half of that suite, and the only part of it that runs on a
# checkout: every literal a phase pins which openapi.json ALSO states, asserted
# to agree with the document. No image, no QEMU, no network -- it reads the
# phase files' own bytes and the OpenAPI document the pinned mica-apid archive ships and compares them.
#
# It exists because os-apid-api-test above is the only thing that runs the
# phases, and it needs a built image and a nine-minute boot. A milestone that
# moved a shipped status therefore left every phase pinning the old one green
# until somebody booted the image. This target closes the part of that gap that
# needs no boot; the full black-box suite remains the runtime check.
#
# Needs bun OR docker: it runs on a host bun when there is one and in the bun
# pinned as mica-build-env:base otherwise, and says which. MICA_APID_CONTAINER=1 forces
# the pinned container.
os-apid-api-spec-pins:
	bash tests/apid-api/spec-pins.sh

os-boot-tools:
	bash tools/source.sh mica-system-base
	bash tools/pool.sh fetch --arch $(if $(filter aa64,$(MICA_BOOT_TARGET)),arm64,amd64) --packages mica-systemd-boot
	bash boot/build-tools.sh

# The boot tooling's own suites: the build-tools launcher and recipe branches
# on the host (docker only records), the three development trust domains, and
# the startup initramfs and payload compression in the x64 boot-tools image.
os-boot-test:
	bash tests/boot-startup-package-test.sh "$(CURDIR)"
	bash tests/trust-domain-hygiene-test.sh
	bash tests/lifecycle-uefi/shutdown-check-test.sh
	bash tools/pool.sh fetch --arch amd64 --packages mica-lifecycle
	env -u MICA_BOOT_TARGET $(MAKE) os-boot-tools
	bash tests/boot-tools-test.sh
	bash tests/boot-signing-test.sh

# The BSP outputs of a board -- its kernel directory, firmware, copyright and
# U-Boot -- out of the board artifact of the pinned mica-boards release into
# _out/boards/<board>/, for the kernel component, the image and the labs.
# The boards live in micaoss/mica-boards; this tree builds no kernel. Refuses an artifact built against another verity trust
# certificate than meta/verity/signer.cert.pem.
board-fetch:
	@test -n "$(BOARD)" || { echo "error: BOARD=<board> is required, the pinned boards are: $$(bash tools/board-pool.sh --list | tr '\n' ' ')" >&2; exit 1; }
	bash tools/board-pool.sh --fetch "$(BOARD)"
board-fetch-all:
	bash tools/board-pool.sh --fetch-all

# Explicit component inputs and signing material are supplied as CLI arguments.
os-components:
	bash build/run.sh --components $(MICA_COMPONENT_ARGS)

# Factory assembly consumes already-built and signed components.
MICA_SIGNING_OUTPUT ?= meta
.PHONY: os-keys-init
os-keys-init:
	bash boot/init-keys.sh --out "$(MICA_SIGNING_OUTPUT)"

os-devkeys:
	bash boot/dev-keys.sh --out "$(MICA_SIGNING_OUTPUT)"

os-image:
	@test -n "$(MICA_BOARD)" -a -n "$(MICA_IMAGE_RECORDS)" -a -n "$(MICA_METADATA_PUBLIC_KEYS)" -a -n "$(MICA_FIRMWARE_PACKAGE)" -a -n "$(MICA_IMAGE_OUT)"
	bash build/run.sh --components image --board "$(MICA_BOARD)" --records "$(MICA_IMAGE_RECORDS)" \
	  --firmware "$(MICA_FIRMWARE_PACKAGE)" --out "$(MICA_IMAGE_OUT)" $(foreach key,$(MICA_METADATA_PUBLIC_KEYS),--public-key "$(key)")

os-layout-lint:
	bash build/run.sh src/file-layout.test.ts

# firmware-io.c compiles the boards' own U-Boot file-boot sources, checked
# out at their pinned commits by tools/board-pool.sh --source.
os-fit-records-test:
	bash tools/board-pool.sh --source
	bash tests/lifecycle-uboot-fit/records.sh
	bash tests/lifecycle-uboot-fit/firmware-io.sh

# Current independent-artifact release directory, SBOM and publication gate.
.PHONY: os-release os-release-gate os-release-verify-test
os-release:
	bash build/run.sh --release assemble $(MICA_RELEASE_ARGS)

os-release-gate:
	bash build/run.sh --release gate $(MICA_RELEASE_ARGS)

os-release-verify-test:
	bash tests/release-verify-test.sh


