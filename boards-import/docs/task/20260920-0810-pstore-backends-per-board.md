# 20260920-0810-pstore-backends-per-board Can these boards say why they rebooted

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 08:10

Asked by the coordinator because every board's forced command line carries
`panic=5` and the hardware boards run watchdogs: a panic-then-reboot is
designed behaviour, and `systemd-pstore` -- the unit that would collect the
evidence -- is not enabled in any product. Whether that unit would have
anything to collect is a kernel question. Read from the shipped configs.

    symbol              uefi-x64  uefi-arm64  cx3576  s905x5m
    PSTORE              NOT SET   y           y       y
    PSTORE_RAM          --        not set     y       y
    PSTORE_CONSOLE      --        not set     y       y
    PSTORE_PMSG         --        not set     not set y
    PSTORE_DEFLATE      --        --          y       --
    EFI_VARS_PSTORE     --        y           y       y
    ACPI_APEI           NOT SET   y           --      --

**Three of four have a backend; uefi-x64 has no pstore at all.**

- **cx3576 -- confirmed working on hardware, not merely compiled.** The
  2026-09-20 capture shows the backend registering and taking the console:

      267  ramoops: dmesg-00x18000@0x0000000040400000
      271  printk: console [ramoops-1] enabled
      272  pstore: Registered ramoops as persistent store backend
      650  pstore: Using crash dump compression: deflate

  The region is a carve-out this repository placed deliberately
  (`boards/cx3576/kernel/dts/rk3576-cx3576z.dts`, whose comment records that
  the loader must not scribble on it).
- **s905x5m** has `PSTORE_RAM=y` and its own `ramoops@0x07400000` node in
  `boards/s905x5m/kernel/dts/s7d_s905x5m_m100.dts`. Compiled and declared;
  never observed on hardware, like everything else on that board.
- **uefi-arm64** has `PSTORE=y` with `EFI_VARS_PSTORE=y` and `ACPI_APEI=y`, so
  its backends are EFI variables and, where firmware provides it, ERST. No RAM
  backend, which is right for a machine whose memory map is the firmware's.
- **uefi-x64** has `# CONFIG_PSTORE is not set` and no APEI: **nothing would be
  collected there.**

## So the answer to "repair or project"

For cx3576, s905x5m and uefi-arm64 it is a REPAIR: the backend exists, and
enabling `systemd-pstore` is a one-path declaration in the composed root --
`mica-build`'s half. On cx3576 the evidence is already being written to the
ramoops region at every boot and nothing is collecting it into
`/var/lib/systemd/pstore`.

For uefi-x64 it is a small kernel change first (`PSTORE` plus a backend --
`EFI_VARS_PSTORE`, or `ACPI_APEI`/ERST where firmware has it), and until then
the unit would be inert there. That is a decision worth taking with the round
that is already opening this board's config, not separately: **a fleet where
three boards can explain a reboot and one cannot is worse than either uniform
answer.**

Not measured: what `PSTORE` plus `EFI_VARS_PSTORE` costs uefi-x64 in bytes.
That is one control-and-experiment build in the same shape as the others and
belongs in the round if the user wants the fourth board to answer too.
