// SPDX-License-Identifier: GPL-2.0+
/* Fixed signed-FIT policy. Persistent storage contains data, never commands. */
#include <common.h>
#include <cli.h>
#include <amlogic/storage.h>
#include <amlogic/mmc_private.h>
#include <blk.h>
#include <bootm.h>
#include <command.h>
#include <console.h>
#include <dm.h>
#include <env.h>
#include <fs.h>
#include <hang.h>
#include <image.h>
#include <malloc.h>
#include <memalign.h>
#include <mmc.h>
#include <part.h>
#include <wdt.h>
#include <asm/unaligned.h>
#include <u-boot/crc.h>
#include "mica-records.h"

#define MICA_ENV_SIZE 65536
#define MICA_ENV_BLOCKS (MICA_ENV_SIZE / 512)
#define MICA_FIT_ADDRESS 0x28000000UL
#define MICA_FIT_LIMIT (128 * 1024 * 1024)
struct mica_media {
	int device;
	const char *system;
	unsigned long env_blocks[2];
	unsigned long starts[3];
	unsigned long sizes[3];
	const char *uuids[3];
	int vendor_partitions;
};

static const struct mica_media sd_media = {
	.device = 0, .system = "0:2", .env_blocks = { 245760, 253952 },
	.starts = { 64, 262144, 2359296 }, .sizes = { 262080, 2097152, 524288 },
	.uuids = { "5a9055a0-0003-4000-8000-000000000001",
		   "5a9055a0-0003-4000-8000-000000000002",
		   "5a9055a0-0003-4000-8000-000000000003" },
};
static const struct mica_media emmc_media = {
	.device = 1, .system = "1:2", .env_blocks = { 262144, 270336 },
	.starts = { 262144, 278528, 2375680 }, .sizes = { 16384, 2097152, 524288 },
	.uuids = { "5a9055a0-0004-4000-8000-000000000001",
		   "5a9055a0-0004-4000-8000-000000000002",
		   "5a9055a0-0004-4000-8000-000000000003" },
	.vendor_partitions = 1,
};
char mica_deployment_id[65];

static int valid_environment(const unsigned char *bytes)
{
	return get_unaligned_le32(bytes) == crc32(0, bytes + 5, MICA_ENV_SIZE - 5);
}

static int decode_environment(const unsigned char *bytes, struct mica_boot_records *records)
{
	const char *value = mica_env_value(bytes, MICA_ENV_SIZE);

	return value ? mica_boot_parse(value, records) : -1;
}

static int read_environment(struct blk_desc *disk, const struct mica_media *media, unsigned char *copies,
			    struct mica_boot_records *records)
{
	int valid[2], slot, i;

	for (i = 0; i < 2; i++) {
		unsigned char *copy = copies + i * MICA_ENV_SIZE;

		valid[i] = blk_dread(disk, media->env_blocks[i], MICA_ENV_BLOCKS, copy) == MICA_ENV_BLOCKS
			&& valid_environment(copy);
	}
	slot = mica_boot_slot(valid[0], copies[4], valid[1], copies[MICA_ENV_SIZE + 4]);
	if (slot < 0 || decode_environment(copies + slot * MICA_ENV_SIZE, records))
		return -1;
	return slot;
}

static int flush_medium(struct mmc *mmc)
{
	ALLOC_CACHE_ALIGN_BUFFER(u8, ext_csd, MMC_MAX_BLOCK_LEN);

	if (IS_SD(mmc))
		return 0;
	if (mmc_send_ext_csd(mmc, ext_csd))
		return -1;
	return ext_csd[33] & 1 ? mmc_switch(mmc, EXT_CSD_CMD_SET_NORMAL, 32, 1) : 0;
}

static int persist_environment(struct mmc *mmc, const struct mica_media *media, unsigned char *copies,
			       int slot, const struct mica_boot_records *records)
{
	struct blk_desc *disk = mmc_get_blk_desc(mmc);
	unsigned char *pending = copies + (1 - slot) * MICA_ENV_SIZE;
	unsigned char *readback = copies + slot * MICA_ENV_SIZE;
	unsigned char flag = readback[4] + 1;
	char text[MICA_BOOT_VALUE_LIMIT + 1];

	if (mica_boot_render(records, text))
		return -1;
	memset(pending, 0, MICA_ENV_SIZE);
	pending[4] = flag;
	mica_env_store(pending, text);
	put_unaligned_le32(crc32(0, pending + 5, MICA_ENV_SIZE - 5), pending);
	if (blk_dwrite(disk, media->env_blocks[1 - slot], MICA_ENV_BLOCKS, pending) != MICA_ENV_BLOCKS ||
	    flush_medium(mmc))
		return -1;
	blkcache_invalidate(disk->uclass_id, disk->devnum);
	if (blk_dread(disk, media->env_blocks[1 - slot], MICA_ENV_BLOCKS, readback) != MICA_ENV_BLOCKS ||
	    memcmp(readback, pending, MICA_ENV_SIZE))
		return -1;
	return 0;
}

