# 20260920-0900-tier-two-uniformity-and-pstore The scattered cgroup symbols, and what pstore costs uefi-x64

- **status**: open
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 09:00

Two measurements the coordinator asked for, and a proposal for the first.
Nothing is turned on by this record.

## Tier 2: eight scattered symbols, one real question

Measured in the four shipped configs. `y`/`n` as recorded, `-` where the
symbol is not offered:

    symbol                uefi-x64  uefi-arm64  cx3576  s905x5m
    CGROUP_HUGETLB        y         y           n       n
    CGROUP_RDMA           y         n           n       y
    TASKSTATS             y         y           n       y
    CGROUP_PERF           y         y           n       y
    BLK_CGROUP_IOCOST     y         n           n       y
    CGROUP_MISC           y         n           n       y
    CGROUP_NET_PRIO       y         n           n       y
    CGROUP_NET_CLASSID    y         n           n       n
    PSI                   n         n           n       y

**This table is the state BEFORE the fragment lines were added, and one of
them did not take.** Adding `# CONFIG_CGROUP_NET_CLASSID is not set` to the
shared floor did not turn it off on uefi-x64, because that board's defconfig
sets `NET_CLS_CGROUP=y`, which selects it; the symbol shipped `y` in
`uefi-x64.20260920-1536`. Measured and repaired in
[20260920-1600-a-fragment-off-line-is-a-request](20260920-1600-a-fragment-off-line-is-a-request.md),
which also adds the assertion that would have caught it.

Applying the test the coordinator set -- ON if any podman or systemd key a
product can set reaches the controller, uniformly OFF otherwise:

- **Seven are OFF by that test.** No podman flag and no systemd unit key
  reaches `hugetlb.*`, `rdma.max`, `misc.max`, `net_prio.ifpriomap` or
  `net_cls.classid`; TASKSTATS is delay accounting for tools this workspace
  does not ship; and `CGROUP_PERF` is a perf_event cgroup nothing here
  programs.
- **`BLK_CGROUP_IOCOST` was in that list and I had it WRONG.** I wrote that
  "`IOWeight=` reaches `io.weight` rather than iocost", which is two claims
  and the second is false: `io.weight` IS iocost's file. Measured after the
  coordinator pointed at it rather than asserted -- `block/blk-iocost.c` at
  v6.12.107 registers `.name = "weight"` in `ioc_files[]` (line 3515), and
  systemd v257's `src/core/cgroup.c` writes `io.weight` at lines 1734 and
  1995. So a product-settable key reaches it and the test resolves ON. The
  same measurement found `io.latency` written at line 1772
  (`IODeviceLatencyTargetSec=`), so `BLK_CGROUP_IOLATENCY` is ON too, and
  `io.prio` written NOWHERE in that source, so `BLK_CGROUP_IOPRIO` is OFF.
  All three landed in the floor; the first two were scattered and the third
  was `y` on two boards by accident.
- **PSI is the one with a key, and therefore the one real question.**
  `systemd-oomd` and the `ManagedOOMMemoryPressure=` / `ManagedOOMSwap=` unit
  keys are built on pressure stall information: with `CONFIG_PSI=n` those keys
  cannot work, and today they would work on s905x5m alone. So PSI is not a
  scatter to sweep up -- it is a product decision about whether this fleet
  wants pressure-based OOM handling, and it should be taken deliberately in
  either direction.

**Proposal**: the eight go uniformly OFF in the shared floor, recorded with
this reason so the next defconfig bump cannot re-scatter them; PSI is decided
by whoever owns `systemd-oomd` in the product, and whichever way it goes it is
written down beside the other eight rather than left to the defconfigs. The
byte cost of removing the eight is not yet measured; it is one
control-and-experiment pair per board in the usual shape, and it lands with
the change rather than before it.

## pstore on uefi-x64: 8192 bytes

Measured against a control built from the same tree on the same host:

    control (main at 3970753)        15156224
    + CONFIG_PSTORE, EFI_VARS_PSTORE 15164416   +8192   +0.054 %

So the fourth board can be made able to explain a reboot for eight kilobytes.
Three boards already can -- cx3576 demonstrably, on hardware, into a ramoops
region this repository placed on purpose -- and `systemd-pstore` then becomes
one declaration in the composed root for all four rather than three.

**And one symbol name does not travel between trees**:
`CONFIG_PSTORE_DEFLATE_COMPRESS` exists on cx3576's 6.1 vendor kernel and NOT
on 6.12, where compression is `CONFIG_PSTORE_COMPRESS` with the algorithm
chosen elsewhere. Copying cx3576's three lines would have failed the build --
and did, in the experiment, at the fragment's own post-olddefconfig assertion,
which is the second time today that loop caught a symbol that does not exist
in the tree it was aimed at.

## A ninth symbol for the uniformity decision: CONFIG_IPV6_SIT

Raised by the coordinator from lppm7hfw's reading and **re-measured here from
the SHIPPED configs** rather than taken -- the two FIT values were fetched out
of the published kernel components of `cx3576.20260920-1536` and
`s905x5m.20260920-1536`, because those boards commit a vendor INPUT and a
value read there is not a statement about their kernel:

    board        source                                    CONFIG_IPV6_SIT
    uefi-x64     recorded resolved config, in tree         y
    uefi-arm64   recorded resolved config, in tree         m
    cx3576       fetched kernel component at 1536          # not set
    s905x5m      fetched kernel component at 1536          y

Four boards, three answers, nobody chose any of them. The two vendor inputs
happen to agree with what shipped, which is a result and not a reason to have
skipped the fetch.

**The feature is uniformly absent while the symbol is scattered** -- the tier-2
shape exactly. No `.netdev` in any product (a tunnel on systemd-networkd needs
one), no `ip` binary in any root, and nothing in this repository or the
assembly configures a `sit` tunnel; the only occurrences of the string
anywhere are these four configs.

**The behavioural split is two and two, not three and one.** `=y` creates
`sit0` at boot; `=m` does not, and the module is shipped
(`lib/modules/6.12.107/kernel/net/ipv6/sit.ko` in the published uefi-arm64
component) but nothing here loads it. So the interface exists on uefi-x64 and
s905x5m, and not on uefi-arm64 or cx3576 -- whether anything in the composed
root loads it is the assembly's half.

**Why it is worth more than a ninth row.** `sit0` is the interface that made
the mDNS exposure concrete this evening, and it exists by accident on two of
four boards. Measured on cx3576 the same reading would have shown the global
setting and nothing exposed, and the finding would have looked theoretical.
**That is what a tier-2 divergence costs: not a feature difference, but a
difference in what a measurement can see** -- which is an argument for
uniformity in either direction, and the reason the decision should name it.
