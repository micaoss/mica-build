// SPDX-License-Identifier: GPL-2.0+

#if defined(BM201_INSTALLER_PRODUCTION_FAT_SEAM)

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef long long loff_t;

#define CMD_RET_SUCCESS 0
#define CMD_RET_FAILURE 1
#define FS_TYPE_FAT 1
#define U_BOOT_CMD(...)
#define ANSI_CURSOR_SHOW "\033[?25h"

struct cmd_tbl {
	int unused;
};

enum production_medium {
	PRODUCTION_MEDIUM_NONE,
	PRODUCTION_MEDIUM_SD,
	PRODUCTION_MEDIUM_EMMC,
};

struct production_fat_fixture {
	enum production_medium medium;
	unsigned int detect_count;
	unsigned int select_count;
	unsigned int close_count;
	unsigned int context_loss_count;
	unsigned int exists_count;
	unsigned int size_count;
	unsigned int read_count;
	unsigned int write_count;
	unsigned int burn_count;
	unsigned int reset_count;
	unsigned int video_lookup_count;
	unsigned int output_route_count;
	unsigned int clear_count;
	int sd_present;
	int console_video_requested;
	int video_available;
	int progress_routed;
	int receipt_exists;
	int receipt_saved;
	char receipt[65];
};

static struct production_fat_fixture production;
static const char production_request[] = "BM201_INSTALL_V2\n";
static const char production_identity[] =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n";
static const char production_config[] = "[burn_ex]\n";
static const char production_package[] = "package";

struct mmc {
	int unused;
};

static struct mmc production_sd;

struct stdio_dev {
	int unused;
};

static struct stdio_dev production_video;

static struct mmc *find_mmc_device(int dev_num)
{
	assert(dev_num == 0);
	production.detect_count++;
	return &production_sd;
}

static int mmc_getcd(struct mmc *mmc)
{
	assert(mmc == &production_sd);
	return production.sd_present;
}

static struct stdio_dev *stdio_get_by_name(const char *name)
{
	assert(!strcmp(name, "vidconsole"));
	production.video_lookup_count++;
	return production.video_available ? &production_video : NULL;
}

static void fs_close(void)
{
	production.close_count++;
	production.medium = PRODUCTION_MEDIUM_NONE;
}

static int production_context_ready(void)
{
	if (production.medium != PRODUCTION_MEDIUM_NONE)
		return 1;
	production.context_loss_count++;
	return 0;
}

static int fs_set_blk_dev(const char *interface, const char *device,
			  int fs_type)
{
	assert(!strcmp(interface, "mmc"));
	assert(fs_type == FS_TYPE_FAT);
	production.select_count++;
	if (!strcmp(device, "0:1"))
		production.medium = PRODUCTION_MEDIUM_SD;
	else if (!strcmp(device, "1:1"))
		production.medium = PRODUCTION_MEDIUM_EMMC;
	else
		assert(!"unexpected installer device");
	return 0;
}

static const char *production_file(const char *path, unsigned long *size,
				   int *exists)
{
	if (production.medium == PRODUCTION_MEDIUM_SD) {
		if (!strcmp(path, "emmc-system-install.request")) {
			*size = sizeof(production_request) - 1;
			*exists = 1;
			return production_request;
		}
		if (!strcmp(path, "update.img.sha256")) {
			*size = sizeof(production_identity) - 1;
			*exists = 1;
			return production_identity;
		}
		if (!strcmp(path, "bm201upd.ini")) {
			*size = sizeof(production_config) - 1;
			*exists = 1;
			return production_config;
		}
		if (!strcmp(path, "update.img")) {
			*size = sizeof(production_package) - 1;
			*exists = 1;
			return production_package;
		}
	}
	assert(!"unexpected installer path or medium");
	return NULL;
}

static int fs_exists(const char *path)
{
	unsigned long size = 0;
	int exists = 0;

	production.exists_count++;
	if (!production_context_ready())
		return -1;
	production_file(path, &size, &exists);
	fs_close();
	return exists;
}

