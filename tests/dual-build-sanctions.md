# Dual-build sanction ledger

> **CLOSED RECORD -- THIS LEDGER IS NOT A LIVE INPUT TO ANY GATE.**
>
> The comparison it governed no longer runs and cannot: the rootfs stage chain
> was removed (PLAN-036 sections 4-6, merged at ae3f0ce), the composer is the
> only assembly path, and a difference set needs two. `tests/dual-build-gate.sh`
> and its `make os-dual-build-gate` target were deleted rather than left in the
> tree to exit at their own `refuse` before comparing anything -- an instrument
> that can return no verdict, not even a failing one, is not an instrument.
>
> Everything below this block is kept EXACTLY as it was judged, unedited:
> sixteen stanzas, eight of them narrowed to one exact diff, each with the
> written reason the difference was accepted on. That reasoning is what the
> removal was accepted on, so it is a record and not a leftover. Read the tenses
> below as the tenses of the run that produced them -- "the gate refuses", "the
> driver builds both paths" describe a comparison that was made, once, at one
> commit.
>
> `src/image/compare-roots.ts` is NOT retired with it. It ships as
> `bash bin/bun.sh src/cli.ts compare-roots`, a first-class mode for comparing any
> two extracted root trees, and this file is only the default its `--sanctions`
> flag points at. "No longer executes" and "should not exist" are different
> claims, and only the first is being made here.
>
> **Addendum, 2026-08-31 -- the two `/usr/lib/mica/board` stanzas now describe
> content that no longer exists.** `mica-board-uefi-x64` has stopped shipping
> `/usr/lib/mica/board/uefi-x64/grub.cfg`, and with it the only file under that
> directory, so the package now adds neither the directory nor its contents.
> The reason is the one the stanzas themselves state without drawing the
> conclusion: "the assembler reads `boards/uefi-x64/grub.cfg` out of the tree
> instead." Nothing read the packaged copy, which left an unrendered template
> -- `@BOOT_A_PARTNUM@`, `@ROOTFS_A_PARTUUID@` -- in a signed read-only root.
> Both stanzas stand as written: they record what was measured and sanctioned
> at commit 498eeb824cda, and a rerun of that comparison at that commit would
> still produce those three `added` paths. This note is here so a reader does
> not take them for a description of the package today.

PLAN-036 section 6 ends with a gate: before the rootfs stage chain is deleted,
uefi-x64 is built through **both** paths -- the chain and the package composer -- and
their unpacked trees are compared. "Expected additions are package documentation
and the package composition record; every other difference requires an explicit
explanation."

This file is where that explicit explanation lives. It is read by
`src/image/compare-roots.ts`, which fails the gate on any difference no
stanza here covers. Nothing else in this repository grants an exception to that
comparison, and there is no flag that turns it off.

## How the gate calls the comparator

```
bash bin/bun.sh src/cli.ts compare-roots [--sanctions FILE] DIR_A DIR_B
bash bin/bun.sh src/cli.ts compare-roots --extract-oci ARCHIVE DIR
```

`DIR_A` is the baseline root, the path being replaced: the stage chain.
`DIR_B` is the candidate, the path replacing it: the composer. That order is not
cosmetic -- `added` means *present in B, absent in A*, and the two sanctions
PLAN-036 grants in principle are additions, so a driver that swapped the
arguments would find every one of them classified as a removal and unsanctioned.

Both sides are **already-extracted directories**. `--extract-oci` is how one is
produced from the `factory-root.oci` that
`rootfs/stages/90-pack.Dockerfile`'s `factory-root` target writes to
`_out/<board>/`; it unpacks with `--numeric-owner --xattrs`, so ownership and
file capabilities arrive as the image carries them.

`--sanctions` defaults to this file, so the driver needs no path of its own.

Pass **absolute** paths. `run.sh` runs bun with `build/` as its working
directory, so a relative argument resolves against `build/` rather than
against wherever the driver stood, and the failure surfaces as "does not exist"
naming a path the driver can see.

Exit codes:

| code | meaning |
| ---- | ------- |
| 0 | compared: every difference sanctioned, every active sanction used, no pending sanction live |
| 1 | compared, and this ledger does not account for the result |
| 2 | **refused** -- no comparison was made at all |

2 is separate from 1 on purpose. A missing side, a side that is empty or under
the path floor, both sides being one directory, an unparseable ledger and a host
with no `getcap` all produce it, because each of them would otherwise produce a
green that is a fact about the harness rather than about the two roots.

The comparator prints its counters on every run, including passing ones: paths
on each side, paths in the union, capability-bearing files on each side, and
differences found / sanctioned / unsanctioned. "No differences" and "nothing was
examined" reach the same verdict by opposite routes and the counts are what
separate them.

## The format

Everything above the `## Sanctions` heading is prose and is not parsed. Under
it, one stanza per sanctioned difference:

```markdown
### /usr/share/doc/**
- classes: added
- status: pending
- reason: Why this difference is allowed. Mandatory, and it is the point of the file.
```

- The heading is a path pattern, matched as a glob against the path as it
  appears *inside* the root, with a leading slash: `/usr/bin/micad`. `*` stops at
  a `/`, `**` does not. Backticks around the pattern are stripped.
- `classes` is a comma-separated subset of: `added`, `removed`, `type`, `mode`,
  `uid`, `gid`, `symlink`, `content`, `caps`. A sanction covers a difference
  only when **both** the pattern and the class match, so sanctioning a file's
  contents does not quietly sanction its mode changing too.
- `status` is `active` (the default) or `pending`.
- `reason` is free text on one line and may not be empty.

A stanza with an unknown key, an unknown class, no `classes`, no `reason`, an
empty `reason`, or a pattern already sanctioned above is refused by name with
its line number. A key this parser does not read is a condition its author
believed they had written down.

## The three hard rules

1. **An unsanctioned difference fails the run**, naming the path and the class.
2. **A sanction that matched nothing also fails the run**, naming the stanza and
   its line. A stale sanction covering an absence is how an instrument like this
   stops asking the question it was built for: the tree moves on, the stanza
   goes on sanctioning something that is no longer there, and the run stays
   green by comparing less than it used to.
