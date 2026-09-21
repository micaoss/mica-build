# 20260920-cx3576-first-hardware-capture What the first cx3576 console capture establishes

- **status**: open
- **priority**: P1
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20

## What it is

The first console capture of Mica OS running on cx3576 silicon, reported by
the user on 2026-09-20. 1256 lines, sha256
`26fc740724a1c11962b3a0a696f80f617e5906ee3b1c5bf37d080b0341f267ef`. Every
statement below was read out of that file here, not taken from a summary.

**It has no durable home yet.** It arrived as a coordination-session upload,
and an evidence note may not cite one. It also carries the unit's SoC serial
(`rockchip-cpuinfo cpuinfo: Serial: d6aa8e0ed78890f8`), from which this
project derives the hostname and MAC, so where it is kept is a decision about
publishing a device identity and not only about storage. Until that is
decided, this record cites the file by its sha256.

## What the capture establishes, verified line by line

- **The vendor loader executed our signed FIT on real silicon.** Three
  `Verifying Hash Integrity ... sha256,rsa2048:mica+ OK` lines (kernel, fdt,
  ramdisk), at lines 95, 111 and 128.
- **The forced command line is the one this repository signs**: line 176
  carries `dm_verity.require_signatures=1 ... mica.profile=prod`, so this unit
  ran the **prod** profile.
- **The kernel is the one we published, by identity**: line 151 is
  `Linux version 6.1.115 (mica@mica-build) ... aarch64-linux-gnu-gcc (Ubuntu
  13.3.0-6ubuntu2~24.04.1) 13.3.0 ... #1 SMP @1577836800`. `6.1.115` is
  exactly the `kernel/prod/kernel.release` published by
  `cx3576.20260917-1007`, which `mica-build`'s `cx3576.20260919-2356`
  (`f46b64a6`) pinned -- so the run binds to published bytes through the
  locks, not to "the latest build". `#1 SMP @1577836800` is our
  `KBUILD_BUILD_VERSION=1` and `SOURCE_DATE_EPOCH`, and the compiler is the
  bsp image's Ubuntu gcc 13.3.0: the reproducibility settings and the pinned
  toolchain, visible on hardware.
- **Our PID 1 ran and authenticated the deployment**: `mica-init: selected
  deployment 745f0b9f...` (line 847) and `verified deployment ...; support
  mounted before system init` (line 862).
- **The system reached a healthy state**: `mica-health.service` -- the unit
  that confirms the authenticated deployment -- finished (line 1243),
  `mica-status-led` ran boot red to ready blue (line 1245), and the login
  prompt appeared.
- **The unit, as far as the log names it**: machine model `CX3576-Z (RK3576)`,
  eMMC `mmcblk0: mmc0:0001 SCA128 116 GiB` in HS400 Enhanced strobe with
  `mmcblk0boot0/boot1/rpmb`, 8 GiB LPDDR4X at 2112 MHz.

## What it does NOT establish, and this is the part to get right

- **It is not row 1 and it is not row 2.** The capture opens at a U-Boot
  prompt with `=> reset` (lines 2-3) and BL31 reports `soc warm boot, reset
  status: 0x1` (line 60). Row 1 is power-on from cold, repeatably. Row 2 is
  "reboot from a running system"; this reset was issued from the LOADER
  console, and nothing in the capture says what ran before it. So it is
  neither row, and writing either one from this file would be the same
  mistake in two directions. What is needed is one capture beginning with
  power applied to a cold unit (row 1, two or three times, each with the
  health readout) and one beginning with `reboot` typed at a running Mica OS
  prompt (row 2).
- **It is not row 13.** Row 13 is a documented flash onto a blank unit over
  the board's own transport; this unit was already provisioned.
- **The radio MODULE SKU is not in it; the CHIP identified itself.** An
  earlier version of this record said there was "no chip identification".
  That was wrong, and the fault was in the reading, not the file: the grep
  that produced it was truncated at ten lines and the Wi-Fi probe is at 1146.
  What the part actually answered, over SDIO:

      aicbsp: aicbsp_sdio_probe:1 vid:0xC8A1  did:0x0082      (line 1146)
      aicbsp: aicbsp_sdio_probe:2 vid:0xC8A1  did:0x0182      (line 1147)
      AICWFDBG(LOGINFO)aicwf_sdio_chipmatch USE AIC8800D80    (line 1150)
      AICWFDBG(LOGINFO)aicbsp: ... chip rev: 7                (line 1154)
      aicbsp: bt patch version: - Dec 05 2023 15:53:41 - git 487f432 (line 1170)

  The vendor and device IDs and the revision are read FROM the part; the
  driver's `AIC8800D80` is the name it matched those IDs to, not an
  unconditional string. So the chip identity and its revision are observed
  facts from this bench, worth keeping for the first time two units differ.
  What remains open is the MODULE SKU -- the part around the chip -- which is
  what the dossier field asks for.

  Nothing else about the radios is observed: Bluetooth reached its target and
  `mica-bt.service` attached HCI over UART with no association and no
  transfer, and Ethernet gave `r8168: eth1: link up` (line 1251), which is
  link and not transfer. Neither is row 6.
- **Rows 3, 4 and 12 -- A/B update, power-cut and recovery -- are untouched**,
  and they are the three that make a board supported rather than booting.

## The assurance ladder does not move, and one sentence in it does

`mica:docs/boards/assurance.md` says of I3 that the software results "do not
establish enforcement on an untested physical board". The positive half is now
observed: on 2026-09-20 the vendor loader verified our key on real silicon
(`rsa2048:mica+ OK`). The negative half -- an altered or unsigned FIT refused
on the same bench -- is absent, and I2's authenticated-update evidence is
absent, so `boards/cx3576/evidence.json` stays **I1**. Its `qualification`
records the observation and its date; the grade is unchanged and nothing in
this record claims the board is qualified.

## Still to be asked of the person at the bench

1. A cold-boot capture, two or three power-on cycles, each ending with the
   health readout (row 1).
2. A capture beginning with `reboot` at a running prompt (row 2).
3. `uname -r`, `cat /proc/cmdline` and the micad health output pasted into the
   same log, so the run is self-identifying without cross-referencing.
4. The board revision, the eMMC part number as printed on the part (the log
   gives the card's `SCA128` name, not the manufacturer's part) and the radio
   module SKU.
5. Where the capture may be kept, given the SoC serial it contains.

## The reading rule this round produced

A `head` or a truncated grep is a fine way to LOOK at a file and a bad way to
CONCLUDE about one. The claim "no chip identification" above came from a
window ten lines wide over a file whose answer is at line 1146; every positive
claim in the same reading was tied to a line number and every one of them
held. That asymmetry is the rule: **an absence is a property of the SEARCH
until it is a property of the FILE**, so a negative claim needs a search that
ran to completion, and it inherits the aperture of whatever produced it.

The coordinator reports this as the third instance of the same shape in two
days across three repositories and three kinds of tool -- a query filtered by
a tag prefix that could not see the older tag form, a coverage join keyed on a
pattern that missed the rows it was quoting, and this grep. None of the three
looked truncated in its output; each read like a finished answer.