static int fs_size(const char *path, loff_t *size)
{
	unsigned long file_size = 0;
	int exists = 0;

	production.size_count++;
	if (!production_context_ready())
		return -1;
	production_file(path, &file_size, &exists);
	assert(exists);
	*size = (loff_t)file_size;
	fs_close();
	return 0;
}

static unsigned long map_to_sysmem(const void *buffer)
{
	return (unsigned long)(uintptr_t)buffer;
}

static int fs_read(const char *path, unsigned long address, loff_t offset,
		   loff_t length, loff_t *actual)
{
	unsigned long file_size = 0;
	int exists = 0;
	const char *data;

	production.read_count++;
	if (!production_context_ready())
		return -1;
	data = production_file(path, &file_size, &exists);
	assert(exists);
	assert(offset == 0);
	assert(length == (loff_t)file_size);
	memcpy((void *)(uintptr_t)address, data, file_size);
	*actual = (loff_t)file_size;
	fs_close();
	return 0;
}

static int fs_write(const char *path, unsigned long address, loff_t offset,
		    loff_t length, loff_t *actual)
{
	(void)path;
	(void)address;
	(void)offset;
	(void)length;
	(void)actual;
	production.write_count++;
	/* The receipt moved to the environment, so the installer writes no
	 * file at all. Reaching this is the regression. */
	assert(!"installer wrote a file; the receipt is an environment variable");
	return -1;
}

static const char *env_get(const char *name)
{
	if (!strcmp(name, "bm201_installed_package"))
		return production.receipt_exists ? production.receipt : NULL;
	assert(!strcmp(name, "bm201_console_out"));
	return production.console_video_requested ?
		"serial,vidconsole" : "serial";
}

static int env_set(const char *name, const char *value)
{
	if (!strcmp(name, "bm201_installed_package")) {
		assert(strlen(value) == 64);
		memcpy(production.receipt, value, 64);
		production.receipt[64] = '\0';
		production.receipt_exists = 1;
		return 0;
	}
	if (!strcmp(name, "sdcburncfg")) {
		assert(!strcmp(value, "bm201upd.ini"));
		return 0;
	}
	assert(!strcmp(name, "stdout") || !strcmp(name, "stderr"));
	assert(!strcmp(value, "serial,vidconsole") || !strcmp(value, "serial"));
	production.output_route_count++;
	if (!strcmp(value, "serial,vidconsole"))
		production.progress_routed = 1;
	return 0;
}

static int env_save(void)
{
	assert(production.receipt_exists);
	production.receipt_saved = 1;
	return 0;
}

static int run_command(const char *command, int flag)
{
	(void)flag;
	if (!strcmp(command, "cls")) {
		assert(production.progress_routed);
		production.clear_count++;
		return 0;
	}
	if (!strcmp(command, "sdc_burn bm201upd.ini")) {
		assert(production.progress_routed ==
		       (production.console_video_requested &&
			production.video_available));
		production.burn_count++;
		return 0;
	}
	assert(!strcmp(command, "reset"));
	production.reset_count++;
	return 0;
}

#include "emmc_installer.c"

