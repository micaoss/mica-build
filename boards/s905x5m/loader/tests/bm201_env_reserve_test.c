// SPDX-License-Identifier: GPL-2.0+

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "bm201_emmc_installer.h"

#define ARRAY_SIZE(array) (sizeof(array) / sizeof((array)[0]))
#define REDUNDANT_COPY_COUNT 2

static const char receipt[] =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct environment {
	char upgrade_step[2];
	char receipt[BM201_INSTALLER_SHA256_HEX_BYTES + 1];
	int receipt_present;
};

struct redundant_copy {
	struct environment environment;
	unsigned int serial;
	int valid;
};

struct fixture {
	struct environment memory;
	struct redundant_copy copies[REDUNDANT_COPY_COUNT];
	unsigned int active_copy;
};

static int option_selected(const char *arguments, const char *option)
{
	char copy[16];
	char *token;

	assert(strlen(arguments) < sizeof(copy));
	strcpy(copy, arguments);
	for (token = strtok(copy, " "); token; token = strtok(NULL, " ")) {
		if (!strcmp(token, option))
			return 1;
	}
	return 0;
}

static void set_receipt(struct environment *environment, const char *value)
{
	assert(strlen(value) == BM201_INSTALLER_SHA256_HEX_BYTES);
	strcpy(environment->receipt, value);
	environment->receipt_present = 1;
}

static void reload_redundant_environment(struct fixture *fixture)
{
	unsigned int index;
	unsigned int newest = REDUNDANT_COPY_COUNT;

	memset(&fixture->memory, 0, sizeof(fixture->memory));
	for (index = 0; index < ARRAY_SIZE(fixture->copies); index++) {
		if (!fixture->copies[index].valid)
			continue;
		if (newest == REDUNDANT_COPY_COUNT ||
		    fixture->copies[index].serial > fixture->copies[newest].serial)
			newest = index;
	}
	assert(newest != REDUNDANT_COPY_COUNT);
	fixture->memory = fixture->copies[newest].environment;
	fixture->active_copy = newest;
}

static struct fixture fixture_after_install(void)
{
	struct fixture fixture = { 0 };

	strcpy(fixture.copies[0].environment.upgrade_step, "1");
	fixture.copies[0].serial = 1;
	fixture.copies[0].valid = 1;

	strcpy(fixture.copies[1].environment.upgrade_step, "1");
	set_receipt(&fixture.copies[1].environment, receipt);
	fixture.copies[1].serial = 2;
	fixture.copies[1].valid = 1;

	reload_redundant_environment(&fixture);
	assert(!strcmp(fixture.memory.upgrade_step, "1"));
	assert(fixture.memory.receipt_present);
	assert(!strcmp(fixture.memory.receipt, receipt));
	return fixture;
}

static void selected_default(struct fixture *fixture, const char *arguments)
{
	struct environment before = fixture->memory;
	int preserve_common;
	int preserve_board0;

	preserve_common = option_selected(arguments, "-c") ||
		option_selected(arguments, "-c0");
	preserve_board0 = option_selected(arguments, "-b0");
	memset(&fixture->memory, 0, sizeof(fixture->memory));
	strcpy(fixture->memory.upgrade_step, "0");
	if (preserve_common)
		strcpy(fixture->memory.upgrade_step, before.upgrade_step);
	if (preserve_board0 && before.receipt_present)
		set_receipt(&fixture->memory, before.receipt);
}

static void save_redundant_environment(struct fixture *fixture)
{
	unsigned int next = fixture->active_copy ^ 1U;

	fixture->copies[next].environment = fixture->memory;
	fixture->copies[next].serial =
		fixture->copies[fixture->active_copy].serial + 1;
	fixture->copies[next].valid = 1;
	fixture->active_copy = next;
}

static void first_boot_default_and_save(struct fixture *fixture,
					const char *defenv_para)
{
	assert(!strcmp(fixture->memory.upgrade_step, "1"));
	selected_default(fixture, defenv_para);
	strcpy(fixture->memory.upgrade_step, "2");
	save_redundant_environment(fixture);
}

static void test_old_selection_drops_receipt(void)
{
	struct fixture fixture = fixture_after_install();

	first_boot_default_and_save(&fixture, "-c");
	reload_redundant_environment(&fixture);
	assert(!fixture.memory.receipt_present);
}

static void test_board_selection_preserves_receipt(void)
{
	struct fixture fixture = fixture_after_install();

	first_boot_default_and_save(&fixture, "-c -b0");
	reload_redundant_environment(&fixture);
	assert(!strcmp(fixture.memory.upgrade_step, "2"));
	assert(fixture.memory.receipt_present);
	assert(!strcmp(fixture.memory.receipt, receipt));
}

int main(void)
{
	test_old_selection_drops_receipt();
	test_board_selection_preserves_receipt();
	puts("ok: BM201 next-boot defenv preserves the exact installer receipt after redundant reload");
	return 0;
}
