# mica-boards: the boards of Mica OS -- uefi-x64, uefi-arm64, cx3576, s905x5m --
# one directory each under boards/: the board definition, its kernel and
# U-Boot builds, its package inputs, the evidence and the board's tests
# (boards/README.md). This file routes: `make <board>-<target>` delegates to
# boards/<board>/Makefile, `make pool` packs every producer (producers/ and the
# boards' extras/), `make publish` releases them together.

# THE INPUTS: locks/ (mica:docs/design/release-lock.md). locks/mica-build-env.lock
# with locks/pins/mica-build-env.pin is the mica-build-env release's lock,
# committed unchanged (`make deps` verifies it against that release): every
# base image, read only by tools/from.sh. locks/upstream.lock pins the
# third-party trees and archives the boards build from, read by tools/upstream.sh. The packaging, gate and publisher are this repository's own
# (tools/deb/), and so are the shared kernel, U-Boot, trust and package inputs
# (common/).

# The boards, discovered: a directory with a board.env. Nothing here names one.
BOARDS := $(patsubst boards/%/board.env,%,$(wildcard boards/*/board.env))

.PHONY: help deps deps-check vectors-sync-test locks-test mirror-test logo-fixtures-test floor-fixtures-test preflight pool package-gate offline publish publish-test version-guard-test ci-outputs-test trust-stage-test uboot-env-test board-contract-test kernel-config-test kernel-cmdline-test bench-collector-test mac-stable-test can-network-test gadget-configfs-test flash-verify-test wireless-test lint check

help:
	@echo "  deps                verify locks/ against the releases it pins; deps-check checks it offline"
	@echo "  <board>-<target>    delegate to boards/<board>/Makefile (kernel, kernel-config, firmware; a board's own: uboot-mica, uboot, uboot-package, userland)"
	@echo "  kernels, firmware   the same for every discovered board (what release.yml builds)"
	@echo "                      a kernel embeds the verity trust certificate: VERITY_TRUST_CERT (default meta/verity/signer.cert.pem)"
	@echo "  pool                every producer of every board, both architectures, indexed into _out/debs; POOL_BOARD=<board> that board's producers only"
	@echo "  package-gate        the package gate over that pool"
	@echo "  offline             the whole build of this clean checkout, nothing published: kernels, firmware, both gated pools, _out/boards/<board>/<component>/ trees with their inputs hashes (docker)"
	@echo "  publish             the release's board: its pool and components into the mica-boards package (pool.<board>.<arch>.<YYYYMMDD-HHMM>, <component>.<board>.<YYYYMMDD-HHMM>, reusing unchanged components), read back anonymously, then mica-boards.lock and SHA256SUMS on the release <board>.<YYYYMMDD-HHMM> (CI, from a release checkout)"
	@echo "  trust-stage-test    common/trust/stage.sh validates and stages a public certificate bundle, and refuses anything else (docker)"
	@echo "  uboot-env-test      the FIT loaders' environment entry decodes the assembly's layout and round-trips (docker)"
	@echo "  ci-outputs-test     tools/ci-outputs.sh: one or several workflow artifacts unpack the same, a missing one is refused"
	@echo "  publish-test        the publishers and the lock writer against a local registry container: component and pool tags, reuse, every refusal (docker)"
	@echo "  version-guard-test  package versions against a local registry on the uefi-x64 producer: unchanged reused, bumped built, refusals (docker)"
	@echo "  board-contract-test every board declares BOARD_FEATURES and its images.tsv, carries its own kernel and U-Boot build and manifests/, and is listed in boards/boards.tsv with its outputs.tsv"
	@echo "  kernel-config-test  every board's committed kernel config carries the shared floor (common/kernel/kernel-config-test.sh)"
	@echo "  locks-test          the lock checker over the release-lock vectors, the committed locks and every Dockerfile's syntax pin"
	@echo "  vectors-sync-test   tests/vectors/ against mica at tools/vectors.pin, both directions (network)"
	@echo "  lint                shell hygiene of the tree"
	@echo "  check               lint, board-contract-test, kernel-config-test and every board's own tests"

deps:
	bash tools/locks.sh verify
deps-check:
	bash tools/locks.sh check
locks-test:
	bash tests/locks-test.sh
# The one gate here that reaches the network, so it sits beside deps rather than
# in check: tests/vectors/ is mica's vector directory at tools/vectors.pin minus
# the paths tests/vectors/excluded.tsv declares, compared as blobs both ways.
vectors-sync-test:
	bash tests/vectors-sync-test.sh
# The fetch-time mirror hook, against a local server that serves mica-res's
# contract: no network, and the fallback is what most cases prove.
mirror-test:
	bash tests/mirror-hook-test.sh
# The negative half of the logo equivalence: every real board carries all five
# artefacts, so the refusal is exercised over synthetic boards instead.
logo-fixtures-test:
	bash tests/logo-equivalence-fixtures.sh

# The negative half of the shared kernel floor: every real board holds it, so
# both loops of common/kernel/floor-check.sh are exercised over synthetic
# source trees instead.
floor-fixtures-test:
	bash tests/floor-check-fixtures.sh

# The <board>-% delegation rules, one per discovered board (pattern rules,
# unlisted in .PHONY, which takes no patterns): the delegated names are
# open-ended, and a new board gets its rule the day its board.env lands.
define board_delegation
$(1)-%:
	$$(MAKE) -C boards/$(1) $$*
endef
$(foreach b,$(BOARDS),$(eval $(call board_delegation,$(b))))

# Every discovered board's kernel, and every board's firmware where the board
# has one: what a release builds, with no board typed into a workflow.
.PHONY: kernels firmware
kernels: $(BOARDS:%=%-kernel)
firmware: $(BOARDS:%=%-firmware)

preflight:
	bash tools/deb/preflight.sh $(if $(POOL_BOARD),--board $(POOL_BOARD))

# Every producer this tree declares, for every architecture its producer.env
# names, read from tools/deb/producers.sh rather than listed here.
# POOL_ARCH=<amd64|arm64> builds and indexes one pool (its producers and the
# `all` ones), what a native per-architecture CI job runs. POOL_BOARD=<board>
# builds only the producers of that board's packages (boards/boards.tsv), what
# a board's release runs.
POOL_ARCH ?=
POOL_BOARD ?=
pool: preflight
	@set -e; \
	$(if $(POOL_BOARD),bash tools/boards.sh producers $(POOL_BOARD),bash tools/deb/producers.sh) | while read -r producer dir arches packages enablement; do \
	    for arch in $$(printf '%s' "$$arches" | tr ',' ' '); do \
	        [ -z "$(POOL_ARCH)" ] || [ "$$arch" = "$(POOL_ARCH)" ] || [ "$$arch" = all ] || continue; \
	        echo "bash tools/deb/build.sh --producer $$producer --arch $$arch"; \
	        bash tools/deb/build.sh --producer "$$producer" --arch "$$arch"; \
	    done; \
	done
	@for a in $(if $(POOL_ARCH),$(POOL_ARCH),$(if $(POOL_BOARD),$$(bash tools/boards.sh arch $(POOL_BOARD)),amd64 arm64)); do bash tools/deb/repo.sh --arch "$$a"; done

# GATE_ARGS=--arch <arch> gates one pool (with its native rebuild);
# GATE_ARGS=--static gates every pool without a rebuild.
GATE_ARGS ?=
package-gate:
	bash tools/deb/package-gate.sh $(GATE_ARGS)

# The whole build of this clean checkout, locally, nothing published: every
# board's kernel and firmware, both pools with their package gates, and each
# board's component trees with their inputs hashes (tools/offline.sh).
offline:
	bash tools/offline.sh

# CI only, from a clean checkout of a release (HEAD carries its YYYYMMDD-HHMM tag).
publish:
	bash tools/deb/publish.sh
	bash tools/publish-components.sh
	bash tools/release-lock.sh write
	bash tools/release-lock.sh attach

publish-test:
	bash tests/publish-test.sh
version-guard-test:
	bash tests/version-guard-test.sh
trust-stage-test:
	bash tests/trust-stage-test.sh
ci-outputs-test:
	bash tests/ci-outputs-test.sh
uboot-env-test:
	bash tests/uboot-env-test.sh

board-contract-test:
	bash tests/board-contract-test.sh

kernel-config-test:
	bash tools/kernel-config-test.sh

# Both FIT boards: the kernel forces its built-in line, so the board's
# declaration and the line the device boots with have to be one statement.
# s905x5m keeps it in a fragment and cx3576 in its committed vendor config;
# only this pair of tests spans that difference.
kernel-cmdline-test:
	bash boards/cx3576/tests/kernel-cmdline-test.sh
	bash boards/s905x5m/tests/kernel-cmdline-test.sh
bench-collector-test:
	bash boards/cx3576/tests/bench/collector-test.sh
mac-stable-test:
	bash boards/cx3576/tests/mac-stable-test.sh
can-network-test:
	bash boards/cx3576/tests/can-network-test.sh
gadget-configfs-test:
	bash boards/cx3576/tests/gadget-configfs-test.sh
flash-verify-test:
	bash boards/cx3576/tests/cx3576-flash-verify-test.sh
wireless-test:
	bash boards/s905x5m/tests/s905x5m-wireless.sh

lint:
	bash tests/shell-lint.sh

check: lint locks-test mirror-test logo-fixtures-test floor-fixtures-test ci-outputs-test board-contract-test uboot-env-test kernel-config-test kernel-cmdline-test bench-collector-test mac-stable-test can-network-test gadget-configfs-test flash-verify-test wireless-test