3. **The class `removed` may never be sanctioned, for any path.** A removed path
   is one the CHAIN ships and no package owns, so a stanza there would write
   down "the composed image is missing a file the device needs" and call it
   accounted for -- which is exactly the failure the switch-over exists to
   prevent. The fix is to give the path an OWNER. The first instance found was
   `boards/cx3576/overlay/.../serial-getty@ttyFIQ0.service.d/local-line.conf`,
   which reaches the image because `rootfs/scripts/overlay-install.sh` copies
   the board overlay in wholesale and `mica-board-cx3576` installs only selected
   subpaths of it -- and that one file is what makes serial console login work.
   `tests/dual-build-gate.sh` refuses (exit 2) if any stanza below lists
   `removed`, so this is a check rather than a convention.

## Pending stanzas, and the tension they resolve

Rule 2 and the shipped state of this file pull against each other. PLAN-036
sanctions two differences *in principle* -- package documentation and the
package composition record -- but the composed path does not exist yet, so
neither difference can be produced today. Writing those stanzas as ordinary
sanctions would make rule 2 fail every run until the composer lands; leaving
them out would lose the decision PLAN-036 already made.

`status: pending` is the resolution, and it is deliberately not a way of
switching a rule off:

- a pending stanza **must match nothing**. It is written down, it is not in
  force, and it sanctions no difference -- a difference that only a pending
  stanza matches is still reported as unsanctioned.
- a pending stanza that **does** match fails the run, naming it: the difference
  it describes has arrived, so the decision has to be taken for real by
  promoting it to `status: active`.

So the state of every stanza is asserted on every run in both directions, and
"not yet" is a claim the gate checks rather than a place to put things.

### The composition record is not a difference, and its stanza is gone

This file used to carry a third pending stanza, `/etc/mrootfs-packages.txt`,
as a placeholder for "the in-image copy the composer may also stage". The
composer has landed and it stages no such copy, so the stanza has been
**deleted** rather than corrected to a real path.

The reason is the one its own text gave: PLAN-036 section 4 writes the record to
`_out/<board>/rootfs-packages.txt`, which is outside both compared trees, and
that is the right place for it. It is the durable BUILD record and it replaces
`rootfs-stages.txt`, which has always lived there too -- neither is image
content. Inside the root it would be a second copy of facts dpkg's own database
already carries at the moment the finalizer purges it, and it would be one more
path to sanction for no gain.

A pending stanza that can never match is not harmless, even though rule 2
exempts it from failing the run: it reads as a decision that is still open when
the decision has in fact been taken. Deleting it is how the decision gets
recorded.

## Evidence that this instrument works

Four outcomes, driven against two REAL uefi-x64 roots -- not fixtures. Both were
built from this worktree at one commit, on this host, with uefi-x64 being amd64 and
therefore native:

```
a. full     MICA_BOARD=uefi-x64 bash rootfs/build.sh
b. reduced  MICA_BOARD=uefi-x64 MICA_ROOTFS_WITHOUT=mqtt bash rootfs/build.sh
```

Each run's `_out/uefi-x64/factory-root.oci` was preserved before the next overwrote
it, then both were extracted with `--extract-oci`: one gzip layer each, **9,234
paths** each, **0 capability-bearing files** on either side. That zero is printed rather
than assumed -- on a root with no file capabilities that dimension compares an
empty set with an empty set, and `tests/factory-root-gate` says the same
thing about the same root.

The difference set is **10 records, every one of class `content`**. No path is
added or removed, and no mode, uid, gid, symlink target or capability differs
anywhere in 9,234 paths.

Eight of the ten are the mqtt stage, and they are not what the gate's author
expected. `stages/34-feature-mqtt` is the ACCOUNTS stage only -- its own header
says the binaries "come out of the same cargo build as micad" and are installed
by `stages/33-feature-micad` -- so `/usr/bin/mica-mqttd`,
`/usr/bin/mica-mqtt-broker` and both units are present and **byte-identical** in
the reduced root. What declining the stage removes is two service accounts,
`mica-mqttd` (970) and `mica-mqtt-broker` (969), from the eight files that carry
them: `/etc/passwd`, `/etc/passwd-`, `/etc/group`, `/etc/group-`,
`/etc/gshadow`, `/etc/gshadow-`, `/etc/shadow-` and
`/usr/share/factory/etc/shadow` (the real `/etc/shadow` is a symlink into
`/run`, so the factory copy is the one that ships).

The other two differ for reasons that have nothing to do with mqtt, and they
were opened rather than assumed:

- `/boot/initrd.img-6.12.107+deb13-amd64`. Every cpio entry sits at an identical
  offset in both builds; the whole 12-byte delta is inside a gzip segment whose
  UNCOMPRESSED size is byte-equal at 36,418,048. Of that segment's 183 entries,
  names, sizes, modes, owners and extracted contents are identical, 182 carry a
  different inode number, and 70 carry a different mtime -- the two builds'
  wall clocks, 245 s apart.
- `/usr/share/factory/var/cache/ldconfig/aux-cache`. Header identical, all 128
  library path strings identical with an empty set difference in both
  directions, and 2,001 of 8,062 bytes differing from offset 1,808 on: the
  binary entry table, which glibc fills with `{dev, ino, ctime, size}` per
  shared library.

Both are the stage chain failing to be reproducible, not composition
differences, and the composed-vs-chain gate will report them however faithful
the composition is. They are recorded here so that whoever writes their stanzas
writes the real reason -- or fixes the producers instead.

**INFERRED, not yet measured**, and marked as such: that two builds of the SAME
configuration would also differ on these two paths follows from what the bytes
are -- host inode numbers and a wall clock cannot repeat -- but the pair
measured above differ in configuration as well, so the inference is one step
past this evidence. A same-configuration measurement is queued; this paragraph
is corrected to a measurement or withdrawn when it lands.

### Why the archive grew while its content shrank

The reduced root's `factory-root.oci` is 250,955,776 bytes against the full
root's 250,955,264 -- 512 larger, one tar block, for a tree with two accounts
removed. Not "probably padding":

