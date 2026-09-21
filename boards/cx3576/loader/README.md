# U-Boot 与 Maskrom 恢复资产

`MiniLoaderAll.bin` 是从已核验的原厂
`factory/rk3576_linux6.1_20260727.171210.img` 提取并固定进入仓库的 RK3576 恢复 Loader。
它只用于设备处于 Maskrom 时通过 `rkdeveloptool db` 临时下载，不会嵌入
`out/disk.img`，也不是 mainline U-Boot 的构建输入。

已核对的信息：

- 文件大小：786,937 bytes
- SHA-256：`28a08408d01a3a8f1ce455de7be5e76297a241809f27feef8a74752f9d635879`
- USB-PLUG：`2017.09-g13ceb2afdcb-241106`，构建于 2024-11-07
- DDR firmware：v1.12，标识 `ef40306b8f`
- 目标 SoC：RK3576

校验：

```sh
shasum -a 256 -c loader/MiniLoaderAll.bin.sha256
```

Maskrom 整盘恢复：

```sh
make flash-maskrom
```

刷写从 `db` 开始到 `rd` 完成期间禁止断电、拔掉 USB 或复位设备。该 Loader 是原厂
二进制恢复资产，重新替换时必须同步更新本文件、校验文件和实机验证记录。