int main(void)
{
	char *argv[] = { "bm201_emmc_update", NULL };

	assert(do_bm201_emmc_update(NULL, 0, 1, argv) == CMD_RET_SUCCESS);
	assert(production.detect_count == 1);
	assert(production.select_count == 0);
	assert(production.exists_count == 0);
	assert(production.burn_count == 0);
	assert(production.reset_count == 0);
	assert(production.video_lookup_count == 0);
	assert(production.output_route_count == 0);
	assert(production.clear_count == 0);

	memset(&production, 0, sizeof(production));
	production.sd_present = 1;
	production.console_video_requested = 1;
	production.video_available = 1;
	production.receipt_exists = 1;
	memcpy(production.receipt, production_identity, 64);
	production.receipt[64] = '\0';
	assert(do_bm201_emmc_update(NULL, 0, 1, argv) == CMD_RET_SUCCESS);
	assert(production.burn_count == 0);
	assert(production.reset_count == 0);
	assert(production.video_lookup_count == 0);
	assert(production.output_route_count == 0);
	assert(production.clear_count == 0);

	memset(&production, 0, sizeof(production));
	production.sd_present = 1;
	production.console_video_requested = 1;
	assert(do_bm201_emmc_update(NULL, 0, 1, argv) == CMD_RET_FAILURE);
	assert(production.burn_count == 1);
	assert(production.reset_count == 1);
	assert(production.video_lookup_count == 1);
	assert(production.output_route_count == 0);
	assert(production.clear_count == 0);
	assert(production.progress_routed == 0);

	memset(&production, 0, sizeof(production));
	production.sd_present = 1;
	production.console_video_requested = 1;
	production.video_available = 1;
	assert(do_bm201_emmc_update(NULL, 0, 1, argv) == CMD_RET_FAILURE);
	assert(production.context_loss_count == 0);
	assert(production.detect_count == 2);
	assert(production.select_count == 12);
	assert(production.close_count == 10);
	assert(production.exists_count == 4);
	assert(production.size_count == 4);
	assert(production.read_count == 2);
	/* Zero, and it has to stay zero: the receipt is an environment
	 * variable, so a complete install writes no file to any FAT. */
	assert(production.write_count == 0);
	assert(production.burn_count == 1);
	assert(production.reset_count == 1);
	assert(production.video_lookup_count == 1);
	assert(production.output_route_count == 2);
	assert(production.clear_count == 1);
	assert(production.progress_routed == 1);
	assert(production.receipt_exists);
	assert(production.receipt_saved);
	assert(!memcmp(production.receipt, production_identity, 64));
	assert(production.receipt[64] == '\0');
	puts("BM201 production installer FAT context test passed");
	return 0;
}

#else

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "emmc_installer_logic.h"

#define ARRAY_SIZE(array) (sizeof(array) / sizeof((array)[0]))
#define TEST_IDENTITY \
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n"
#define TEST_OTHER_IDENTITY \
	"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\n"
#define TEST_INVALID_REQUEST "BM201_INSTALL_V1\n"

enum operation {
	OP_SELECT_SD_REQUEST,
	OP_REQUEST_SIZE,
	OP_REQUEST_READ,
	OP_IDENTITY_SIZE,
	OP_IDENTITY_READ,
	OP_RECEIPT_READ,
	OP_SELECT_SD_PAYLOAD,
	OP_CONFIG_SIZE,
	OP_PACKAGE_SIZE,
	OP_BURN,
	OP_WRITE_RECEIPT,
	OP_VERIFY_RECEIPT,
	OP_RESET,
};

enum selected_medium {
	MEDIUM_NONE,
	MEDIUM_SD,
	MEDIUM_EMMC,
};

struct fixture {
	enum bm201_installer_sd_status request_sd_select_rc;
	enum bm201_installer_sd_status payload_sd_select_rc;
	unsigned int sd_select_count;
	int receipt_emmc_select_rc;
	int final_emmc_select_rc;
	unsigned int emmc_select_count;
	enum selected_medium medium;

	enum bm201_installer_file_status request_status;
	unsigned long long request_size;
	int request_read_rc;
	int request_valid;
	enum bm201_installer_file_status identity_status;
	unsigned long long identity_size;
	int identity_read_rc;
	char identity[BM201_INSTALLER_IDENTITY_BYTES];
	enum bm201_installer_file_status receipt_status;
	unsigned long long receipt_size;
	int receipt_read_rc;
	int receipt_matches;
	enum bm201_installer_file_status config_status;
	unsigned long long config_size;
	enum bm201_installer_file_status package_status;
	unsigned long long package_size;
	int burn_rc;
	int receipt_write_rc;
	int receipt_verify_read_rc;
	int receipt_verify_matches;

	enum operation calls[20];
	unsigned int call_count;
	unsigned int burn_count;
	unsigned int receipt_write_count;
	unsigned int reset_count;
};

static void record(struct fixture *fixture, enum operation operation)
{
	assert(fixture->call_count < ARRAY_SIZE(fixture->calls));
	fixture->calls[fixture->call_count++] = operation;
}

static enum bm201_installer_sd_status fake_select_sd(void *opaque)
{
	struct fixture *fixture = opaque;
	enum bm201_installer_sd_status rc;

