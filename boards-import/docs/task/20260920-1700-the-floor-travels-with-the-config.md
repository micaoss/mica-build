# 20260920-1700-the-floor-travels-with-the-config The shared floor is a file row of every board bundle

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 17:00

This repository's half of a two-repository repair, approved by the coordinator
after `mica-build` measured its candidate readers.

## Why it is a bundle row and not a copy

`mica-build` asserts the shared floor against the kernel config of the board
bundle it fetched at its pin, in `build/src/kernel-package.ts`, which reads
`<board bundle>/kernel/config` -- not `/boot` -- and runs on every product
build, every board, FIT and UEFI alike.

The constraint that decides the form: **it must not keep a copy of the symbol
list.** The reader this replaces carried one -- `verify/src/checks-kernel.ts`,
748 lines, deleted 2026-09-09 in `1875d133` (a commit not reachable from
`origin`, so that citation is not fetchable and is recorded here with its
unreachability), with a comment saying it held "the same set" the shared
fragment pins. Two repositories asserting one list from two files is how the
first version decayed. A copy is also what would have made a restoration look
like a repair.

So the floor ships as an artefact instead: `common/kernel/mica-required.fragment`
is staged beside the config it resolved, in the same kernel component --
`kernel/mica-required.fragment` on the UEFI boards, `kernel/dev/` and
`kernel/prod/` on the FIT boards, one row each in `outputs.tsv`. The fragment
staged is the one the build actually merged, from the same build context, so
the two ends of the assertion are one fetched artefact.

**And a stale bundle fails its own floor rather than passing quietly**, which
is the `_out/boards/<board>/kernel/` hazard answered from the consumer side:
the config and the fragment go stale together or not at all.

## Both halves, or the gap gets rebuilt one repository further out

The consumer-side assertion covers the `=y` lines **and** the
`# CONFIG_X is not set` lines. Asserting only the positive half is exactly the
defect found this afternoon in
[20260920-1600-a-fragment-off-line-is-a-request](20260920-1600-a-fragment-off-line-is-a-request.md),
and it would otherwise be rebuilt in a second repository.

## First reading of the FIT resolved configs

The off half ran on all four boards for the first time in CI 35521519448, and
the counts are the positive evidence that it ran rather than being skipped:

    cx3576      config: all 10 options the shared floor records off are off
    s905x5m     config: all 10 options the shared floor records off are off
    uefi-x64    config: all 13 options the fragments record off are off
    uefi-arm64  config: all 216 options the fragments record off are off

s905x5m's committed vendor input carries six of the nine floor symbols `=y`
(`BLK_CGROUP_IOPRIO`, `CGROUP_RDMA`, `CGROUP_MISC`, `CGROUP_NET_PRIO`,
`CGROUP_PERF`, `TASKSTATS`) and does not mention `CGROUP_HUGETLB` at all;
cx3576's carries none of them `=y`. **None of that was a statement about either
kernel**: the floor is merged after the vendor input, and until this run nobody
had read those resolved configs. The floor holds on both.

A requested-off symbol can therefore be met four ways -- `=y`, `m`, an explicit
off, or silence -- and a `# CONFIG_X is not set` line can express exactly one of
them. That is why the gate asserts "no line turns it on" rather than "the
off-line is present".
