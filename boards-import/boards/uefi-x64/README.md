# uefi-x64

The uefi-x64 board (UEFI, systemd-boot, QEMU and generic PCs) of Mica OS: the board definition
(`board.env`), the kernel build (`kernel/`), the board package (`package/`) and the
board evidence (`evidence.json`). One board of `micaoss/mica-boards`; `make uefi-x64-kernel`, `make pool` and
`make publish` at the repository root build, pack and release it.


The kernel embeds the dm-verity trust certificate of the deployment it will
boot: `VERITY_TRUST_CERT` (default `meta/verity/signer.cert.pem`, the
public certificate the assembly supplies). The board's board component ships
that certificate, and the assembly (`micaoss/mica-build`) refuses a kernel built
against another one. The
assembly imports the packages through `deps/packages/` and builds none of
them.