	if (fixture->sd_select_count++ == 0) {
		record(fixture, OP_SELECT_SD_REQUEST);
		rc = fixture->request_sd_select_rc;
	} else {
		record(fixture, OP_SELECT_SD_PAYLOAD);
		rc = fixture->payload_sd_select_rc;
	}
	if (rc == BM201_INSTALLER_SD_OK)
		fixture->medium = MEDIUM_SD;
	return rc;
}

static enum bm201_installer_file_status
fake_read_receipt(void *opaque, void *buffer, unsigned int length)
{
	struct fixture *fixture = opaque;
	const char *content;

	assert(length == BM201_INSTALLER_IDENTITY_BYTES);
	if (!fixture->burn_count) {
		record(fixture, OP_RECEIPT_READ);
		if (fixture->receipt_status != BM201_INSTALLER_FILE_OK)
			return fixture->receipt_status;
		content = fixture->receipt_matches ? fixture->identity :
			TEST_OTHER_IDENTITY;
	} else {
		record(fixture, OP_VERIFY_RECEIPT);
		if (fixture->receipt_verify_read_rc)
			return BM201_INSTALLER_FILE_ERROR;
		content = fixture->receipt_verify_matches ? fixture->identity :
			TEST_OTHER_IDENTITY;
	}
	memcpy(buffer, content, length);
	return BM201_INSTALLER_FILE_OK;
}

static int fake_write_receipt(void *opaque, const void *buffer,
			      unsigned int length)
{
	struct fixture *fixture = opaque;

	assert(length == BM201_INSTALLER_IDENTITY_BYTES);
	assert(!memcmp(buffer, fixture->identity, length));
	record(fixture, OP_WRITE_RECEIPT);
	fixture->receipt_write_count++;
	return fixture->receipt_write_rc;
}

static enum bm201_installer_file_status
fake_file_size(void *opaque, const char *path, unsigned long long *size)
{
	struct fixture *fixture = opaque;

	if (!strcmp(path, BM201_INSTALLER_REQUEST_FILE)) {
		assert(fixture->medium == MEDIUM_SD);
		record(fixture, OP_REQUEST_SIZE);
		*size = fixture->request_size;
		return fixture->request_status;
	}
	if (!strcmp(path, BM201_INSTALLER_IDENTITY_FILE)) {
		assert(fixture->medium == MEDIUM_SD);
		record(fixture, OP_IDENTITY_SIZE);
		*size = fixture->identity_size;
		return fixture->identity_status;
	}
	if (!strcmp(path, BM201_INSTALLER_CONFIG)) {
		assert(fixture->medium == MEDIUM_SD);
		record(fixture, OP_CONFIG_SIZE);
		*size = fixture->config_size;
		return fixture->config_status;
	}
	assert(!strcmp(path, BM201_INSTALLER_PACKAGE));
	assert(fixture->medium == MEDIUM_SD);
	record(fixture, OP_PACKAGE_SIZE);
	*size = fixture->package_size;
	return fixture->package_status;
}

static int fake_read_file(void *opaque, const char *path, void *buffer,
			  unsigned int length)
{
	struct fixture *fixture = opaque;
	const char *content;

	if (!strcmp(path, BM201_INSTALLER_REQUEST_FILE)) {
		assert(fixture->medium == MEDIUM_SD);
		assert(length == sizeof(BM201_INSTALLER_REQUEST_CONTENT) - 1);
		record(fixture, OP_REQUEST_READ);
		if (fixture->request_read_rc)
			return fixture->request_read_rc;
		content = fixture->request_valid ?
			BM201_INSTALLER_REQUEST_CONTENT : TEST_INVALID_REQUEST;
		memcpy(buffer, content, length);
		return 0;
	}
	if (!strcmp(path, BM201_INSTALLER_IDENTITY_FILE)) {
		assert(fixture->medium == MEDIUM_SD);
		assert(length == BM201_INSTALLER_IDENTITY_BYTES);
		record(fixture, OP_IDENTITY_READ);
		if (fixture->identity_read_rc)
			return fixture->identity_read_rc;
		memcpy(buffer, fixture->identity, length);
		return 0;
	}

	(void)content;
	assert(!"installer read a file other than the SD ones");
	return -1;
}

