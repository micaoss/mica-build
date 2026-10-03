# uefi-x64

The uefi-x64 board (UEFI, systemd-boot, QEMU and generic PCs) of Mica OS: the board definition
(`board.env`), the kernel build (`kernel/`), the board package (`package/`) and the
board evidence (`evidence.json`). `make uefi-x64-kernel` and
`make board-pool` build its kernel and its package; a release of one of its products publishes them.

The kernel embeds the dm-verity trust certificate of the deployment it will
boot: `VERITY_TRUST_CERT` (default `meta/verity/signer.cert.pem`, the
public certificate the assembly supplies). The board's board component ships
that certificate, and the assembly refuses a kernel built against another one.
