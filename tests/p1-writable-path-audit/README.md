# P1-B writable-path audit harness

The observation harness behind
`mica:docs/task/20260908-1712-p1-writable-path-audit.md`.
It **observes** writers; it changes no layout, unit, tmpfiles rule or overlay,
and nothing here is installed into an image — `tests/` is in no producer's
`BUILD_CONTEXTS` and in no `rootfs/compose` Dockerfile context.

## Why it exists

The plan's §5 requires each remaining writer's persistence, write/rename
behaviour, initialization, dependency, capacity limit and reset treatment to be
*recorded*, and a directory's presence in the factory image is explicitly not
evidence that it needs to be writable. Answering that from unit files alone
gives the declared half. This gives the observed half: what a real boot writes,
and what breaks when the paths it wrote to stop being writable.

## The scripts

| Script | What it does |
|---|---|
| `extract-root.sh <board>` | unpack `_out/<board>/factory-root.oci` into the work dir |
| `audit-root.sh <board>` | the static sweep over an extracted root: enabled units, exec directories, `PrivateTmp=`, tmpfiles rules, the factory `/var` tree, which bind targets exist, `libwtmpdb` consumers |
| `boot.sh <label> <mode>` | one uefi-x64 QEMU boot with a way in, then `probe.sh` over SSH |
| `probe.sh [mode]` | runs **inside the guest**; `observe`, `candidate` or `verify` |
| `seed-data.sh <file> <path>` | write into the DATA partition of the prepared disk |

## How writers are enumerated without strace

The image ships no `strace`. It does not need one: every file in the factory
`/var` tree carries the build's `SOURCE_DATE_EPOCH` (`2020-01-01`) and the
assembler fills EPHEMERAL from that tree with `mkfs.ext4 -d`, so anything under
`/var` with a later timestamp was written at runtime. `probe.sh` runs

```sh
find /var -xdev \( -newermt 2021-01-01 -o -newerct 2021-01-01 \) -printf '%y %M %u:%g %s %p\n'
```

which is a complete enumeration of that boot's writers rather than a sample.
The negative direction is measured too: `candidate` mode remounts `/var`
read-only and restarts the services, so "this path needs no writable backing" is
tested rather than asserted.

## The way in

micad owns SSH access, so the audit goes in the way a product does. `boot.sh`
seeds a oneshot unit into `DATA/state/systemd-units` through
`build/src/seed-data.ts` (enabled by `mica-load-extensions`, as the API harness
seeds its units). After `micad.service` it calls `SetSettings access.ssh` with
the harness key; micad renders `/run/mica/dropbear.env` and root's
`~/.ssh/authorized_keys` and starts `dropbear.service`. The setting persists on
DATA, so the later boots keep the way in. The earlier route through
`systemd-ssh-generator` and OpenSSH is gone with OpenSSH: mica-system masks the
generator and the image carries no sshd.

## Running it

```sh
# static half, per board
bash tests/p1-writable-path-audit/extract-root.sh uefi-x64-dev
bash tests/p1-writable-path-audit/audit-root.sh  uefi-x64-dev

# runtime half: prepare the disk once, then boot it three times
MICA_PRODUCT=uefi-x64-dev bash tests/apid-api/run.sh --dry-run   # the product names the board, image and signer
MICA_PRODUCT=uefi-x64-dev bash tests/p1-writable-path-audit/boot.sh observe   observe
MICA_PRODUCT=uefi-x64-dev bash tests/p1-writable-path-audit/boot.sh candidate candidate
bash tests/p1-writable-path-audit/boot.sh verify    verify
```

The three boots share one disk on purpose: `candidate` installs the candidate
layout and is powered down cleanly so the real `ExecStop=save` runs against a
read-only `/var`, and `verify` is the same device after that power cycle.

Outputs land in `$P1_WORK` (default `.tmp/p1-writable-path-audit/`): a console
capture and a `probe-<label>.txt` per boot. Probe lines are prefixed
`P1AUDIT|`.