- The archive holds ONE gzip layer blob. Its declared size is 250,948,072 (full)
  against 250,948,264 (reduced): the COMPRESSED layer is **192 bytes larger**
  over a tree that is **501 bytes smaller** uncompressed (`/etc/passwd` -140,
  `/etc/passwd-` -116, `/etc/shadow-` -54, the factory shadow -54, `/etc/group`
  -40, `/etc/gshadow` -34, `/etc/group-` -29, `/etc/gshadow-` -22, the initrd
  -12, aux-cache unchanged). gzip's output size is not monotone in its input's.
- The `.oci` is a tar, which rounds every member up to 512 bytes. 250,948,072
  needs 490,133 blocks; 250,948,264 needs 490,134. Every other member -- the
  manifest at 567, the config at 412, `index.json` at 465, `oci-layout` at 30 --
  is byte-identical in size on both sides.

One extra block, and that is the whole 512.

The four outcomes, each run against those two roots:

1. **Non-empty difference set.** Against a ledger with no stanzas: 10
   differences, 0 sanctioned, 10 unsanctioned, `RESULT: FAIL`, exit **1**.
2. **Sanctions covering the set turn it green.** Ten stanzas, one per path:
   `differences found: 10 / sanctioned: 10 / unsanctioned: 0`,
   `RESULT: PASS (10 differences, all sanctioned; 10 active sanctions, all
   used)`, exit **0**.
3. **Deleting one stanza turns it red, by path.** With the `/etc/gshadow`
   stanza removed: `UNSANCTIONED /etc/gshadow content: A=4c46e199... B=6d545111...`,
   `RESULT: FAIL (1 unsanctioned difference(s), ...)`, exit **1**.
4. **A sanction for a path that does not differ turns it red, by stanza.**
   Adding `/usr/bin/micad` on top of the ten:
   `UNUSED SANCTION .../proof-unused.md:50 '/usr/bin/micad' (content) matched
   nothing`, `RESULT: FAIL (0 unsanctioned difference(s), 1 unused
   sanction(s), ...)`, exit **1**.

The reduced root is PROOF MATERIAL and not a shippable configuration: it ships
two units whose `User=` names accounts that no longer exist, which is exactly
the failure `stages/34-feature-mqtt` documents. Its build reported rc=1 for that
reason -- the smoke runner refuses a root built without a feature stage rather
than skipping the affected artifacts -- and the OCI archive was fully written
before that refusal, byte-identical to what the smoke runner had just printed.

The sanctions used for outcomes 2-4 are **not** in the shipped list below. They
are proof material: they describe the difference between two builds of the SAME
path, which is not the difference this gate exists to judge. Shipping them would
pre-sanction two service accounts vanishing from the composed root, and the two
non-reproducible paths besides -- three decisions nobody has taken, granted in
advance by a file whose whole purpose is that such decisions are written down.

### The queued measurement, and the prediction written before it

Two more uefi-x64 roots are being built to close two gaps this pair leaves. Both
predictions below are committed BEFORE the comparator runs against them, so that
a met prediction is worth what a met prediction is worth.

**Gap 1: only one of nine difference classes has been exercised on real
material.** All ten records above are `content`. The class the switch-over
actually rests on is `added` -- PLAN-036's two sanctioned differences are both
additions -- and it has been proven by fixtures only. Build C declines the
container engine, which is a real path payload and was confirmed to be one by
reading the assembled root rather than the stage's name: `/usr/bin/podman`,
`/usr/bin/crun`, `/usr/libexec/podman/{conmon,quadlet,netavark,aardvark-dns}`,
`/usr/lib/systemd/system-generators/podman-system-generator`,
`/etc/containers/systemd` and `/usr/sbin/nft` are all present in the full root.

*Prediction, full vs containers-declined:* a difference set containing
`removed` records for that payload and for the files of the apt packages the
stage installs (nftables, libjson-c5, libsubid5, libseccomp2, libcap2,
libglib2.0-0t64), plus the two non-reproducible paths; and, with the two
arguments SWAPPED, the identical path set reported as `added` instead. That
swap is the orientation trap this file's seam note warns about, demonstrated on
real material rather than asserted.

**Gap 2: the same-configuration claim above is an inference.** Build D repeats
the full build with no `MICA_ROOTFS_WITHOUT` at all. It cannot be a byte-repeat
of build A, because the tree has moved on by two commits and
`micad:hack/build-target.sh` embeds `<commit>` at compile time -- which
is itself what makes the experiment work, since it re-runs the stages that
generate both non-reproducible files.

*Prediction, build A vs build D:* exactly four `content` records and nothing
else --

1. `/usr/bin/micad` and 2. `/usr/bin/mica-apid`, the only two paths in the whole
   9,234-path root that carry the commit string (found by grepping build A's
   root for `cf2a07049c96`; same length, so the sizes are unchanged),
3. `/boot/initrd.img-6.12.107+deb13-amd64`, and
4. `/usr/share/factory/var/cache/ldconfig/aux-cache`,

with `/usr/bin/mica-mqttd` and `/usr/bin/mica-mqtt-broker` byte-IDENTICAL -- they
do not read that variable -- and with no added or removed path and no mode, uid,
gid, symlink or capability difference anywhere. If 3 and 4 appear while their
unpacked contents stay byte-identical, the inference above becomes a
measurement: the configuration is the same, so nothing but the rebuild itself
can explain them. If anything else appears it is a third non-reproducible
surface and goes to L2 before it goes here. If instead the set comes back EMPTY,
build D was a cache replay and proves nothing -- which is what will be reported,
rather than a green dressed up as agreement.

#### Addendum: the builder changed after those predictions were committed

The two predictions above were written against builds that would run on the
`default` docker-driver builder, chaining stages through the daemon-global
`mica-rootfs-stage:uefi-x64-*` tags. Those tags are shared by every worktree on the
host, so the builds now run on a private docker-container builder instead,
where `src/image/stages-cli.ts` chains by OCI layout under `_out/<board>/
stages/` -- worktree-local, and unable to collide with a sibling.

That is the right change and it has a consequence the predictions did not
account for: a fresh builder has an empty cache, so build D is a COLD rebuild of
all nine stages rather than a re-run of 33 through 90 over a warm one. Two
things follow, and they are recorded here rather than quietly absorbed:

- It removes the risk the predictions were most exposed to. A cold build cannot
  be a cache replay, so an empty difference set from D would now mean something
  is wrong with the experiment rather than that the cache answered it.
- It admits a confound they did not have. `stages/10-base` and `20-install` run
  `apt-get update && apt-get install` against the live Debian archive -- the
  BASE IMAGE is digest-pinned, the package versions are not -- so a cold
  rebuild can legitimately install different package versions than build A did,
  and any file that differs for that reason is package drift rather than a
  non-reproducible surface. They are told apart by ownership: the four
  predicted paths are two self-built binaries and two files generated at build
  time, while drift would show up as Debian-owned paths under
  `/usr/lib/x86_64-linux-gnu/`, `/usr/share/doc/` and the like, most likely with
  added and removed paths beside the content changes.

The predictions are NOT edited to cover this. They stand as committed, and if
the measured set is wider, what widened it is named here in advance.

### What the two queued builds measured

Build D (the full build again, commit 23037394a539) and build C
(`MICA_ROOTFS_WITHOUT=containers`, same commit) ran on a private
docker-container builder, so both chained by OCI layout under this worktree's
own `_out/uefi-x64/stages/` and wrote no daemon-global tag. Build D was cold: 142
`DONE` against 28 `CACHED`, and 379 apt progress lines. Build C exits 1, which
is the smoke runner refusing a feature-declined root rather than a failure --
the archive is written before the refusal.

**The predicted drift did not happen, and the prediction that did fail was mine
about the drift, not the one committed at 38743fc.** Build D's log shows
`Unpacking libssl3t64 (3.5.7-1~deb13u2) over (3.5.6-1~deb13u2)`, and from that
line alone this file previously expected openssl-owned paths in the difference
set. Measured against the roots: `/usr/lib/x86_64-linux-gnu/libcrypto.so.3` and
`libssl.so.3` are BYTE-IDENTICAL in both. The `over (3.5.6)` is relative to the
digest-pinned base image, and both builds upgraded to the same 3.5.7. A build
log said what a root did not.

**Build A vs build D: six content records, and the four predicted are among
them.** `/usr/bin/micad` and `/usr/bin/mica-apid` carry the embedded commit, as
predicted. `/boot/initrd.img-6.12.107+deb13-amd64` and
`/usr/share/factory/var/cache/ldconfig/aux-cache` differ, as predicted. Nothing
is added or removed and no mode, uid, gid, symlink or capability differs.

That comparison is the one the inference above needed, and it now settles it
for the initramfs. micad and apid are not IN the initramfs, and the package
versions are identical, so its inputs were the same on both builds. Per cpio
entry: 183 entries, identical names, **zero entries whose content differs**, 182
differing in inode number and 71 in mtime, with the maximum mtime 2,615 seconds
apart -- the 43 minutes between the two builds. The aux-cache likewise: header
identical, all 128 library-path strings identical with an empty set difference
in both directions, only the binary `{dev, ino, ctime, size}` table moving. So
for these two paths the claim is no longer an inference: **the content is
identical and only the build's own metadata moves.**

**A THIRD non-reproducible surface, which nothing predicted.** The other two
records are `/usr/share/factory/etc/shadow` and `/etc/shadow-`, and they are a
different mechanism from the first two -- not an inode number but a DATE:

```
-  systemd-network:!*:20691:::::1:      20691 = 2026-08-26
+  systemd-network:!*:20696:::::1:      20696 = 2026-08-31
```

`messagebus`, `systemd-resolve` and `sshd` move with it. These are accounts
created by Debian package postinst scripts, and the shadow last-change field is
the day the account was made. The mica-owned accounts do NOT move -- `Mica OS`,
`mica-mqttd` and `mica-mqtt-broker` all read 18262 (2020-01-01) in both builds,
because `rootfs/scripts/account-*.sh` pins them with `chage -d`. The
distribution's accounts get no such treatment.

This one is worse than the other two for a gate, because it is quiet. It is a
DAY, so two builds on the same day agree and only builds on different days
differ: it passes every same-session test and fails whenever the two paths of
the dual-build gate happen to straddle midnight. No stanza is written for it
here, for the same reason none is written for the other two.

**Build D vs build C: the addition and removal dimension, on real material for
the first time.** 9,234 paths against 9,199, and 38 differences: **35 `removed`
and 3 `content`**. The removals are the container engine and what only it pulls
in -- `/usr/bin/podman`, `/usr/bin/crun`, the five binaries under
`/usr/libexec/podman/` and that directory itself,
`/usr/lib/systemd/system-generators/podman-system-generator`, `/run/crun`,
`/usr/sbin/nft`, `/etc/nftables.conf`, `/usr/lib/systemd/system/nftables.service`,
its `deb-systemd-helper-enabled` record, the nftables/nftnl/jansson/subid
shared libraries with both their soname and real-name links, and eleven paths
under `/usr/share/doc/`. The three content records are the two non-reproducible
paths above plus `/etc/ld.so.cache`, which differs because the library set
really did change -- a consequence of the configuration, not a surface.

**The orientation trap, demonstrated rather than asserted.** Swapping the two
arguments gives the IDENTICAL 38-path set with 35 records reported as `added`
instead of `removed`, the 3 content records unchanged. A gate driver that got
the order backwards would not fail loudly; it would report a plausible set with
every class inverted, and a ledger written for one order would go green against
the other only by accident.

**The shipped `pending` stanza fired on real material.** Run in the composed
orientation, the difference set contains real added `/usr/share/doc/<package>/`
paths -- copyright files among them, which is exactly what PLAN-036 sanctions
in principle. The run reported:

```
PENDING SANCTION NOW LIVE .../dual-build-sanctions.md:377 '/usr/share/doc/**'
  (added) matches a real difference; promote it to 'status: active'
```

while still counting those paths as unsanctioned. That is both directions of
the pending rule, on real paths rather than on a fixture.

It also exposed a gap in that stanza, which is why it is written down here and
fixed below: `/usr/share/doc/**` matched
`/usr/share/doc/libjansson4/copyright` but NOT `/usr/share/doc/libjansson4`
itself, because `**` does not match zero path segments. The directory entry a
package creates is a difference of its own, and the shipped list now carries a
second pattern for it.

