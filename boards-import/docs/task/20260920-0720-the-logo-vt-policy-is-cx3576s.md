# 20260920-0720-the-logo-vt-policy-is-cx3576s Whose policy the tty1 logo and tty2 console are

- **status**: done
- **priority**: P3
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 07:20

## Where the logo actually comes from, since the drop-in does not draw one

The comment in `boards/cx3576/package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf`
says "keep the logo VT idle", and the coordinator is right that the drop-in
only prevents a getty from covering a logo. On cx3576 the logo is real and it
comes from the **kernel**:

- `CONFIG_LOGO=y` and `CONFIG_LOGO_LINUX_CLUT224=y` in the resolved config --
  cx3576 only (`# CONFIG_LOGO is not set` on uefi-x64 and s905x5m; on
  uefi-arm64 the symbol is not even offered, since that board has no
  framebuffer);
- the image is rendered into the kernel tree at build time by
  `common/kernel/mklogo.py` from the committed brand master, in the board's
  kernel prepare hook, rather than a 2.2 MB PPM being committed;
- it is placed by the board's forced command line:
  `fbcon=logo-pos:center,logo-count:1` in `BOARD_CMDLINE_ARGS`.

Not plymouth, not the overlay, not the loader. So the comment describes a
state and not an intent, and the 2026-09-20 capture shows the framebuffer it
is drawn on coming up (`Console: switching to colour frame buffer device
240x67`, HDMI 1920x1080p60).

## 1. It is cx3576's policy, and it is conditional on a capability

The rule the file really encodes is **a board that draws a boot logo keeps
the logo VT idle**. cx3576 is the only board that draws one, so it is the only
board the policy has anything to protect. It is not a product-wide intent, and
the other three boards are not following a quieter version of it: they have no
logo for a getty to cover.

Which means the other three having no tty1 console is explained by nothing:
the Base root ships `getty.target.wants/getty@tty1.service` and the composer
drops it from every product. On cx3576 that loss coincides with this policy;
on the other three it is an accident. **That is a defect to repair in product
composition, not something a board overlay should paper over** -- a board
overlay that re-enabled tty1 would be a board repairing a composer, which is
the wrong repository holding the fix.

## 2. If it were ever the intent everywhere, where it should live

Not Base: `mica-system-base` is right that Base has no logo, and a policy
about a logo does not belong beside a component that cannot have one.

Not a shared board overlay either, and this is the part worth arguing: the
policy is not BOARD-shared, it is CAPABILITY-shared. It belongs with whatever
decides the board draws a logo -- today the board's own overlay, and if a
second board gains a logo, a shared fragment selected by the same flag that
turns `CONFIG_LOGO` on, so the policy cannot drift from the thing it protects.

**And a board without a display should not carry a VT policy at all.** On
uefi-arm64 there is no framebuffer, so `NAutoVTs=0` would be a rule about
nothing -- and a rule about nothing is what a later reader deletes or
generalises wrongly. On uefi-x64 it would be actively harmful: that board can
render on the EFI framebuffer and on virtio-gpu in a guest, so `NAutoVTs=0`
there would remove a VT login that works, to protect a logo that does not
exist.

## 3. The concrete consequence for s905x5m

s905x5m declares `display`, has a framebuffer and a DRM driver, and has
neither a logo nor this drop-in. That is consistent today -- no logo, nothing
to keep idle -- and it is the board to look at first if a boot logo is ever
wanted beyond cx3576: it would need `CONFIG_LOGO`, the `mklogo.py` hook in its
kernel prepare step, `fbcon=logo-pos:` in its forced command line, and only
then this drop-in. Four things, in that order, and the drop-in last.

## What a person with a monitor meets today, stated plainly

Putting the three boards' state in the form someone can picture: uefi-x64 has
no logo and, with the enablement link dropped in composition, no tty1 getty
either -- so tty1 shows kernel messages and then nothing. No logo, no prompt,
a dead VT. That is the concrete shape of the composer defect on a generic
board, and it is a better sentence to put to a user than "the enablement
symlink is absent". cx3576 is the one board where tty1 is deliberately quiet
and has something to show for it.

## The cursor is part of the same decision, 2026-09-20

`vt.global_cursor_default=0` was on cx3576 alone. Once the other three boards
gained a logo they would each have blinked a cursor on top of it -- the same
half-decision as a logo nobody can type under, and the half a user sees on
every boot rather than in a file. All four now carry it, and the logo
equivalence in `tests/board-contract-test.sh` counts the command-line artefact
only when BOTH words are present, with a fixture for each half.

## /etc/vconsole.conf: the question that was left, and my answer

Two questions were wearing one name. The dropped-file half is dissolved --
`mica-build` measured that `/etc/vconsole.conf` is not in the Base root at
all, so nothing drops it. What remains is whether Mica OS should ship one.

**It should, and not from here.** A keymap is not board-conditional: every
board with a keyboard wants the same default, and by the rule this repository
argued for the logind drop-in -- a policy belongs with whatever decides the
capability it depends on -- a file that is identical on every board is not
board policy. Shipping it from four board overlays would be four copies of one
decision, which is the shape this round has spent the day removing.

So the recommendation to whoever owns it (`mica-system-base` for system
policy, or `mica-build`'s composition): ship ONE `/etc/vconsole.conf` with an
explicit `KEYMAP=`. The reason to ship it rather than rely on the default is
that the default is invisible: `systemd-vconsole-setup` picks `us` when the
file is absent, so the fleet's keymap today is a fact nobody wrote down, and
the first board that wants another one has nowhere to say so.