static int fake_write_file(void *opaque, const char *path, const void *buffer,
			   unsigned int length)
{
	struct fixture *fixture = opaque;

	(void)fixture;
	(void)path;
	(void)buffer;
	(void)length;
	assert(!"installer wrote a file; the receipt is an environment variable");
	return -1;
}

static int fake_burn(void *opaque)
{
	struct fixture *fixture = opaque;

	assert(fixture->medium == MEDIUM_SD);
	record(fixture, OP_BURN);
	fixture->burn_count++;
	return fixture->burn_rc;
}

static void fake_reset(void *opaque)
{
	struct fixture *fixture = opaque;

	/* The last selection is the SD payload: with the receipt in the
	 * environment the installer never selects an eMMC FAT at all. */
	assert(fixture->medium == MEDIUM_SD);
	record(fixture, OP_RESET);
	fixture->reset_count++;
}

static const struct bm201_installer_ops ops = {
	.select_sd = fake_select_sd,
	.read_receipt = fake_read_receipt,
	.write_receipt = fake_write_receipt,
	.file_size = fake_file_size,
	.read_file = fake_read_file,
	.write_file = fake_write_file,
	.burn = fake_burn,
	.reset = fake_reset,
};

static struct fixture valid_fixture(void)
{
	struct fixture fixture = {
		.request_status = BM201_INSTALLER_FILE_OK,
		.request_size = sizeof(BM201_INSTALLER_REQUEST_CONTENT) - 1,
		.request_valid = 1,
		.identity_status = BM201_INSTALLER_FILE_OK,
		.identity_size = BM201_INSTALLER_IDENTITY_BYTES,
		.receipt_status = BM201_INSTALLER_FILE_MISSING,
		.config_status = BM201_INSTALLER_FILE_OK,
		.config_size = 128,
		.package_status = BM201_INSTALLER_FILE_OK,
		.package_size = 600ULL * 1024ULL * 1024ULL,
		.receipt_verify_matches = 1,
	};

	memcpy(fixture.identity, TEST_IDENTITY, sizeof(fixture.identity));
	return fixture;
}

static void expect_result(struct fixture *fixture,
			  enum bm201_installer_result expected_result,
			  const enum operation *expected_operations,
			  unsigned int expected_count)
{
	unsigned int index;

	assert(bm201_installer_run(&ops, fixture) == expected_result);
	assert(fixture->call_count == expected_count);
	for (index = 0; index < expected_count; index++)
		assert(fixture->calls[index] == expected_operations[index]);
}

#define EXPECT_RESULT(fixture, result, ...) \
	do { \
		const enum operation expected_operations[] = { __VA_ARGS__ }; \
		expect_result(&(fixture), (result), expected_operations, \
			      ARRAY_SIZE(expected_operations)); \
	} while (0)

#define REQUEST_OK \
	OP_SELECT_SD_REQUEST, OP_REQUEST_SIZE, OP_REQUEST_READ
#define IDENTITY_OK \
	REQUEST_OK, OP_IDENTITY_SIZE, OP_IDENTITY_READ
#define RECEIPT_MISSING \
	IDENTITY_OK, OP_RECEIPT_READ
#define RECEIPT_READ \
	RECEIPT_MISSING
#define PAYLOAD_CHECKS \
	RECEIPT_MISSING, OP_SELECT_SD_PAYLOAD, OP_CONFIG_SIZE, OP_PACKAGE_SIZE
#define PAYLOAD_CHECKS_AFTER_RECEIPT_READ \
	RECEIPT_READ, OP_SELECT_SD_PAYLOAD, OP_CONFIG_SIZE, OP_PACKAGE_SIZE

static void assert_no_mutations(const struct fixture *fixture)
{
	assert(fixture->burn_count == 0);
	assert(fixture->receipt_write_count == 0);
	assert(fixture->reset_count == 0);
}