/* 1: supported Mica image; 0: unrelated card; -1: damaged Mica or I/O. */
static int valid_layout(struct blk_desc *disk, const struct mica_media *media)
{
	struct disk_partition part;
	ALLOC_CACHE_ALIGN_BUFFER(unsigned char, header, 1024);
	static const char * const names[] = { "firmware", "system", "data" };
	static const unsigned long vendor_starts[] = { 8192, 73728, 221184 };
	static const unsigned long vendor_sizes[] = { 24576, 131072, 32768 };
	static const char * const vendor_names[] = { "bootloader_a", "reserved", "env" };
	static const char * const vendor_uuids[] = {
		"708161c1-0000-4000-8000-000000000011",
		"708161c1-0000-4000-8000-000000000014",
		"708161c1-0000-4000-8000-000000000015",
	};
	unsigned int i, j;
	int recognized = 0, named = 0, valid = 1, any = 0;
	static const unsigned char sd_disk_guid[] = {
		0xa0, 0x55, 0x90, 0x5a, 0x03, 0x00, 0x00, 0x40,
		0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	};

	static const unsigned char emmc_disk_guid[] = {
		0xa0, 0x55, 0x90, 0x5a, 0x04, 0x00, 0x00, 0x40,
		0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	};

	if (disk->blksz != 512 || blk_dread(disk, 0, 2, header) != 2)
		return -1;
	if (media == &emmc_media && (memcmp(header + 512, "EFI PART", 8) ||
	    memcmp(header + 512 + 56, emmc_disk_guid, sizeof(emmc_disk_guid))))
		return -1;
	if (media == &sd_media && !memcmp(header + 512, "EFI PART", 8) &&
	    !memcmp(header + 512 + 56, sd_disk_guid, sizeof(sd_disk_guid)))
		recognized = 1;
	for (i = 0; i < 3; i++) {
		if (part_get_info(disk, i + 1, &part)) {
			valid = 0;
			continue;
		}
		any = 1;
		for (j = 0; j < 3; j++) {
			if (!strcasecmp(part.uuid, media->uuids[j]))
				recognized = 1;
			if (j < 2 && !strcmp((char *)part.name, names[j]))
				named |= 1 << j;
		}
		if (part.start != media->starts[i] || strcmp((char *)part.name, names[i]) ||
		    strcasecmp(part.uuid, media->uuids[i]) ||
		    (i == 2 ? part.size < media->sizes[i] : part.size != media->sizes[i]))
			valid = 0;
	}
	/* A shifted or partly missing Mica GPT must not turn SD into eMMC fallback. */
	if (media == &sd_media) {
		for (i = 4; i <= 16; i++) {
			if (part_get_info(disk, i, &part))
				continue;
			for (j = 0; j < 3; j++) {
				if (!strcasecmp(part.uuid, sd_media.uuids[j]) ||
				    !strcasecmp(part.uuid, emmc_media.uuids[j]))
					recognized = 1;
				if (j < 2 && !strcmp((char *)part.name, names[j]))
					named |= 1 << j;
			}
		}
	}
	if (!any && (disk->part_type == PART_TYPE_EFI ||
	    !memcmp(header + 512, "EFI PART", 8) || header[450] == 0xee))
		return -1;
	if (!recognized && !named)
		return 0;
	if (!valid || disk->part_type != PART_TYPE_EFI)
		return -1;
	if (media->vendor_partitions) {
		for (i = 0; i < 3; i++) {
			if (part_get_info(disk, i + 4, &part) || part.start != vendor_starts[i] ||
			    part.size != vendor_sizes[i] || strcmp((char *)part.name, vendor_names[i]) ||
			    strcasecmp(part.uuid, vendor_uuids[i]))
				return -1;
		}
		return part_get_info(disk, 7, &part) == 0 ? -1 : 1;
	}
	return part_get_info(disk, 4, &part) == 0 ? -1 : 1;
}

