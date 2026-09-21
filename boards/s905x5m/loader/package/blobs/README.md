# Amlogic package blobs

These board-specific, static assets drive the S7D Amlogic burning flow. They
were extracted from the BM201 Android recovery package at the committed
`s905x5m-alpine` baseline `49618bed07508b77bb8e8e640e0faafc5c95ea9a`.

| File | Bytes | SHA-256 | Purpose |
|---|---:|---|---|
| `usb_flow.aml` | 212,240 | `97c5b289db21c087540f74c9661e6d300f3d582f2e1204e31a7dbfdf30c0bef6` | USB burning sequence |
| `_aml_dtb.PARTITION` | 82,066 | `2513dbdf9c0d9e1ccc0da52ced73ee5a85e0c9c2495f487f712f900abff6a9fa` | Amlogic multi-DTB payload for the reserved DTB area |

`SHA256SUMS` is checked by both the focused manifest test and the package
build. These are not Linux board DTBs and are not generic Amlogic assets.
