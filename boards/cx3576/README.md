# cx3576

The cx3576 board (Rockchip RK3576, signed FIT boot through U-Boot) of Mica OS: the board definition
(`board.env`), the kernel and U-Boot builds (`kernel/`, `loader/`, `bsp.env`), the board package (`package/`) and the
board evidence (`evidence.json`). One board of `micaoss/mica-boards`; `make cx3576-kernel`, `make pool` and
`make publish` at the repository root build, pack and release it.


The kernel embeds the dm-verity trust certificate of the deployment it will
boot: `VERITY_TRUST_CERT` (default `meta/verity/signer.cert.pem`, the
public certificate the assembly supplies). The board's board component ships
that certificate, and the assembly (`micaoss/mica-build`) refuses a kernel built
against another one. The
assembly imports the packages through `deps/packages/` and builds none of
them.