## The first real dual-build measurement, and what it found

Both roots built from ONE tree at commit `498eeb824cda`, uefi-x64, on one private
docker-container builder, with the finalizer proved shared from the two builds'
own records: `90-pack` at content hash `9472bc8b8de4ea23...` on **both** sides,
9 chain stages against 2 composed. 9,233 paths on the chain side, 9,250 on the
composed side, 0 capability-bearing files on either.

**46 differences: 25 `added`, 12 `content`, 8 `removed`, 1 `symlink`.** Every one
of them is enumerated below and each is either sanctioned in the list at the end
of this file or named here with the producer that has to own it. Nothing is
described as "as expected".

Against that ledger the comparator reported **33 sanctioned, 13 unsanctioned, 0
unused sanctions, 0 pending sanctions now live**. Two of the thirteen --
`/usr/sbin/policy-rc.d` and `/tmp/pool.names` -- were then ELIMINATED in code
rather than sanctioned, so a rebuild should report eleven: the `ssh.service`
addition, the seven networkd-enablement records, `/run/crun`, and the two shadow
paths. Each of the eleven is named below with the producer that has to own it.

### Sanctioned, with the measurement behind each

- **20 `added` under `/usr/share/doc/`**: ten package directories and ten
  `copyright` files, one pair per local package -- `mica-apid`, `mica-board-uefi-x64`,
  `mica-ca-trust`, `mica-mqtt-broker`, `mica-mqttd`, `mica-podman`,
  `mica-profile-dev`, `mica-rauc`, `mica-system`, `micad`. This is PLAN-036's first
  sanctioned addition arriving exactly as written, and it is what promoted the
  two `/usr/share/doc` stanzas from `pending` to `active`.
- **3 `added` under `/usr/lib/mica/board/`**: the directory, the `uefi-x64`
  subdirectory and `grub.cfg`. `mica-board-uefi-x64` ships the GRUB configuration as
  image-assembly input with its placeholders intact; the chain has no
  counterpart because the assembler reads `boards/uefi-x64/grub.cfg` out of the
  tree instead.
- **4 `content` in the self-built binaries** -- `/usr/bin/micad`,
  `/usr/bin/mica-apid`, `/usr/bin/mica-mqttd`, `/usr/bin/mica-mqtt-broker`. Two
  independent compilations of one source tree: the chain builds all four in one
  cargo invocation through `micad:hack/build-target.sh` into `target/`,
  while the composed root gets them from two producers through
  `build-deb.sh`, each with its own `CARGO_TARGET_DIR`. `micad` and `apid` carry
  the SAME embedded commit `498eeb824cda` in both roots, checked with `strings`.

### NOT sanctioned, and each needs an owner rather than a stanza

- **`/etc/systemd/system/multi-user.target.wants/ssh.service`, class `added`.**
  The composed image ships sshd ENABLED on a dev profile and the chain does not;
  `verify` fails it, 290/291. On the chain path
  `rootfs/scripts/network-and-ssh-units.sh:22` removes the link
  openssh-server's postinst leaves behind, and asserts it is gone. `policy-rc.d`
  stops a maintainer script STARTING a service during assembly and does nothing
  about its `[Install]` symlink. The owner is
  `mica-system:system` (`mica-system`), whose own Dockerfile already
  records the decision -- "There is deliberately NO
  multi-user.target.wants/ssh.service" -- as an ABSENCE, which cannot survive
  another package's postinst. It needs to be expressed actively.
- **6 `removed` and 1 `symlink` around `systemd-networkd` enablement.** The
  chain runs `systemctl enable systemd-networkd systemd-resolved`, which writes
  the primary link plus the unit's `Alias=` and three `Also=` units:
  `/etc/systemd/system/dbus-org.freedesktop.network1.service`,
  `sockets.target.wants/systemd-networkd.socket`,
  `network-online.target.wants/systemd-networkd-wait-online.service` and its
  directory, and `sysinit.target.wants/systemd-network-generator.service`.
  `mica-system` ships the primary link only, and spells its target
  `/lib/systemd/system/...` where `systemctl enable` writes
  `/usr/lib/systemd/system/...` -- which is the `symlink` record. Losing
  `systemd-networkd-wait-online.service` is the one with behaviour behind it:
  `network-online.target` then completes without waiting for a network. Owner:
  `mica-system:system`.
- **`/run/crun`, class `removed`.** Build residue: the chain EXERCISES the
  engine during assembly (`rootfs/scripts/podman-exercise.sh` runs `crun`),
  and the composer does not. The composed root is the correct one here. Owner of
  the decision: whoever owns `podman-exercise.sh`; it is not a path any package
  should install.
- **6 `content` in the account files** -- `/etc/passwd`, `/etc/passwd-`,
  `/etc/group`, `/etc/group-`, `/etc/gshadow`, `/etc/gshadow-`. What they are is
  measured, not inferred: `diff <(sort A) <(sort B)` is EMPTY for `/etc/passwd`
  and for `/etc/group`, so every account and group exists on both sides with the
  same uid and gid. Only the LINE ORDER differs, and only for two lines --
  `mica-mqttd` and `mica-mqtt-broker` are created in the opposite order, because
  the chain runs two account scripts in stage order and the composer gets dpkg's
  configuration order.

  They are benign and they are still NOT SANCTIONED, which is a decision and not
  an omission. A sanction is a (pattern, class) pair, so a `content` stanza over
  `/etc/passwd` covers every possible content difference at that path --
  including an account VANISHING from the composed root. That is exactly what
  the proof-material section above refuses to grant in advance, and
  `src/image/compare-roots.test.ts` asserts that no shipped stanza covers
  these paths. The ledger has no way to say "this content difference and not
  that one", so the honest state is unsanctioned-and-explained. Eliminating it
  would mean making the two account creations happen in one order on both
  paths, which is a producer change.

