# Alpine rootfs 维护方式

`rootfs/` 的目录结构直接对应目标机的 `/`。静态配置、OpenRC 服务和板端脚本应放在这里，
例如：

```text
rootfs/etc/network/interfaces       -> /etc/network/interfaces
rootfs/etc/init.d/rk-board          -> /etc/init.d/rk-board
rootfs/usr/local/bin/...            -> /usr/local/bin/...
```

Dockerfile 使用 `COPY rootfs/ /` 安装这层文件。只有以下动态构建动作留在 Dockerfile：

- 安装 Alpine 软件包并创建调试账号；
- 注入与当前内核配套的模块和已核定的 AIC8800D80 固件；
- 用 `rc-update` 建立与已安装软件包对应的 runlevel 链接；
- 校验配置并生成 ext4 镜像。

新增 init 脚本或板端命令时要保留可执行位。`sudoers.d/wheel` 的 `0440` 权限由构建阶段
显式设置，因为 Git 只保存“是否可执行”，不能保存完整 Unix 权限位。
