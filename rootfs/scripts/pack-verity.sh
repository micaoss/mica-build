#!/bin/sh
# Append the exact dm-verity hash tree and write build parameters.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.
# Build arguments read from the environment: VERITY_SALT, VERITY_HASH_ALGO, VERITY_DATA_BLOCK_SIZE,
#   VERITY_HASH_BLOCK_SIZE.
#
# mica-build-side: container -- run by 90-pack.Dockerfile's pack stage, never on a host.

set -eu
    test -n "${VERITY_SALT}"
    sq_bytes="$(stat -c %s /out/rootfs.squashfs)"
    if [ $((sq_bytes % VERITY_DATA_BLOCK_SIZE)) -ne 0 ]; then
        echo "error: squashfs size ${sq_bytes} is not a multiple of ${VERITY_DATA_BLOCK_SIZE}" >&2; exit 1
    fi
    data_blocks=$((sq_bytes / VERITY_DATA_BLOCK_SIZE))
    hash_start_block=$((sq_bytes / VERITY_HASH_BLOCK_SIZE))
    cp /out/rootfs.squashfs /out/rootfs-verity.img
    # --no-superblock: the device is assembled by dm-init from the kernel command
    # line, and a verity v1 table has no superblock concept -- its hash_start_block
    # is read as the tree's top level. With a superblock the tree begins one hash
    # block LATER than hash_start_block names, so every boot dies on
    # "device-mapper: verity: metadata block <n> is corrupted". Without it the tree
    # begins exactly at --hash-offset, which is what VERITY_HASH_START_BLOCK below
    # computes. No --uuid either: the UUID lived IN the superblock, and veritysetup
    # accepts the option here while discarding the value.
    root_hash="$(veritysetup format /out/rootfs-verity.img /out/rootfs-verity.img \
        --no-superblock \
        --hash="${VERITY_HASH_ALGO}" \
        --data-block-size="${VERITY_DATA_BLOCK_SIZE}" \
        --hash-block-size="${VERITY_HASH_BLOCK_SIZE}" \
        --data-blocks="${data_blocks}" \
        --hash-offset="${sq_bytes}" \
        --salt="${VERITY_SALT}" \
        | awk '/^Root hash:/ { print $NF }')"
    test -n "${root_hash}"
    raw_bytes="$(stat -c %s /out/rootfs-verity.img)"
    image_bytes=${raw_bytes}
    rm -f /out/rootfs.squashfs
    { echo "VERITY_ROOT_HASH=${root_hash}"
      echo "VERITY_SALT=${VERITY_SALT}"
      echo "VERITY_HASH_ALGO=${VERITY_HASH_ALGO}"
      echo "VERITY_DATA_BLOCK_SIZE=${VERITY_DATA_BLOCK_SIZE}"
      echo "VERITY_HASH_BLOCK_SIZE=${VERITY_HASH_BLOCK_SIZE}"
      echo "VERITY_DATA_BLOCKS=${data_blocks}"
      echo "VERITY_HASH_START_BLOCK=${hash_start_block}"
      echo "VERITY_DATA_SECTORS=$((sq_bytes / 512))"
      echo "SQUASHFS_BYTES=${sq_bytes}"
      echo "IMAGE_BYTES=${image_bytes}"
    } > /out/rootfs-verity.env
    echo "pack: squashfs ${sq_bytes} B + verity -> ${raw_bytes} B"
    echo "pack: root hash ${root_hash}"
