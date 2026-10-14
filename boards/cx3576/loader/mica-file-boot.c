// SPDX-License-Identifier: GPL-2.0+
/* Fixed signed-FIT policy. Persistent storage contains data, never commands. */
#include <blk.h>
#include <bootm.h>
#include <button.h>
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
#define MICA_FIT_ADDRESS 0x60000000UL
#define MICA_FIT_LIMIT (128 * 1024 * 1024)
static const unsigned long env_blocks[2] = { 32768, 34816 };
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

static int read_environment(struct blk_desc *disk, unsigned char *copies,
			    struct mica_boot_records *records)
{
	int valid[2], slot, i;

	for (i = 0; i < 2; i++) {
		unsigned char *copy = copies + i * MICA_ENV_SIZE;

		valid[i] = blk_dread(disk, env_blocks[i], MICA_ENV_BLOCKS, copy) == MICA_ENV_BLOCKS
			&& valid_environment(copy);
	}
	slot = mica_boot_slot(valid[0], copies[4], valid[1], copies[MICA_ENV_SIZE + 4]);
	if (slot < 0 || decode_environment(copies + slot * MICA_ENV_SIZE, records))
		return -1;
	return slot;
}

static int persist_environment(struct mmc *mmc, unsigned char *copies,
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
	if (blk_dwrite(disk, env_blocks[1 - slot], MICA_ENV_BLOCKS, pending) != MICA_ENV_BLOCKS ||
	    mmc_flush_cache(mmc))
		return -1;
	blkcache_invalidate(disk->uclass_id, disk->devnum);
	if (blk_dread(disk, env_blocks[1 - slot], MICA_ENV_BLOCKS, readback) != MICA_ENV_BLOCKS ||
	    memcmp(readback, pending, MICA_ENV_SIZE))
		return -1;
	return 0;
}

static int valid_layout(struct blk_desc *disk)
{
	struct disk_partition part;
	static const unsigned long starts[] = { 64, 36864, 2134016 };
	static const unsigned long sizes[] = { 36800, 2097152, 524288 };
	static const char * const names[] = { "firmware", "system", "data" };
	unsigned int i;

	if (disk->blksz != 512)
		return -1;
	for (i = 0; i < 3; i++) {
		if (part_get_info(disk, i + 1, &part) || part.start != starts[i] ||
		    strcmp((char *)part.name, names[i]) ||
		    (i == 2 ? part.size < sizes[i] : part.size != sizes[i]))
			return -1;
	}
	return part_get_info(disk, 4, &part) == 0 ? -1 : 0;
}

static void __noreturn recovery(const char *reason)
{
	printf("Mica OS FIT recovery: %s\n", reason);
	/* This constant command exposes the established local reflash transport. */
	run_command("rockusb 0 mmc 0", 0);
	hang();
}

void __noreturn mica_file_boot(void)
{
	struct mica_boot_records records;
	struct mica_boot_record *selected;
	struct udevice *watchdog, *button;
	struct mmc *mmc;
	struct blk_desc *disk;
	unsigned char *copies;
	char filename[96];
	loff_t bytes, loaded;
	int slot, next, ret;

	disable_ctrlc(1);
	/* ENV_IS_NOWHERE prevents persistent commands from entering any init phase. */
	if (env_set("verify", "yes"))
		recovery("verification policy unavailable");
	if (!button_get_by_label("recovery", &button) && button_get_state(button) == BUTTON_ON)
		recovery("local recovery key");
	ret = uclass_get_device(UCLASS_WDT, 0, &watchdog);
	if (ret) {
		printf("Mica OS FIT watchdog probe failed: %d\n", ret);
		recovery("required boot watchdog unavailable");
	}
	ret = wdt_start(watchdog, 120000, 0);
	if (ret) {
		printf("Mica OS FIT watchdog start failed: %d\n", ret);
		recovery("required boot watchdog could not start");
	}
	puts("Mica OS FIT boot watchdog armed\n");
	mmc = find_mmc_device(0);
	if (!mmc || mmc_init(mmc) || IS_SD(mmc) || blk_select_hwpart_devnum(UCLASS_MMC, 0, 0))
		recovery("eMMC user area unavailable");
	disk = mmc_get_blk_desc(mmc);
	if (valid_layout(disk))
		recovery("fresh three-partition layout required");
	copies = memalign(ARCH_DMA_MINALIGN, 2 * MICA_ENV_SIZE);
	if (!copies)
		recovery("environment buffer unavailable");
	memset(copies, 0, 2 * MICA_ENV_SIZE);
	slot = read_environment(disk, copies, &records);
	if (slot < 0)
		recovery("redundant environment invalid");
	next = mica_boot_next(&records);
	if (next < 0)
		recovery("all deployments exhausted");
	selected = &records.entry[next];
	if (selected->tries > 0) {
		selected->tries--;
		if (persist_environment(mmc, copies, slot, &records))
			recovery("attempt persistence failed; candidate not launched");
	}
	memcpy(mica_deployment_id, selected->id, sizeof(mica_deployment_id));
	snprintf(filename, sizeof(filename), "/kernels/%s/boot.itb", selected->kernel);
	printf("Mica OS FIT selected: %s; tries left %d\n", mica_deployment_id, selected->tries);
	if (!fs_set_blk_dev("mmc", "0:2", FS_TYPE_EXT) && !fs_size(filename, &bytes) &&
	    bytes > 0 && bytes <= MICA_FIT_LIMIT &&
	    !fs_set_blk_dev("mmc", "0:2", FS_TYPE_EXT) &&
	    !fs_read(filename, MICA_FIT_ADDRESS, 0, bytes, &loaded) && loaded == bytes &&
	    !fdt_check_header((void *)MICA_FIT_ADDRESS) &&
	    fdt_totalsize((void *)MICA_FIT_ADDRESS) == bytes) {
		wdt_reset(watchdog);
		bootm_boot_start(MICA_FIT_ADDRESS, "ro dm_verity.require_signatures=1 panic=5 rdinit=/init");
	}
	if (selected->tries < 0) {
		selected->tries = 0;
		if (persist_environment(mmc, copies, slot, &records))
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
