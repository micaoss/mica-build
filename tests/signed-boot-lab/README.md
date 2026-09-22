# signed-boot-lab

The drivers behind P1-A of the file-based A/B plan
(`mica:docs/plan/20260908-1428-file-ab-signed-components.md`): the kernel's
public-key dm-verity check, the U-Boot FIT signature enforcement, and the
systemd-boot shared-UKI entries. They are here rather than in a scratch
directory because the record's evidence has to be re-runnable from the branch,
and because P4/P6 turn these same cases into permanent fault-matrix tests.

Nothing here runs in CI yet: every entry script wants an artefact this
repository builds (a kernel, a composed root, an assembled image) and several
take minutes of QEMU. They are run by hand, against artefacts named on the
command line.

## First

```
bash pkgs/rauc/gen-dev-keys.sh --domain verity   # the development anchor, once
bash tests/signed-boot-lab/images.sh             # the lab and guest images
bash tests/signed-boot-lab/images.sh --uboot     # and the U-Boot sandbox
```

Work lands in `_out/signed-boot-lab/` (`MICA_LAB_WORK` overrides it). Every
container is labelled `ai-agent=true` and named `ai-agent-signed-boot-lab-*`.

## Entry scripts

| Script | Proves | On |
|---|---|---|
| `verity-matrix.sh` | the kernel authenticates a root hash: valid accepted, absent/unrelated-key/modified/truncated and a valid signature over another root's hash all refused with the kernel's own errno; a modified block reads EIO under a mapping the signature still authorises; the same kernel takes a SECOND signed root and switches its root onto each | any board kernel, in QEMU, from an initramfs -- no disk, no bootloader |
| `fit-sandbox.sh` | U-Boot with a `required = "conf"` key refuses an unsigned FIT, one signed by an untrusted key, and one whose kernel, DTB or initramfs changed after signing | the U-Boot **sandbox** at the board's own commit -- not the board |
| `cx3576-control-fdt.sh` | the board's own U-Boot control FDT takes that key, and by how many bytes it grows | the cx3576 U-Boot artefact |
| `uefi-uki.sh` | two Type #1 entries share one signed UKI; boot counting spends one entry and falls to the other; `LoaderEntrySelected` reaches early init without the counter suffix; the entry's `options` do not reach the command line under Secure Boot; a modified UKI is refused | QEMU with development keys enrolled and Secure Boot on (OVMF or AAVMF) |
| `key-lifecycle.sh` | P2: signed verity before certificate validity and after expiry; root's attempt to revoke the built-in content key; missing/untrusted signatures still refused | uefi-x64 QEMU, using a P1 kernel/initramfs and its public development certificate |

Each script's own header says the same thing at length, including what it does
NOT prove. Read it before quoting a run.

For the P2 lifecycle probe, build its host image with
`bash tests/signed-boot-lab/images.sh --lifecycle`, then run
`bash tests/signed-boot-lab/key-lifecycle.sh KERNEL INITRAMFS CERTIFICATE` under
tmux. The initramfs must contain P1's signed payload and `init-matrix.sh`.
The probe uses guest dates 2020-01-01 and 2045-01-01; the development
certificate must start after the former and expire before the latter.
Outputs and console logs are kept in a fresh `_out/p2-lifecycle.*` directory.

## The two things a reader will trip over

`verity-matrix.sh` on the **cx3576 vendor kernel** needs
`--append initcall_blacklist=rockchip_drm_init`: that initcall makes a Rockchip
SiP SMC QEMU does not implement, and PID 1 takes an undefined-instruction Oops
without it. It also needs a kernel built with `CONFIG_SERIAL_AMBA_PL011=y` --
the board has an 8250 and QEMU's `virt` machine has a PL011, so a stock board
build boots with no console at all and looks like a hang. Build that variant by
pointing `--build-context mica-common=` at a copy of
`mica-boards:common/kernel/mica-required.fragment` with the two PL011 lines appended;
nothing else in the configuration changes, and neither symbol touches
dm-verity, the keyring or PKCS#7.

`prepare-payload.sh` takes `A_SRC` and `B_SRC` and has no defaults for either.
A default pointing at one checkout's `_out` is what made the first version of
this lab unrunnable anywhere else.

Current complete-image acceptance uses `tests/suites/lifecycle-uefi/runtime-build.sh`,
`boot.sh`, and `updates.sh` with Secure Boot enabled. The component-update
sequence proves one kernel accepts distinct signed roots without rewriting BSP
outputs. Signature refusal coverage remains in this directory, native component
tests, and `tests/lifecycle-uboot-fit/signatures.sh`; no raw-slot boot harness remains.
