# 20260920-the-floor-and-the-declared-features What the kernel floor would cost if it served the products' declared features

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20

Fact-gathering only. Nothing in the tree changed; the experiment ran in a
throwaway clone under `tmp/`.

## 1. Why uefi-x64 has no MEMCG: it is the upstream defconfig

Nothing here sets or clears it. `common/kernel/mica-required.fragment` sets
`CONFIG_CGROUP_BPF` and no other cgroup symbol; both UEFI fragments set
`CONFIG_CGROUPS=y`; the string `MEMCG` appears in no fragment, patch or
required list. The difference is the base each board starts from, at
v6.12.107:

    arch/arm64/configs/defconfig      CONFIG_MEMCG=y
    arch/x86/configs/x86_64_defconfig no CONFIG_MEMCG line at all

uefi-arm64 and the two vendor trees get the memory controller from their
base; uefi-x64's base never had it. FUSE differs for two different reasons in
the same place: `x86_64_defconfig` has no FUSE either, while arm64's has
`CONFIG_FUSE_FS=m` and **our own trim turns it off** --
`boards/uefi-arm64/kernel/config/uefi-arm64.fragment:376`.

## 2. What the two symbols cost, measured with a control

Built on this host from a clone of `8312c1e`-era main, twice: once unchanged,
once with `CONFIG_MEMCG=y` and `CONFIG_CFS_BANDWIDTH=y` appended to the board
fragment.

    published  kernel.uefi-x64.20260916-0857   14992384  sha256 1be983d4e9fe...
    control    unchanged clone, this host      14992384  sha256 1be983d4e9fe...
    experiment the two symbols added           15062016  sha256 9092568a0056...

**The control reproduces the published bzImage byte for byte**, so the delta
is the symbols and not the builder: **+69632 bytes, +0.46 %**. `kernel.release`
is unchanged; `modules.tar` changes (same size, different bytes);
`config` grows by 5 lines, because the two symbols pull in three more:

    +CONFIG_SLAB_OBJ_EXT=y          selected by MEMCG
    +CONFIG_MEMCG=y
    +# CONFIG_MEMCG_V1 is not set   the v2 interface only, no v1 compatibility
    +CONFIG_CGROUP_WRITEBACK=y      selected by MEMCG with BLK_CGROUP
    +CONFIG_CFS_BANDWIDTH=y

A further cost, and it is a feature of the design rather than friction: the
build REFUSED the first attempt, because `kernel/config/<board>.config` is a
reviewed input that must equal the resolved config. Adding a symbol to the
floor therefore means re-recording every board's config with
`make <board>-kernel-config` and putting those diffs up for review, which is
the mechanism that makes a floor change visible instead of silent.
It is worth naming the contrast: that is exactly the property the composer
defect of the same evening showed was missing elsewhere -- a declaration
proved against an input with nothing comparing it to the output -- and here
it was already built, which is why this experiment could not quietly
succeed.

Boot-time cost is NOT measured. It needs a booted system with a timer, which
this repository cannot do; the bench is where that question belongs.

Inputs cost: `common/kernel/` is in every board's kernel inputs, so a floor
change rebuilds all four kernels at their next release. Only uefi-x64's
resolved config would move; the other three should rebuild byte-identically,
and that is checkable when the change is made.

## 3. If the floor is to serve the declared features, MEMCG is not the only gap

Every product of every board declares `containers`. Read from the four
shipped configs (`kernel/config`, `kernel/prod/config`):

| symbol | uefi-x64 | uefi-arm64 | cx3576 | s905x5m |
|---|---|---|---|---|
| CGROUPS, CGROUP_PIDS, CGROUP_DEVICE, CGROUP_BPF, BLK_CGROUP | y | y | y | y |
| SECCOMP, USER_NS, PID_NS, NET_NS, OVERLAY_FS | y | y | y | y |
| BRIDGE, VETH, NF_TABLES, NF_NAT, BPF_SYSCALL | y | y | y | y |
| **MEMCG** | **no** | y | y | y |
| **CFS_BANDWIDTH** | **no** | **no** | y | y |
| FUSE_FS | no | no | y | y |
| IP_NF_IPTABLES | y | m | y | y |

- **`CFS_BANDWIDTH` is missing on BOTH UEFI boards**, and it is the CPU
  analogue of MEMCG: without it there is no `cpu.max`, so a CPU quota cannot
  be enforced. It affects one more board than the memory gap does, and it was
  found by the same grep.
- FUSE is only needed if rootless is ever wanted, which today it is not.
- `IP_NF_IPTABLES=m` on uefi-arm64 is a module where the others build it in;
  equivalent as long as the modules ship, noted so nobody reads it as a gap.

**What this repository can offer the mechanical comparison** (`mica-build` was
asked whether a product's declared features can be checked against a board's
kernel): the floor is already the place where "what the system needs" is
written, and it is asserted on the RESOLVED config of every board. The
missing half is that no list says which symbols a FEATURE needs. A declared
capability list beside each board -- the floor made legible to another
repository -- is the shape that would close it, and it is cheap because the
assertion machinery exists; what does not exist is the mapping from `containers`
to symbols, and that mapping is a judgement this repository can supply but
should not invent alone.
