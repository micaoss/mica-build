# 20260920-0800-cross-and-native-agree-per-tree-not-per-rule A correction to my own reproducibility rule

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 08:00

## What I said two hours earlier, and what it has to become

Measuring the boot logo, a LOCAL CROSS build of the uefi-arm64 kernel
reproduced what a NATIVE arm64 runner published, byte for byte, and I wrote
the rule that came out of it: **cross-versus-native is not the variable --
whether the two builds use the same pinned toolchain is.** The coordinator
adopted it in place of its own.

Measuring the container gaps an hour later, the same comparison on **s905x5m**
came out the other way:

    published (CI, native arm64)   33065472   sha256 feb7c404ed82...
    local     (this host, cross)   33065472   sha256 63efe6aa2100...
    differing bytes                3704791 of 33065472, first at 66150

**Identical SIZE, 3.7 MB of different content.** Not a timestamp, not a
version string: different code generation spread through the image.

## The rule, corrected

Same pinned toolchain IMAGE is NECESSARY and NOT SUFFICIENT. The compiler
actually invoked is a different binary in the two cases -- Ubuntu's
`aarch64-linux-gnu` cross package on an amd64 builder, the native `gcc` on an
arm64 runner -- and whether that difference reaches the output **is a property
of the TREE, not of the rule**:

- mainline `linux-stable` 6.12.107 (uefi-arm64): cross and native agree, byte
  for byte;
- the Amlogic vendor tree (s905x5m): they do not.

So "the toolchain is the variable" was too strong, in the direction that makes
a local build look authoritative. The statement that survives is: **cross and
native agree per TREE, and it must be measured per tree rather than
generalised from one board to another.** uefi-arm64's result stands on its own
evidence -- it was compared against the published artefact directly -- and it
licenses nothing about any other board.

## The near-miss inside the measurement

The two s905x5m kernels are **exactly the same size**. A check that compared
sizes would have passed, and this file would have recorded a no-op that was
not one. It is the aperture family again in a third form: not a truncated
search and not a wrong key, but a comparison too coarse to see the thing it
was asked about. Compare the bytes.

## What the same measurement DID establish

Adding `MEMCG`, `CFS_BANDWIDTH`, `IOSCHED_BFQ` and `BFQ_GROUP_IOSCHED` to the
SHARED floor (`common/kernel/mica-required.fragment`) is a **no-op for a board
that already has them**: the s905x5m kernel built from the floor-changed tree
is byte-for-byte identical to the one built from the unchanged tree on the
same host (`63efe6aa2100...` both). That was the prediction in
`20260920-the-floor-and-the-declared-features.md` and it is now measured
local-against-local, which is the comparison that answers it.