/* Select SD first; only an unrelated SD card permits eMMC fallback. */
static int select_medium(struct mmc **selected, const struct mica_media **profile)
{
	struct mmc *mmc = find_mmc_device(0);
	struct blk_desc *disk;
	int result;

	if (mmc && mmc_getcd(mmc) != 0) {
		if (mmc_init(mmc) || !IS_SD(mmc) || blk_select_hwpart_devnum(UCLASS_MMC, 0, 0))
			return -1;
		disk = mmc_get_blk_desc(mmc);
		part_init(disk);
		result = valid_layout(disk, &sd_media);
		if (result > 0) {
			*selected = mmc;
			*profile = &sd_media;
			return 1;
		}
		if (result < 0)
			return -1;
	}
	mmc = find_mmc_device(1);
	if (!mmc || mmc_init(mmc) || IS_SD(mmc) || blk_select_hwpart_devnum(UCLASS_MMC, 1, 0))
		return -1;
	disk = mmc_get_blk_desc(mmc);
	part_init(disk);
	if (valid_layout(disk, &emmc_media) != 1)
		return -1;
	*selected = mmc;
	*profile = &emmc_media;
	return 1;
}

static void __noreturn recovery(const char *reason)
{
	printf("Mica OS FIT recovery: %s\n", reason);
	/* No candidate is launched; local recovery commands remain available. */
	disable_ctrlc(0);
	cli_loop();
	hang();
}

void __noreturn mica_file_boot(void)
{
	struct mica_boot_records records;
	struct mica_boot_record *selected;
	struct udevice *watchdog;
	struct mmc *mmc;
	struct blk_desc *disk;
	const struct mica_media *media;
	unsigned char *copies;
	char filename[96];
	loff_t bytes, loaded;
	int slot, next, ret;

	disable_ctrlc(1);
	/* ENV_IS_NOWHERE prevents persistent commands from entering any init phase. */
	if (env_set("verify", "yes"))
		recovery("verification policy unavailable");
	if (store_get_type() != BOOT_EMMC || store_bootup_bootidx("bootloader") != 1)
		recovery("Mica OS firmware must execute from eMMC boot0");
	ret = uclass_get_device(UCLASS_WDT, 0, &watchdog);
	if (ret) {
		printf("Mica OS FIT watchdog probe failed: %d\n", ret);
		recovery("required boot watchdog unavailable");
	}
	ret = wdt_start(watchdog, 60000, 0);
	if (ret) {
		printf("Mica OS FIT watchdog start failed: %d\n", ret);
		recovery("required boot watchdog could not start");
	}
	puts("Mica OS FIT boot watchdog armed\n");
	if (select_medium(&mmc, &media) != 1)
		recovery("no valid system medium");
	disk = mmc_get_blk_desc(mmc);
	printf("Mica OS FIT system medium: %s\n", media->device == 0 ? "SD" : "eMMC");
	copies = memalign(ARCH_DMA_MINALIGN, 2 * MICA_ENV_SIZE);
	if (!copies)
		recovery("environment buffer unavailable");
	memset(copies, 0, 2 * MICA_ENV_SIZE);
	slot = read_environment(disk, media, copies, &records);
	if (slot < 0)
		recovery("redundant environment invalid");
	next = mica_boot_next(&records);
	if (next < 0)
		recovery("all deployments exhausted");
	selected = &records.entry[next];
	if (selected->tries > 0) {
		selected->tries--;
		if (persist_environment(mmc, media, copies, slot, &records))
			recovery("attempt persistence failed; candidate not launched");
	}
	memcpy(mica_deployment_id, selected->id, sizeof(mica_deployment_id));
	snprintf(filename, sizeof(filename), "/kernels/%s/boot.itb", selected->kernel);
	printf("Mica OS FIT selected: %s; tries left %d\n", mica_deployment_id, selected->tries);
	if (!fs_set_blk_dev("mmc", media->system, FS_TYPE_EXT) && !fs_size(filename, &bytes) &&
	    bytes > 0 && bytes <= MICA_FIT_LIMIT &&
	    !fs_set_blk_dev("mmc", media->system, FS_TYPE_EXT) &&
	    !fs_read(filename, MICA_FIT_ADDRESS, 0, bytes, &loaded) && loaded == bytes &&
	    !fdt_check_header((void *)MICA_FIT_ADDRESS) &&
	    fdt_totalsize((void *)MICA_FIT_ADDRESS) == bytes) {
		wdt_reset(watchdog);
		env_set("bootargs", "ro dm_verity.require_signatures=1 panic=5 rdinit=/init");
		run_command("bootm 0x28000000", 0);
	}
	if (selected->tries < 0) {
		selected->tries = 0;
		if (persist_environment(mmc, media, copies, slot, &records))
			recovery("failed confirmed image cannot be retired");
	}
	free(copies);
	puts("Mica OS FIT selected image failed; restarting with persisted attempts\n");
	do_reset(NULL, 0, 0, NULL);
	hang();
}

static int do_micaboot(struct cmd_tbl *cmdtp, int flag, int argc, char *const argv[])
{
	(void)cmdtp;
	(void)flag;
	(void)argc;
	(void)argv;
	mica_file_boot();
}

U_BOOT_CMD(micaboot, 1, 0, do_micaboot,
	   "boot the selected signed Mica OS deployment", "");