- **`/etc/shadow-` and `/usr/share/factory/etc/shadow`, class `content`.** These
  are two of the three paths L1 ruled may not be sanctioned, and they appear --
  but NOT as a regression in the fix. The composed side is the CORRECT one. The
  chain writes `20696` (2026-08-31) into the last-change field of `messagebus`,
  `sshd`, `systemd-network` and `systemd-resolve`; the composed root writes
  `18262` (2020-01-01) for all four.

  The mechanism was measured, not reasoned. `useradd` honours
  `SOURCE_DATE_EPOCH` for that field: in the pinned trixie base, `useradd -r
  probe` gives `20696` with the variable unset and `18262` with
  `SOURCE_DATE_EPOCH=1577836800`, which is exactly `1577836800 / 86400`. The
  composition declares `ARG SOURCE_DATE_EPOCH` so the whole apt transaction runs
  under it; `stages/10-base` and `stages/20-install` do not declare it, so the
  chain's postinsts see the wall clock. So the third non-reproducible surface
  this file documented is fixed on the composed path and still open on the
  chain, and the fix is to declare the argument in those two stage files.

### Two differences that were ELIMINATED rather than sanctioned

- **`/usr/sbin/policy-rc.d`, class `removed`.** Not ours and never was: the
  Debian docker image ships it, the chain never removed it, and it was going
  into the signed root where it answers 101 to every `invoke-rc.d`. No producer
  could own it, so the finalizer does --
  `rootfs/scripts/pack-strip-build-residue.sh`, which also carries the sshd
  host keys. Both paths now reach one answer through one file.
- **`/tmp/pool.names`, class `added`.** A scratch file the composer wrote and
  did not remove, shipping inside the signed root. Fixed in
  `compose-install.sh`, which now writes it under the removed `/mica-compose` and
  asserts `/tmp` is empty before it finishes.

### The four own-binary stanzas, and the road not taken

`/usr/bin/micad`, `/usr/bin/mica-apid`, `/usr/bin/mica-mqttd` and
`/usr/bin/mica-mqtt-broker` are sanctioned as plain `content` stanzas rather than
narrowed ones, and this section is why -- written for a reader who does not know
this campaign and is deciding whether the plain form was laziness.

**The two paths compile the same source.** Both roots at commit `5c470e98acaa`
carry that commit embedded in `micad` and `apid`, checked with `strings` on the
two extracted trees; `mica-mqttd` and `mica-mqtt-broker` read no build-commit
variable and carry none, which is itself a recorded fact rather than an absence
nobody looked at. There is no version skew here and no second source tree: the
chain compiles the four crates in ONE cargo invocation through
`micad:hack/build-target.sh` into `target/`, and the composer's packages
compile them two at a time through `build-deb.sh` into `target-deb/<producer>/`.

**What differs is the compilation environment, not the program.** rustc records
the paths it is handed, so a different `CARGO_TARGET_DIR` alone produces
different bytes. `mica-mqtt-broker` differs by about a megabyte for a second
reason of the same kind: the chain compiles four crates together and the
producers compile two, so cargo's feature resolver unifies a different set of
features across the shared dependency graph.

**The class evaporates when one path exists.** These four differences are
artefacts of building the same source twice in two harnesses. They are not a
property of the image, they cannot appear once the chain is gone, and there is
nothing here for a future reader to fix.

**The road not taken, and why.** These could be made byte-identical: rustc's
`--remap-path-prefix` for the recorded paths, and unifying the crate set so the
feature resolution matches -- a producer restructure, since the split into
`micad` and `mqtt` producers is the thing that changes it. That is real work, and
it would be spent making two build harnesses agree byte-for-byte for the benefit
of one comparison that retires with the chain it exists to retire. A narrowed
`expect-diff` stanza is the same trade in a smaller package: it would pin the
current bytes and go stale on the next commit that touches either crate, which
is a stanza rewritten on every unrelated change and therefore a stanza nobody
reads. So the plain form is the deliberate choice, and the measured sizes below
are what a reader compares against if they ever want to know whether the
difference changed shape.

## What an uefi-x64-only comparison does not cover

PLAN-036 section 6 runs this comparison on uefi-x64 only; cx3576 is then built and
verified through the composer alone. That is a ratified decision, and this
section is what it costs, stated so that a verdict printed by the gate is not
read as covering more than it does.

**The limit is not in the comparator.** It knows nothing about boards or
architectures: it walks two directories and reports what differs between them.
Pointed at two cx3576 roots on a host that can execute arm64 it would work
unchanged, with no flag to set and no code to add. So what an uefi-x64-only run buys
is exactly one thing -- the amd64 pair of roots -- and everything that differs
only on the arm64 side is outside the set it was HANDED, not outside what it can
see. That distinction matters practically: closing this gap later is a matter of
running the same command against two cx3576 roots.

Not covered, and each of these is a real difference between the two boards
rather than a hypothetical one:

- **Architecture-dependent package selection and dependency closure.** Every ELF
  in a cx3576 root is a different build -- micad, apid, mica-mqttd and
  mica-mqtt-broker from the aarch64 rust target, the seven engine binaries from
  `mica-podman:out-arm64`, rauc from `pkgs/rauc/out-arm64` -- and under the
  composer APT resolves the local and Debian dependency closure per
  architecture. A composition that resolves correctly for amd64 and wrongly for
  arm64 produces two trees this gate never saw.
- **Kernel and module handling**, which is arch-different but no longer
  structurally different, and the gap narrowed rather than closed. Until
  PLAN-074 uefi-x64 took kernel, initramfs and modules from Debian's
  `linux-image-amd64` and staged an EMPTY `modules.tar`, so the module payload
  path was UNEXERCISED on uefi-x64 rather than exercised at another architecture.
  Both boards now build their own kernel and ship their own `modules.tar`, so
  that path IS exercised here -- but with a different kernel version, a
  different config and 3 loadable modules against cx3576's vendor set. What
  stays uncovered is the arm64 payload, not the mechanism.
- **The cx3576 board payload**: the board's `bsp/rootfs` and `bsp/firmware`
  trees, the board overlay, and the per-board rendered
  `/etc/rauc/system.conf`, whose slot model comes from that board's `board.env`.
  None of it is in an uefi-x64 root at all, so no stanza here can ever have been
  written about it.

Two further boundaries belong in the same breath, because they are this
comparator's own rather than uefi-x64's, and a reader who assumed otherwise would
over-trust the verdict:

