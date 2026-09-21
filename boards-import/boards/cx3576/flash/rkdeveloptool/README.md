# macOS rkdeveloptool

参考 Radxa 的 macOS 主机流程，从 Rockchip 官方源码构建原生
`rkdeveloptool`。构建固定到上游提交
`304f073752fd25c854e1bcf05d8e7f925b1f4e14`，并应用上游 PR #126 中针对
macOS 26/Clang 的两行最小 VLA 修复。构建还包含一个范围受限的兼容补丁：把
`bcdDevice=0x7ea7` 且错误报告 `bcdUSB=0x0200` 的早期 CX3576-Z U-Boot v2026.07
RockUSB 识别为 Loader，以便刷入已修正描述符的新镜像。

`flash/rkdeveloptool/` 只保存第三方构建逻辑；编译后的可执行文件输出到
`flash/tools/rkdeveloptool`。

安装构建和运行依赖：

```sh
brew install autoconf automake libusb pkg-config
```

在仓库根目录构建：

```sh
make rkdeveloptool-macos
export PATH="$PWD/tools:$PATH"
```

输出位置为 `flash/tools/rkdeveloptool`。`make flash-mica` 和
`make flash-maskrom` 会优先使用这个本地产物；不存在时回退到
`PATH` 中的 `rkdeveloptool`。

运行时仍需 Homebrew `libusb`，可用以下命令检查：

```sh
rkdeveloptool -v
rkdeveloptool ld
```
