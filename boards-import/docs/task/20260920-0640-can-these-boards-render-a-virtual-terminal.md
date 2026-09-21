# 20260920-0640-can-these-boards-render-a-virtual-terminal The kernel half of the VT question

- **status**: done
- **priority**: P3
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 06:40

Facts only; nothing changed. The userspace half -- whether a getty exists on
tty2, and whether `autovt@ttyN` is activated on demand by logind -- is
`mica-build`'s. This is the half underneath: can the kernel render a virtual
terminal at all, and is there a keyboard path to type into it.

## Read from the shipped configs

    symbol                         uefi-x64  uefi-arm64  cx3576  s905x5m
    CONFIG_VT                      y         y           y       y
    CONFIG_VT_CONSOLE              y         y           y       y
    CONFIG_VT_HW_CONSOLE_BINDING   y         y           y       y
    CONFIG_FRAMEBUFFER_CONSOLE     y         absent      y       y
    CONFIG_FB                      y         NOT SET     y       y
    CONFIG_FB_EFI                  y         absent      n       n
    CONFIG_DRM                     y         NOT SET     y       y
    CONFIG_DRM_FBDEV_EMULATION     NOT SET   absent      y       y (vendor: AMLOGIC_DRM_EMULATE_FBDEV=y)
    display driver                 i915=y, virtio-gpu=y  none    DRM_ROCKCHIP=y   AMLOGIC_DRM=m, AMLOGIC_VOUT=y
    CONFIG_INPUT_KEYBOARD          y         NOT SET     y       y
    CONFIG_USB_HID / HID_GENERIC   y         y           y       y
    CONFIG_LOGO                    n         absent      y       n

**The VT layer exists on all four**, so `autovt@ttyN` has something to attach
to everywhere. What differs is whether anything can DRAW it.

- **uefi-arm64 cannot.** `CONFIG_FB` and `CONFIG_DRM` are both explicitly not
  set and `CONFIG_INPUT_KEYBOARD` with them -- the trim that made this the
  generic UEFI/ACPI image left no framebuffer, no DRM and no keyboard driver
  class. A person with a monitor on this board sees nothing, by construction.
  Its serial console is the console. It declares no `display` feature, so
  nothing is promised that is not delivered.
- **cx3576 can, and does** -- see the hardware evidence below.
- **s905x5m should**, on the vendor stack (`AMLOGIC_DRM=m` with
  `AMLOGIC_DRM_EMULATE_FBDEV=y` and `AMLOGIC_VOUT=y`), with one caveat worth
  stating: the DRM driver is a MODULE there, so the console appears only once
  that module is loaded. Unmeasured on hardware.
- **uefi-x64 is the ambiguous one.** It has the EFI framebuffer
  (`FB_EFI=y`) and `FRAMEBUFFER_CONSOLE=y`, so it renders before a DRM driver
  binds. But `CONFIG_DRM_FBDEV_EMULATION` is NOT set while `DRM_I915` and
  `DRM_VIRTIO_GPU` are built in, and a DRM driver that takes over the device
  usually removes the EFI framebuffer. Whether the VT survives that handover
  on real Intel hardware is a RUNTIME question this repository cannot answer
  from a config; it is flagged, not concluded.

## The hardware evidence, from the cx3576 capture of 2026-09-20

The same capture (sha256 `26fc7407...`) answers the kernel half for this board
outright:

    746  Console: switching to colour frame buffer device 240x67
    748  rockchip-drm display-subsystem: [drm] fb0: rockchipdrmfb frame buffer device
    733  rockchip-vop2 ...: Update mode to 1920x1080p60 ... (if:HDMI0)
    883  hid-generic 0003:3346:1009.0001: input,hidraw0: USB HID v1.01
         Keyboard [sipeed NanoKVM] on usb-xhci-hcd.0.auto-1.3/input0

So on that unit the virtual terminal is rendered on an HDMI framebuffer at
1920x1080p60 and a USB HID keyboard is enumerated and bound. The kernel half
of "does Alt+F2 produce anything" is **yes, observed**; whatever remains is
userspace, which is where the question now belongs.

## The feature question this opens

`BOARD_FEATURES` declares `display` on cx3576 and s905x5m and not on the two
UEFI boards, which matches the configs. That is one more instance of the
mapping proposed in
`docs/plan/20260920-0627-kernel-capabilities-beside-each-board.md`: a
`display` capability would be `VT VT_CONSOLE FRAMEBUFFER_CONSOLE FB` plus a
driver that binds, and `INPUT_KEYBOARD` with `USB_HID` for the half that
types. Today nothing checks that a board declaring `display` can render one;
here they both can, so the check would pass -- which is the right time to add
it rather than after it fails.

## Confirmed from the device, 2026-09-20

The user, on the cx3576 with a monitor and the bench keyboard: **Alt+F2 works
and F1 shows the logo**. So the VT login is reached on hardware, and tty1
carries the boot logo with no prompt -- which is what the dropped
`getty.target.wants/getty@tty1.service` predicts and what `autovt@ttyN`
activating on demand through logind provides. The kernel half read out of the
capture and the userspace half read out of the composed root agree with what
the device does.

Note for when the uefi-x64 question is answered under QEMU: a guest takes the
`DRM_VIRTIO_GPU` path, so a pass there answers the virtio half and leaves
`DRM_I915` on real Intel hardware open. A QEMU pass should not be recorded as
an answer for both.
