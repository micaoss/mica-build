# uefi-x64

The uefi-x64 board (UEFI, systemd-boot, QEMU and generic PCs) of Mica OS: the board definition
(`board.env`), the kernel build (`kernel/`), the board package (`package/`) and the
board evidence (`evidence.json`). `make uefi-x64-kernel` and
`make board-pool` build its kernel and its package; a release of one of its products publishes them.

The kernel embeds the dm-verity trust certificate of the deployment it will
boot: `VERITY_TRUST_CERT` (default `meta/verity/signer.cert.pem`, the
public certificate the assembly supplies). The board's board component ships
that certificate, and the assembly refuses a kernel built against another one.

## Compute Engine (uefi-x64.gcp)

uefi-x64.gcp is this board's Google Compute Engine image: the shared kernel (gVNIC, virtio-rng, the vTPM and
PCIe/ACPI hotplug built in, and softdog, which its boot policy arms), Docker as its container engine and no
MQTT, OpenSSH on with keys only, and its `gce`
image kind (`packer/gce`): `disk.raw`, the disk image grown to a whole GiB with the backup GPT at the new end,
in an oldgnu tar that the release gzips to `mica-uefi-x64.gcp-<release>.gce.tar.gz`. Beside it the release
publishes `mica-uefi-x64.gcp-<release>.db.der`, the DER of the boot certificate systemd-boot and the UKI are
signed with. `gce/gce-import.sh` uploads the archive and creates the image with that certificate as PK, KEK
and db and the guest OS features `UEFI_COMPATIBLE,GVNIC,VIRTIO_SCSI_MULTIQUEUE` (storage location
`europe-west4` unless `GCE_LOCATION` says otherwise); its comment shows the Shielded VM instance it is meant for.
DATA grows to the persistent disk at every boot (systemd-repart and systemd-growfs), so a disk enlarged later
grows at the next boot. Logins are the users of the instance's `ssh-keys` metadata; the console is reached
through `gcloud compute ssh <vm> -- -L 8080:localhost:8080`, and claiming asks for the device code, which the
owner reads after logging in. `tests/suites/lifecycle-uefi/gce.sh` boots the artefact on a Compute Engine-like
QEMU machine.
