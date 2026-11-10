#!/bin/bash
# The refusal half of the upload case (phase 07c), inside the guest as root (mica-api-upload-negative.service,
# seeded on DATA by run.sh for its `upload` boots). The first boot only arms it: 07b's upload needs the directory.
# On the second boot it removes /mica/updates/uploads and restarts apid, which then starts without the directory
# (ReadWritePaths= names it with `-`), and says so on the console for 07c to wait on.
set -u
armed=/mnt/data/state/upload-negative.armed
if [ ! -e "$armed" ]; then
    : >"$armed"
    echo "UPLOAD_NEGATIVE armed for the next boot"
    exit 0
fi
rm -rf /mica/updates/uploads
systemctl restart apid.service
if [ -e /mica/updates/uploads ]; then
    echo "UPLOAD_NEGATIVE FAILED: /mica/updates/uploads came back"
    exit 1
fi
echo "UPLOAD_NEGATIVE READY: /mica/updates/uploads removed, apid $(systemctl is-active apid.service)"