static void test_constants(void)
{
	assert(!strcmp(BM201_INSTALLER_BLOCK_INTERFACE, "mmc"));
	assert(!strcmp(BM201_INSTALLER_SD_DEVICE, "0:1"));
	assert(!strcmp(BM201_INSTALLER_REQUEST_FILE,
		       "emmc-system-install.request"));
	assert(!strcmp(BM201_INSTALLER_REQUEST_CONTENT,
		       "BM201_INSTALL_V2\n"));
	assert(!strcmp(BM201_INSTALLER_IDENTITY_FILE, "update.img.sha256"));
	/* The receipt is an environment variable, not a file on any FAT: the
	 * only eMMC FAT reachable before the install is partition 1, which Mica OS
	 * never writes because it holds the Amlogic calibration scratch. */
	assert(!strcmp(BM201_INSTALLER_RECEIPT_ENV, "bm201_installed_package"));
	assert(!strcmp(BM201_INSTALLER_CONFIG, "bm201upd.ini"));
	assert(strcmp(BM201_INSTALLER_CONFIG, "aml_sdc_burn.ini"));
	assert(strcmp(BM201_INSTALLER_CONFIG, "aml_sdc_burn.auto.ini"));
	assert(!strcmp(BM201_INSTALLER_PACKAGE, "update.img"));
	assert(strcmp(BM201_INSTALLER_REQUEST_FILE,
		      "emmc-system-update.once"));
	assert(strcmp(BM201_INSTALLER_REQUEST_CONTENT, "BM201_INSTALL\n"));
	assert(BM201_INSTALLER_SHA256_HEX_BYTES == 64);
	assert(BM201_INSTALLER_IDENTITY_BYTES == 65);
	assert(BM201_INSTALLER_IDENTITY_BYTES ==
	       BM201_INSTALLER_SHA256_HEX_BYTES + 1);
	assert(sizeof(TEST_IDENTITY) - 1 == BM201_INSTALLER_IDENTITY_BYTES);
	assert(sizeof(TEST_OTHER_IDENTITY) - 1 ==
	       BM201_INSTALLER_IDENTITY_BYTES);
	assert(BM201_INSTALLER_FAT_MIB == 1792);
	assert(BM201_INSTALLER_MAX_PACKAGE_MIB == 1536);
	assert(BM201_INSTALLER_MAX_PACKAGE_BYTES == 1536ULL * 1024ULL * 1024ULL);
}

