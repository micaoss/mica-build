# uefi-arm64

The uefi-arm64 board of Mica OS: the generic UEFI/ACPI arm64 machine (user,
2026-09-16 -- the generic systems are uefi-x64 and uefi-arm64; cx3576 and
s905x5m are the hardware boards). QEMU's aarch64 `virt` is one such machine and
the one the assembly's acceptance suites drive; the kernel carries the storage
a UEFI machine boots from (virtio, NVMe, AHCI/SATA, USB) built in, and the
physical NIC families as modules. Its contents: the board definition
(`board.env`), the kernel build (`kernel/`), the board package (`package/`) and the
board evidence (`evidence.json`). One board of `micaoss/mica-boards`; `make uefi-arm64-kernel`, `make pool` and
`make publish` at the repository root build, pack and release it.


The kernel embeds the dm-verity trust certificate of the deployment it will
boot: `VERITY_TRUST_CERT` (default `meta/verity/signer.cert.pem`, the
public certificate the assembly supplies). The board's board component ships
that certificate, and the assembly (`micaoss/mica-build`) refuses a kernel built
against another one. The
assembly imports the packages through `deps/packages/` and builds none of
them.