- It compares the **file tree of the packed root** and nothing else. Anything
  that is not a path inside a root is invisible to it: the
  `_out/<board>/` composition record and package-manager logs, the buildkit
  cache, and the squashfs + dm-verity encoding the device actually boots.
  `tests/factory-root-gate` is what ties the exported root back to the
  shipped image; this gate assumes that tie rather than re-checking it.
- It compares **no timestamps**. Both trees are `SOURCE_DATE_EPOCH`-pinned, but
  extraction carries no timestamp guarantee, so an mtime difference here would
  be a fact about tar. Reproducibility of the archives is gated elsewhere.

**What covers the gap instead**: the composed cx3576 image's own full verify run
and its smoke run. Both have to run on a host that can execute arm64. This
repository's smoke runner reports `executor-limited` under an emulated executor
-- a healthy line, and explicitly not a pass on the thing that was limited -- so
"covered by cx3576 verify" is a claim about a run on a binfmt-capable host, not
about one made here.

**And the escalation.** If a composed cx3576 verify ever fails in a way this
comparator would have caught had it been pointed at two arm64 roots -- a path
present in one composition and absent from the other, or a differing file type,
mode, uid, gid, symlink target, content hash or file capability -- that is
evidence against the uefi-x64-only choice, and it is to be reported to L1 rather than
fixed in place.

## Sanctions

### /usr/share/doc/**
- classes: added
- status: active
- reason: PLAN-036 section 6 sanctions package documentation as an expected addition. Promoted from pending by the measurement at commit 498eeb824cda, which is what the pending state was waiting for: this pattern matched exactly TEN added files, one `copyright` per local package (mica-apid, mica-board-uefi-x64, mica-ca-trust, mica-mqtt-broker, mica-mqttd, mica-podman, mica-profile-dev, mica-rauc, mica-system, micad). The chain installs those components by copying files into place and produces no such tree, so each has no counterpart on side A. The per-package Apache-2.0 copyright is a redistribution obligation this campaign requires, so these are payload rather than residue.

### /usr/share/doc/*
- classes: added
- status: active
- reason: The directory entry itself, which the pattern above does not cover -- `**` does not match zero path segments, so `/usr/share/doc/**` matches `/usr/share/doc/mica-system/copyright` and not `/usr/share/doc/mica-system`. Promoted with the same measurement and matching exactly TEN added directories, one per local package, against the ten files above. Same sanction, same reason; a separate stanza because one glob cannot express both.

### /usr/lib/mica/board
- classes: added
- status: active
- reason: The board-configuration directory `mica-board-uefi-x64` ships. PLAN-036 section 3 assigns the GRUB configuration to the board package, and boards/uefi-x64/deb/board-x64/Dockerfile records why it lands under /usr/lib/mica/board/<board>/ with its @BOOT_A_PARTNUM@ and @ROOTFS_A_PARTUUID@ placeholders intact: it is image-ASSEMBLY input rendered by the finalizer onto the ESP, and a copy rendered inside the producer would be a second rendering of one file. The chain has no counterpart because the assembler reads boards/uefi-x64/grub.cfg out of the tree instead. This stanza is the directory alone; the pattern below is its contents.

### /usr/lib/mica/board/**
- classes: added
- status: active
- reason: The contents of the directory above -- measured as exactly two added paths, `/usr/lib/mica/board/uefi-x64` and `/usr/lib/mica/board/uefi-x64/grub.cfg`. Separate stanza for the reason the two `/usr/share/doc` patterns are separate: `**` matches one or more path segments and never zero, so it cannot also cover the directory it descends from.

### /etc/passwd
- classes: content
- status: active
- expect-diff: |
    24 -mica-mqttd:x:970:970:mica MQTT bridge:/nonexistent:/usr/sbin/nologin
    24 +mica-mqtt-broker:x:969:969:mica MQTT broker:/nonexistent:/usr/sbin/nologin
    25 -mica-mqtt-broker:x:969:969:mica MQTT broker:/nonexistent:/usr/sbin/nologin
    25 +mica-mqttd:x:970:970:mica MQTT bridge:/nonexistent:/usr/sbin/nologin
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /etc/passwd-
- classes: content
- status: active
- expect-diff: |
    24 -mica-mqttd:x:970:970:mica MQTT bridge:/nonexistent:/usr/sbin/nologin
    24 +mica-mqtt-broker:x:969:969:mica MQTT broker:/nonexistent:/usr/sbin/nologin
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. This is the -backup, which glibc's account tools write as a snapshot of the file BEFORE their last write, so it holds one write less than its live counterpart and the transposition shows as a single replaced line rather than as a pair. Same cause, same two accounts. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /etc/group
- classes: content
- status: active
- expect-diff: |
    50 -mica-mqttd:x:970:
    50 +mica-mqtt-broker:x:969:
    51 -mica-mqtt-broker:x:969:
    51 +mica-mqttd:x:970:
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /etc/group-
- classes: content
- status: active
- expect-diff: |
    50 -mica-mqttd:x:970:
    50 +mica-mqtt-broker:x:969:
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. This is the -backup, which glibc's account tools write as a snapshot of the file BEFORE their last write, so it holds one write less than its live counterpart and the transposition shows as a single replaced line rather than as a pair. Same cause, same two accounts. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /etc/gshadow
- classes: content
- status: active
- expect-diff: |
    50 -mica-mqttd:!::
    50 +mica-mqtt-broker:!::
    51 -mica-mqtt-broker:!::
    51 +mica-mqttd:!::
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. This path is one of the three L1 ruled may never carry a bare sanction, and it carries a NARROWED one instead, which subsumes that rule rather than weakening it. The last-change field is pinned into the expected diff as 18262, so the date regression the rule was written about -- Debian's postinst accounts dating themselves with the build day -- changes these rows and fails. Measured before this stanza existed: forcing that field to 18262 on both sides left exactly the transposition below, which is how the date cause and the ordering cause were told apart. rootfs/scripts/account-pin-shadow-dates.sh in the shared finalizer is what removes the date cause on both paths. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /etc/gshadow-
- classes: content
- status: active
- expect-diff: |
    50 -mica-mqttd:!::
    50 +mica-mqtt-broker:!::
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. This path is one of the three L1 ruled may never carry a bare sanction, and it carries a NARROWED one instead, which subsumes that rule rather than weakening it. The last-change field is pinned into the expected diff as 18262, so the date regression the rule was written about -- Debian's postinst accounts dating themselves with the build day -- changes these rows and fails. Measured before this stanza existed: forcing that field to 18262 on both sides left exactly the transposition below, which is how the date cause and the ordering cause were told apart. rootfs/scripts/account-pin-shadow-dates.sh in the shared finalizer is what removes the date cause on both paths. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /etc/shadow-
- classes: content
- status: active
- expect-diff: |
    24 -mica-mqttd:!:18262::::::
    24 +mica-mqtt-broker:!:18262::::::
    25 -mica-mqtt-broker:!:18262::::::
    25 +mica-mqttd:!:18262::::::
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. This path is one of the three L1 ruled may never carry a bare sanction, and it carries a NARROWED one instead, which subsumes that rule rather than weakening it. The last-change field is pinned into the expected diff as 18262, so the date regression the rule was written about -- Debian's postinst accounts dating themselves with the build day -- changes these rows and fails. Measured before this stanza existed: forcing that field to 18262 on both sides left exactly the transposition below, which is how the date cause and the ordering cause were told apart. rootfs/scripts/account-pin-shadow-dates.sh in the shared finalizer is what removes the date cause on both paths. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /usr/share/factory/etc/shadow
- classes: content
- status: active
- expect-diff: |
    24 -mica-mqttd:!:18262::::::
    24 +mica-mqtt-broker:!:18262::::::
    25 -mica-mqtt-broker:!:18262::::::
    25 +mica-mqttd:!:18262::::::
