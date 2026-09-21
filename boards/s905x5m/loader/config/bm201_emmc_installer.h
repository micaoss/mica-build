/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef __BM201_EMMC_INSTALLER_CONFIG_H
#define __BM201_EMMC_INSTALLER_CONFIG_H

#define BM201_INSTALLER_BLOCK_INTERFACE "mmc"
#define BM201_INSTALLER_SD_DEVICE "0:1"
#define BM201_INSTALLER_REQUEST_FILE "emmc-system-install.request"
#define BM201_INSTALLER_REQUEST_CONTENT "BM201_INSTALL_V2\n"
#define BM201_INSTALLER_IDENTITY_FILE "update.img.sha256"
/* The receipt records which package this eMMC already carries, so the card can
 * stay in the slot. It is a U-Boot environment variable and not a file: the
 * only eMMC FAT this installer could address before it runs is partition 1,
 * which board.env reserves for the Amlogic multi-DTB payload and the MMC
 * calibration scratch, and which Mica OS therefore never writes. See RFCT-940. */
#define BM201_INSTALLER_RECEIPT_ENV "bm201_installed_package"
#define BM201_INSTALLER_SHA256_HEX_BYTES 64
#define BM201_INSTALLER_IDENTITY_BYTES 65
#define BM201_INSTALLER_CONFIG "bm201upd.ini"
#define BM201_INSTALLER_PACKAGE "update.img"
#define BM201_INSTALLER_FAT_MIB 1792
#define BM201_INSTALLER_MAX_PACKAGE_MIB 1536
#define BM201_INSTALLER_MAX_PACKAGE_BYTES \
	(BM201_INSTALLER_MAX_PACKAGE_MIB * 1024ULL * 1024ULL)

#endif
