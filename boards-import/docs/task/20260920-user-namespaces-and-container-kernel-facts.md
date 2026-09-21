# 20260920-user-namespaces-and-container-kernel-facts User namespaces on the four boards, and two differences found beside them

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20

## The question

`mica-podman` records that rootless podman is not supported today and lists
what it would need. One item is a kernel fact this repository owns: what is
the unprivileged user-namespace setting on each board's kernel?

## Read from the RESOLVED configs, not the committed ones

The committed `boards/<board>/kernel/config/*.config` of a FIT board is the
VENDOR INPUT: `configure.sh` merges `common/kernel/mica-required.fragment`
into it and asserts the floor on the result, so the committed file of cx3576
says `# CONFIG_SECURITY is not set` while the kernel it ships has
`CONFIG_SECURITY=y`. Reading the committed file would have produced a
confident wrong answer about three of the four boards.

**The rule, and it is the companion of the one in
[20260920-cx3576-first-hardware-capture](20260920-cx3576-first-hardware-capture.md):
an input is not an output.** A committed config is what a build is asked to
start from; `/boot/config-<release>` is what a device runs, and only the
second is a fact about a device. The same sentence caught a real defect
elsewhere in the workspace on the same evening -- a composer proving a
declaration against the root it takes as input, with nothing comparing it to
the root it produces -- so the question to ask of any file before concluding
from it is which end of a build it sits on. The configs below are
the published `kernel/config` (or `kernel/prod/config`) artefacts of the
current releases -- the same bytes that land at `/boot/config-<release>`:
`cx3576.20260917-1007`, `s905x5m.20260919-2259`, `uefi-x64.20260916-0857`,
`uefi-arm64.20260916-0857`.

## The answer: identical on all four, and nothing gates it

    CONFIG_USER_NS=y                 all four
    CONFIG_NAMESPACES=y              all four
    CONFIG_SECURITY=y                all four
    CONFIG_SECURITY_SELINUX=y        all four, with SELINUX_DEVELOP=y
    CONFIG_LSM="landlock,lockdown,yama,loadpin,safesetid,integrity,selinux,bpf"
                                     all four, byte-identical
    # CONFIG_SECURITY_APPARMOR is not set    all four
    the string "unprivileged"        0 occurrences in any of the four

So unprivileged user namespaces are permitted by the kernel on every board,
by the upstream default that `CONFIG_USER_NS=y` implies, and nothing in this
repository restricts them:

- there is no `CONFIG_USER_NS_UNPRIVILEGED`-style gate in any tree we build;
- AppArmor is off everywhere, so Ubuntu's
  `kernel.apparmor_restrict_unprivileged_userns` cannot exist on these
  kernels;
- Debian's `kernel.unprivileged_userns_clone` is a Debian patch and no tree
  we build carries it -- no config, fragment or patch of ours mentions it.

What a config cannot prove is the absence of a vendor sysctl patch in the
kernel SOURCE of the two vendor trees. That costs one line on the bench and
belongs with the other bench asks:
`sysctl -a | grep -E 'unprivileged_userns|max_user_namespaces'`.

## Two differences found beside the question, and they are the useful part

| | CONFIG_USER_NS | CONFIG_FUSE_FS | CONFIG_MEMCG |
|---|---|---|---|
| uefi-x64 | y | **not set** | **not set** |
| uefi-arm64 | y | **not set** | y |
| cx3576 | y | y | y |
| s905x5m | y | y | y |

- **FUSE is absent on both UEFI boards.** `fuse-overlayfs` is the usual
  rootless storage driver, so if rootless is ever wanted the missing piece is
  not user namespaces and it is not on the hardware boards: it is FUSE on
  uefi-x64 and uefi-arm64.
- **`CONFIG_MEMCG` is not set on uefi-x64.** That is beyond the question and
  larger than it: the memory controller is how a container runtime enforces a
  memory limit and how systemd accounts one, and all four products --
  including `uefi-x64-dev` and `uefi-x64-prod` -- declare the `containers`
  feature. This repository has not measured the runtime consequence; it is
  named here because it is a kernel fact this repository owns and a product
  question `mica-podman` and `mica-build` own.

Nothing is changed by this record. The answer was asked for as a fact, and the
two differences are reported rather than fixed, because turning a symbol on in
a shipped kernel is a decision with its own round.
