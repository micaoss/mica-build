// SPDX-License-Identifier: GPL-2.0+
/*
 * Mica OS FIT boot over UBI. The deployment records are LEB 0 of the dynamic volumes records-a and
 * records-b, the kernel the static volume k-<kernelId>. Persistent storage contains data, never commands.
 */
#include <bootm.h>
#include <command.h>
#include <console.h>
#include <env.h>
#include <hang.h>
#include <image.h>
#include <malloc.h>
#include <memalign.h>
#include <u-boot/crc.h>
#include <ubi_uboot.h>
#include <asm/unaligned.h>
#include <linux/err.h>
#include <linux/mtd/ubi.h>
/* UBI's headers name Linux's crc32_le crc32; the environment's CRC is U-Boot's own (u-boot/crc.h). */
#undef crc32
#include "mica-records.h"

#define MICA_ENV_SIZE 65536
char mica_deployment_id[65];

static int valid_environment(const unsigned char *bytes)
{
	return get_unaligned_le32(bytes) == crc32(0, bytes + 5, MICA_ENV_SIZE - 5);
}

/* LEB 0 of a record volume, whole; a volume that cannot be read so is an invalid copy. */
static int read_copy(const char *volume, unsigned char *copy)
{
	struct ubi_volume_desc *desc = ubi_open_volume_nm(0, volume, UBI_READONLY);
	int ret;

	if (IS_ERR(desc))
		return -1;
	ret = ubi_leb_read(desc, 0, (char *)copy, 0, MICA_ENV_SIZE, 1);
	ubi_close_volume(desc);
	return ret ? -1 : 0;
}

static int read_environment(unsigned char *copies, struct mica_boot_records *records)
{
	static const char * const volumes[2] = { "records-a", "records-b" };
	const char *value;
	int valid[2], slot, i;

	for (i = 0; i < 2; i++) {
		unsigned char *copy = copies + i * MICA_ENV_SIZE;

		valid[i] = !read_copy(volumes[i], copy) && valid_environment(copy);
	}
	slot = mica_boot_slot(valid[0], copies[4], valid[1], copies[MICA_ENV_SIZE + 4]);
	if (slot < 0)
		return -1;
	value = mica_env_value(copies + slot * MICA_ENV_SIZE, MICA_ENV_SIZE);
	return value && !mica_boot_parse(value, records) ? slot : -1;
}

/* The inactive copy, by the atomic LEB change: an interrupted write leaves the old copy or the new one. */
static int persist_environment(unsigned char *copies, int slot, const struct mica_boot_records *records)
{
	static const char * const volumes[2] = { "records-a", "records-b" };
	unsigned char *pending = copies + (1 - slot) * MICA_ENV_SIZE;
	unsigned char *readback = copies + slot * MICA_ENV_SIZE;
	unsigned char flag = readback[4] + 1;
	char text[MICA_BOOT_VALUE_LIMIT + 1];
	struct ubi_volume_desc *desc;
	int ret;

	if (mica_boot_render(records, text))
		return -1;
	memset(pending, 0, MICA_ENV_SIZE);
	pending[4] = flag;
	mica_env_store(pending, text);
	put_unaligned_le32(crc32(0, pending + 5, MICA_ENV_SIZE - 5), pending);
	desc = ubi_open_volume_nm(0, volumes[1 - slot], UBI_READWRITE);
	if (IS_ERR(desc))
		return -1;
	ret = ubi_leb_change(desc, 0, pending, MICA_ENV_SIZE);
	ubi_close_volume(desc);
	if (ret || read_copy(volumes[1 - slot], readback) || memcmp(readback, pending, MICA_ENV_SIZE))
		return -1;
	return 0;
}

/* k-<kernelId>: static, sound, at most the FIT limit, read whole with every LEB's data CRC checked. */
static long read_kernel(const char *volume)
{
	struct ubi_volume_desc *desc = ubi_open_volume_nm(0, volume, UBI_READONLY);
	struct ubi_volume_info info;
	char *at = (char *)CONFIG_MICA_UBI_FIT_ADDRESS;
	long long left;
	int lnum, len;

	if (IS_ERR(desc))
		return -1;
	ubi_get_volume_info(desc, &info);
	if (info.vol_type != UBI_STATIC_VOLUME || info.corrupted || info.used_bytes <= 0 ||
	    info.used_bytes > CONFIG_MICA_UBI_FIT_LIMIT) {
		ubi_close_volume(desc);
		return -1;
	}
	for (lnum = 0, left = info.used_bytes; left > 0; lnum++, left -= len, at += len) {
		len = left > info.usable_leb_size ? info.usable_leb_size : (int)left;
		if (ubi_leb_read(desc, lnum, at, 0, len, 1)) {
			ubi_close_volume(desc);
			return -1;
		}
	}
	ubi_close_volume(desc);
	return (long)info.used_bytes;
}

static void __noreturn recovery(const char *reason)
{
	printf("Mica OS FIT recovery: %s\n", reason);
	hang();
}

void __noreturn mica_ubi_boot(void)
{
	static char mtd[] = CONFIG_MICA_UBI_MTD;
	struct mica_boot_records records;
	struct mica_boot_record *selected;
	unsigned char *copies;
	char volume[80];
	long bytes;
	int slot, next;

	disable_ctrlc(1);
	/* ENV_IS_NOWHERE prevents persistent commands from entering any init phase. */
	if (env_set("verify", "yes"))
		recovery("verification policy unavailable");
	/* The loader arms no watchdog: the board has none U-Boot drives, and its kernel arms its own. */
	if (ubi_part(mtd, NULL))
		recovery("UBI partition " CONFIG_MICA_UBI_MTD " unavailable");
	copies = memalign(ARCH_DMA_MINALIGN, 2 * MICA_ENV_SIZE);
	if (!copies)
		recovery("environment buffer unavailable");
	memset(copies, 0, 2 * MICA_ENV_SIZE);
	slot = read_environment(copies, &records);
	if (slot < 0)
		recovery("redundant environment invalid");
	next = mica_boot_next(&records);
	if (next < 0)
		recovery("all deployments exhausted");
	selected = &records.entry[next];
	if (selected->tries > 0) {
		selected->tries--;
		if (persist_environment(copies, slot, &records))
			recovery("attempt persistence failed; candidate not launched");
	}
	memcpy(mica_deployment_id, selected->id, sizeof(mica_deployment_id));
	snprintf(volume, sizeof(volume), "k-%s", selected->kernel);
	printf("Mica OS FIT selected: %s; tries left %d\n", mica_deployment_id, selected->tries);
	bytes = read_kernel(volume);
	if (bytes > 0 && !fdt_check_header((void *)CONFIG_MICA_UBI_FIT_ADDRESS) &&
	    fdt_totalsize((void *)CONFIG_MICA_UBI_FIT_ADDRESS) == bytes) {
		/*
		 * The kernel forces its built-in command line, which names the UBI partition (ubi.mtd=). This U-Boot
		 * (2022.07) has no bootm_boot_start(), so bootm is called with the FIT's address as its one argument.
		 */
		char address[19];
		char *argv[] = { "bootm", address, NULL };

		snprintf(address, sizeof(address), "0x%lx", (unsigned long)CONFIG_MICA_UBI_FIT_ADDRESS);
		do_bootm(find_cmd("bootm"), 0, 2, argv);
	}
	if (selected->tries < 0) {
		selected->tries = 0;
		if (persist_environment(copies, slot, &records))
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
	mica_ubi_boot();
}

U_BOOT_CMD(micaboot, 1, 0, do_micaboot,
	   "boot the selected Mica OS deployment from UBI", "");
