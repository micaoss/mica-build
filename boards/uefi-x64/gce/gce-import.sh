#!/usr/bin/env bash
# Import a uefi-x64.gcp release into Compute Engine as an image, with Secure Boot keyed to Mica's boot certificate.
#
#   gce-import.sh [--labels K=V,...] [--family F] <mica-uefi-x64.gcp-<version>.gce.tar.gz> <mica-db.der> <bucket>[/<prefix>] [<image name>]
#
# Uploads the tar.gz to gs://<bucket>/[<prefix>/] and creates the image from it. mica-db.der (the DER of the certificate
# Mica's systemd-boot and UKI are signed with) is the platform key, the key exchange key and the signature
# database: no Microsoft keys, so the firmware boots Mica's signed binaries and nothing else. The image name
# defaults to the tar.gz's, lowercased, dots and plus signs as dashes. GCE_LOCATION (default europe-west4) is
# the image's storage location; gcloud's configured project is used.
# --labels adds labels beside mica-product=uefi-x64-gcp, --family puts the image in an image family (the
# publish workflow, boards/uefi-x64/gce/publish.sh).
#
# Then an instance, for example:
#   gcloud compute instances create mica-1 --zone europe-west4-a --machine-type e2-small --image <image name> \
#       --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring
#   gcloud compute ssh mica-1 --zone europe-west4-a                       # as your own user, from ssh-keys metadata
#   gcloud compute ssh mica-1 --zone europe-west4-a -- -L 8080:localhost:8080   # the console, to claim the device
set -euo pipefail
labels=mica-product=uefi-x64-gcp family=()
while [ $# -gt 0 ]; do
    case $1 in
        --labels) labels="$labels,$2"; shift 2 ;;
        --family) family=(--family="$2"); shift 2 ;;
        *) break ;;
    esac
done
[ $# -ge 3 ] && [ $# -le 4 ] || { sed -n '4p' "$0" | sed 's/^# *//' >&2; exit 2; }
archive=$1 db=$2 bucket=$3
[ -f "$archive" ] || { echo "error: $archive does not exist" >&2; exit 1; }
[ -f "$db" ] || { echo "error: $db does not exist" >&2; exit 1; }
case "$archive" in *.gce.tar.gz) ;; *) echo "error: $archive is not a gce image kind (*.gce.tar.gz)" >&2; exit 1 ;; esac
command -v gcloud >/dev/null || { echo "error: gcloud is not installed" >&2; exit 1; }
name=${4:-$(basename "$archive" .gce.tar.gz | tr 'A-Z.+_' 'a-z---')}
location=${GCE_LOCATION:-europe-west4}
uri="gs://$bucket/$(basename "$archive")"

gcloud storage cp "$archive" "$uri"
gcloud compute images create "$name" \
    --source-uri="$uri" \
    --storage-location="$location" \
    --guest-os-features=UEFI_COMPATIBLE,GVNIC,VIRTIO_SCSI_MULTIQUEUE \
    --platform-key-file="$db" \
    --key-exchange-key-file="$db" \
    --signature-database-file="$db" \
    --labels="$labels" "${family[@]}"
echo "image $name created from $uri"