static void test_request_gate(void)
{
	struct fixture fixture;

	fixture = valid_fixture();
	fixture.request_sd_select_rc = BM201_INSTALLER_SD_ABSENT;
	EXPECT_RESULT(fixture, BM201_INSTALLER_NO_REQUEST,
		      OP_SELECT_SD_REQUEST);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_sd_select_rc = BM201_INSTALLER_SD_ERROR;
	EXPECT_RESULT(fixture, BM201_INSTALLER_REQUEST_SD_SELECT_FAILED,
		      OP_SELECT_SD_REQUEST);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_status = BM201_INSTALLER_FILE_MISSING;
	EXPECT_RESULT(fixture, BM201_INSTALLER_NO_REQUEST,
		      OP_SELECT_SD_REQUEST, OP_REQUEST_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_status = BM201_INSTALLER_FILE_ERROR;
	EXPECT_RESULT(fixture, BM201_INSTALLER_REQUEST_STAT_FAILED,
		      OP_SELECT_SD_REQUEST, OP_REQUEST_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_size = 0;
	EXPECT_RESULT(fixture, BM201_INSTALLER_REQUEST_LENGTH_INVALID,
		      OP_SELECT_SD_REQUEST, OP_REQUEST_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_size = sizeof("BM201_INSTALL\n") - 1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_REQUEST_LENGTH_INVALID,
		      OP_SELECT_SD_REQUEST, OP_REQUEST_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_read_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_REQUEST_READ_FAILED, REQUEST_OK);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_valid = 0;
	EXPECT_RESULT(fixture, BM201_INSTALLER_REQUEST_CONTENT_INVALID,
		      REQUEST_OK);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.request_status = BM201_INSTALLER_FILE_MISSING;
	fixture.receipt_status = BM201_INSTALLER_FILE_OK;
	fixture.receipt_size = BM201_INSTALLER_IDENTITY_BYTES;
	fixture.package_size = 1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_NO_REQUEST,
		      OP_SELECT_SD_REQUEST, OP_REQUEST_SIZE);
	assert_no_mutations(&fixture);
}

static void test_identity_validation(void)
{
	struct fixture fixture;

	fixture = valid_fixture();
	fixture.identity_status = BM201_INSTALLER_FILE_MISSING;
	EXPECT_RESULT(fixture, BM201_INSTALLER_IDENTITY_MISSING,
		      REQUEST_OK, OP_IDENTITY_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.identity_status = BM201_INSTALLER_FILE_ERROR;
	EXPECT_RESULT(fixture, BM201_INSTALLER_IDENTITY_STAT_FAILED,
		      REQUEST_OK, OP_IDENTITY_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.identity_size = BM201_INSTALLER_IDENTITY_BYTES - 1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_IDENTITY_LENGTH_INVALID,
		      REQUEST_OK, OP_IDENTITY_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.identity_read_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_IDENTITY_READ_FAILED,
		      IDENTITY_OK);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.identity[0] = 'A';
	EXPECT_RESULT(fixture, BM201_INSTALLER_IDENTITY_CHARACTER_INVALID,
		      IDENTITY_OK);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.identity[31] = 'g';
	EXPECT_RESULT(fixture, BM201_INSTALLER_IDENTITY_CHARACTER_INVALID,
		      IDENTITY_OK);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.identity[BM201_INSTALLER_SHA256_HEX_BYTES] = 'x';
	EXPECT_RESULT(fixture, BM201_INSTALLER_IDENTITY_NEWLINE_INVALID,
		      IDENTITY_OK);
	assert_no_mutations(&fixture);
}

static void test_receipt_decisions(void)
{
	struct fixture fixture;

	fixture = valid_fixture();
	fixture.receipt_status = BM201_INSTALLER_FILE_ERROR;
	EXPECT_RESULT(fixture, BM201_INSTALLER_RECEIPT_READ_FAILED,
		      RECEIPT_READ);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.receipt_status = BM201_INSTALLER_FILE_OK;
	fixture.receipt_size = BM201_INSTALLER_IDENTITY_BYTES;
	fixture.receipt_matches = 1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_ALREADY_INSTALLED, RECEIPT_READ);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.burn_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_BURN_FAILED,
		      PAYLOAD_CHECKS, OP_BURN);
	assert(fixture.burn_count == 1);
	assert(fixture.receipt_write_count == 0);
	assert(fixture.reset_count == 0);

	fixture = valid_fixture();
	fixture.receipt_status = BM201_INSTALLER_FILE_OK;
	fixture.receipt_size = BM201_INSTALLER_IDENTITY_BYTES - 1;
	fixture.burn_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_BURN_FAILED,
		      PAYLOAD_CHECKS, OP_BURN);
	assert(fixture.burn_count == 1);
	assert(fixture.receipt_write_count == 0);

	fixture = valid_fixture();
	fixture.receipt_status = BM201_INSTALLER_FILE_OK;
	fixture.receipt_size = BM201_INSTALLER_IDENTITY_BYTES;
	fixture.receipt_matches = 0;
	fixture.burn_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_BURN_FAILED,
		      PAYLOAD_CHECKS_AFTER_RECEIPT_READ, OP_BURN);
	assert(fixture.burn_count == 1);
	assert(fixture.receipt_write_count == 0);
}

