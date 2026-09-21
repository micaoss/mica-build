# mica-boards

The boards of Mica OS, one directory each under `boards/` -- the board
definition (`board.env`), the package manifests (`manifests/`), the kernel
inputs (`kernel/`: configuration, device tree, patches, hooks), the loader
inputs (`loader/`), the support firmware (`firmware/`), the board package's
inputs (`package/`: control, copyright, overlay, hwinit, init), the board
evidence and the board's own tests -- and its own kernel and U-Boot builds, whose
source pins are its rows of `locks/upstream.lock`; what every board takes unchanged is under
`common/` (`boards/README.md`). `tools/new-board.sh <name> --from <nearest>`
copies a board.
The inputs are in `locks/` (mica:docs/design/release-lock.md): every image
comes from `locks/mica-build-env.lock`, the unchanged lock of the mica-build-env
release `locks/pins/mica-build-env.pin` names (build-env images by name,
third-party images by their upstream rows; `tools/from.sh`), and every
third-party tree and archive from `locks/upstream.lock` (`tools/upstream.sh`).
The packaging, package gate and publisher (`tools/deb/`) and the shared
kernel floor, U-Boot record format, trust staging and board package inputs
(`common/`) are this repository's own. The Debian base is the
assembly's concern; nothing here composes a root.

```
make deps                 # verify locks/ against the releases it pins
make <board>-kernel       # a board's kernel into _out/<board>/kernel; <board>-firmware its loader; make kernels firmware for every board
make pool                 # every board package and the radio packages, both architectures, indexed
make package-gate         # the gate over that pool
make check                # lint, the board contract, the kernel-config floor, the boards' tests
```

A release is one board's, cut on GitHub with `gh release create
<board>.<YYYYMMDD-HHMM> --target <commit of main>`; `release.yml` builds that
board alone at the tag and publishes its pool as
`pool.<board>.<arch>.<YYYYMMDD-HHMM>` and its components as
`<component>.<board>.<YYYYMMDD-HHMM>` in `ghcr.io/micaoss/mica-boards` -- board
(definition, manifests, outputs.tsv, trust certificate), kernel, and uboot and
firmware where the board has them (`tools/component.sh`) -- then attaches
`mica-boards.lock` (`release mica-boards <board>.<YYYYMMDD-HHMM> <commit>`, the
board's pool and package rows and a `board <board> <component> <arch>
<reference>` row per component) and `SHA256SUMS` listing only the lock. A
component whose inputs hash (`tools/inputs.sh`, the `mica.inputs` annotation)
equals the same component of the board's latest release is not built again: the
new tag names the published digest (`tools/reuse.sh`). A package is locked by its
declared version (`version.env`, `tools/deb/README.md` *Versions*): a release never
changes it, an unchanged version must keep its inputs and its published bytes and a
version never goes back (`tools/deb/version-guard.sh`, in CI and at release), and a
pool with no bumped package keeps its digest. Kernels are built natively
on their board's architecture; U-Boot is cross-compiled on x86-64, whose FIT host
tools the assembly runs there. `boards/boards.tsv` lists the supported boards,
one row each, and `boards/<board>/outputs.tsv` what a release of the board
outputs, carried in its board component (`tools/boards.sh`).

The trust material a release embeds comes from the repository variables
`MICA_VERITY_TRUST_CERT` and `MICA_BOOT_TRUST_CERT` (public PEM certificates).
They are the public halves of the release trust material mica-build signs
with -- the certificates of `MICA_RELEASE_VERITY_CERT` and
`MICA_RELEASE_BOOT_CERT`, whose private keys exist only there -- which is
currently the development set; the assembly refuses kernels and U-Boots
built against any other. The user sets these variables; no certificate is
committed, only their sha256 in `trust-certificates.sha256`, and the CI build
stops when a variable does not hash to it, so a change of trust material is a
commit.

A kernel embeds the dm-verity trust certificate of the deployment it will
boot (`VERITY_TRUST_CERT`, default `meta/verity/signer.cert.pem`) and a
U-Boot the FIT boot certificate (`FIT_TRUST_CERT`), both public
certificates the assembly supplies (this repository holds and generates no
private key); the board component ships the certificate, and the assembly
(`micaoss/mica-build`) refuses a kernel built against another one. The
assembly imports every package here through `deps/packages/` and builds
none of them.