- reason: The two service accounts mica-mqttd (970) and mica-mqtt-broker (969) are created in the opposite order on the two paths: the chain runs rootfs/scripts/account-mica-mqttd.sh and account-mica-mqtt-broker.sh in stage order, and the composer gets dpkg's configuration order, which set up mica-mqtt-broker first. Both orders are deterministic within their own path and neither is wrong, so this is an artefact of having TWO paths and it cannot exist once there is one. Measured, not argued: `diff <(sort A) <(sort B)` over this file is EMPTY, so both roots hold the same entries with the same uid and gid, and only the position of two lines differs. This path is one of the three L1 ruled may never carry a bare sanction, and it carries a NARROWED one instead, which subsumes that rule rather than weakening it. The last-change field is pinned into the expected diff as 18262, so the date regression the rule was written about -- Debian's postinst accounts dating themselves with the build day -- changes these rows and fails. Measured before this stanza existed: forcing that field to 18262 on both sides left exactly the transposition below, which is how the date cause and the ordering cause were told apart. rootfs/scripts/account-pin-shadow-dates.sh in the shared finalizer is what removes the date cause on both paths. The expected diff is what makes this safe to sanction at all. A bare `content` stanza here would equally cover an account VANISHING from the composed root, which is the failure this comparison exists to catch; with the diff named, a vanished account shifts every following line, a third line moving adds rows, and a field changing inside a transposed line changes one -- each produces a different canonical diff and each still FAILS.

### /usr/bin/micad
- classes: content
- status: active
- reason: The management daemon, compiled twice: by the chain through micad:hack/build-target.sh into target/, and for the composer by the micad producer through build-deb.sh into target-deb/micad/. Measured at commit 5c470e98acaa: BOTH roots carry that commit embedded, found with `strings`, and the sizes are 8,887,880 bytes on the chain against 8,892,200 composed -- a delta of 4,320 in 8.9 MB. See "The four own-binary stanzas, and the road not taken" above for why this is plain rather than narrowed: the two paths compile the same source in different build contexts, the difference is compilation-environment noise, the class evaporates when one path exists, and making the two byte-identical is a producer restructure spent on a comparison that retires with the chain.

### /usr/bin/mica-apid
- classes: content
- status: active
- reason: The HTTP API daemon, from the same producer and the same pair of cargo invocations as /usr/bin/micad. Measured at commit 5c470e98acaa: both roots carry that commit embedded, and the sizes are 12,386,744 bytes on the chain against 12,388,272 composed -- a delta of 1,528 in 12.4 MB. See "The four own-binary stanzas, and the road not taken" above for why this is plain rather than narrowed: the two paths compile the same source in different build contexts, the difference is compilation-environment noise, the class evaporates when one path exists, and making the two byte-identical is a producer restructure spent on a comparison that retires with the chain.

### /usr/bin/mica-mqttd
- classes: content
- status: active
- reason: The MQTT bridge, from the OTHER producer: the mqtt producer compiles it and mica-mqtt-broker into target-deb/mqtt/, so the composed pair comes from a third cargo target directory. It reads no build-commit variable, so neither copy carries a commit string to compare -- recorded rather than left as an absence nobody checked. Measured at commit 5c470e98acaa: 6,944,720 bytes on the chain against 6,944,712 composed, a delta of 8 bytes in 6.9 MB. See "The four own-binary stanzas, and the road not taken" above for why this is plain rather than narrowed: the two paths compile the same source in different build contexts, the difference is compilation-environment noise, the class evaporates when one path exists, and making the two byte-identical is a producer restructure spent on a comparison that retires with the chain.

### /usr/bin/mica-mqtt-broker
- classes: content
- status: active
- reason: The broker, from the mqtt producer, and the one of the four where the difference is LARGE rather than incidental: 7,616,416 bytes on the chain against 6,533,472 composed, 1.03 MB smaller. The extra mechanism is cargo's feature resolver -- the chain compiles four crates in one invocation and the producers compile two, so a different set of features is unified across the shared dependency graph. That is a consequence of the producer split PLAN-036 section 2 asks for, not of the composition. It reads no build-commit variable, like mica-mqttd. The size is recorded so that a future change in it is legible as a change in what the split does. See "The four own-binary stanzas, and the road not taken" above for why this is plain rather than narrowed: the two paths compile the same source in different build contexts, the difference is compilation-environment noise, the class evaporates when one path exists, and making the two byte-identical is a producer restructure spent on a comparison that retires with the chain.