static void test_payload_checks(void)
{
	struct fixture fixture;

	fixture = valid_fixture();
	fixture.payload_sd_select_rc = BM201_INSTALLER_SD_ERROR;
	EXPECT_RESULT(fixture, BM201_INSTALLER_SOURCE_SD_SELECT_FAILED,
		      RECEIPT_MISSING, OP_SELECT_SD_PAYLOAD);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.payload_sd_select_rc = BM201_INSTALLER_SD_ABSENT;
	EXPECT_RESULT(fixture, BM201_INSTALLER_SOURCE_SD_SELECT_FAILED,
		      RECEIPT_MISSING, OP_SELECT_SD_PAYLOAD);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.config_status = BM201_INSTALLER_FILE_MISSING;
	EXPECT_RESULT(fixture, BM201_INSTALLER_CONFIG_MISSING,
		      RECEIPT_MISSING, OP_SELECT_SD_PAYLOAD, OP_CONFIG_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.config_status = BM201_INSTALLER_FILE_ERROR;
	EXPECT_RESULT(fixture, BM201_INSTALLER_CONFIG_STAT_FAILED,
		      RECEIPT_MISSING, OP_SELECT_SD_PAYLOAD, OP_CONFIG_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.config_size = 0;
	EXPECT_RESULT(fixture, BM201_INSTALLER_CONFIG_EMPTY,
		      RECEIPT_MISSING, OP_SELECT_SD_PAYLOAD, OP_CONFIG_SIZE);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.package_status = BM201_INSTALLER_FILE_MISSING;
	EXPECT_RESULT(fixture, BM201_INSTALLER_PACKAGE_MISSING,
		      PAYLOAD_CHECKS);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.package_status = BM201_INSTALLER_FILE_ERROR;
	EXPECT_RESULT(fixture, BM201_INSTALLER_PACKAGE_STAT_FAILED,
		      PAYLOAD_CHECKS);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.package_size = 0;
	EXPECT_RESULT(fixture, BM201_INSTALLER_PACKAGE_EMPTY, PAYLOAD_CHECKS);
	assert_no_mutations(&fixture);

	fixture = valid_fixture();
	fixture.package_size = BM201_INSTALLER_MAX_PACKAGE_BYTES + 1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_PACKAGE_TOO_LARGE,
		      PAYLOAD_CHECKS);
	assert_no_mutations(&fixture);
}

static void test_burn_and_receipt_commit(void)
{
	struct fixture fixture;

	fixture = valid_fixture();
	fixture.burn_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_BURN_FAILED,
		      PAYLOAD_CHECKS, OP_BURN);
	assert(fixture.burn_count == 1);
	assert(fixture.receipt_write_count == 0);
	assert(fixture.reset_count == 0);


	fixture = valid_fixture();
	fixture.receipt_write_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_RECEIPT_WRITE_FAILED,
		      PAYLOAD_CHECKS, OP_BURN,
		      OP_WRITE_RECEIPT);
	assert(fixture.burn_count == 1);
	assert(fixture.receipt_write_count == 1);
	assert(fixture.reset_count == 0);

	fixture = valid_fixture();
	fixture.receipt_verify_read_rc = -1;
	EXPECT_RESULT(fixture, BM201_INSTALLER_RECEIPT_VERIFY_READ_FAILED,
		      PAYLOAD_CHECKS, OP_BURN,
		      OP_WRITE_RECEIPT, OP_VERIFY_RECEIPT);
	assert(fixture.receipt_write_count == 1);
	assert(fixture.reset_count == 0);

	fixture = valid_fixture();
	fixture.receipt_verify_matches = 0;
	EXPECT_RESULT(fixture, BM201_INSTALLER_RECEIPT_VERIFY_MISMATCH,
		      PAYLOAD_CHECKS, OP_BURN,
		      OP_WRITE_RECEIPT, OP_VERIFY_RECEIPT);
	assert(fixture.receipt_write_count == 1);
	assert(fixture.reset_count == 0);

	fixture = valid_fixture();
	EXPECT_RESULT(fixture, BM201_INSTALLER_RESET_RETURNED,
		      PAYLOAD_CHECKS, OP_BURN,
		      OP_WRITE_RECEIPT, OP_VERIFY_RECEIPT, OP_RESET);
	assert(fixture.burn_count == 1);
	assert(fixture.receipt_write_count == 1);
	assert(fixture.reset_count == 1);
	assert(fixture.calls[fixture.call_count - 1] == OP_RESET);
}

int main(void)
{
	test_constants();
	test_request_gate();
	test_identity_validation();
	test_receipt_decisions();
	test_payload_checks();
	test_burn_and_receipt_commit();

	puts("BM201 reusable eMMC installer state tests passed");
	return 0;
}

#endif
