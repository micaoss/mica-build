// SPDX-License-Identifier: GPL-2.0+

#include <assert.h>
#include <stdio.h>

#include "boot_source_logic.h"

struct fixture {
	int load_a_status;
	int load_b_status;
	int source_status;
	unsigned int load_count;
	unsigned int source_count;
	unsigned int partitions[2];
};

static int fixture_load(void *opaque, unsigned int partition)
{
	struct fixture *fixture = opaque;

	assert(fixture->load_count < 2);
	fixture->partitions[fixture->load_count++] = partition;
	if (partition == BM201_EMMC_BOOT_SCRIPT_A)
		return fixture->load_a_status;
	assert(partition == BM201_EMMC_BOOT_SCRIPT_B);
	return fixture->load_b_status;
}

static int fixture_source(void *opaque)
{
	struct fixture *fixture = opaque;

	fixture->source_count++;
	return fixture->source_status;
}

static const struct bm201_emmc_boot_script_ops fixture_ops = {
	.load = fixture_load,
	.source = fixture_source,
};

static void test_primary_script(void)
{
	struct fixture fixture = { 0 };

	assert(bm201_emmc_boot_script_run(&fixture_ops, &fixture) == 0);
	assert(fixture.load_count == 1);
	assert(fixture.partitions[0] == BM201_EMMC_BOOT_SCRIPT_A);
	assert(fixture.source_count == 1);
}

static void test_secondary_load_fallback(void)
{
	struct fixture fixture = { .load_a_status = -1 };

	assert(bm201_emmc_boot_script_run(&fixture_ops, &fixture) == 0);
	assert(fixture.load_count == 2);
	assert(fixture.partitions[0] == BM201_EMMC_BOOT_SCRIPT_A);
	assert(fixture.partitions[1] == BM201_EMMC_BOOT_SCRIPT_B);
	assert(fixture.source_count == 1);
}

static void test_no_script(void)
{
	struct fixture fixture = { .load_a_status = -1, .load_b_status = -2 };

	assert(bm201_emmc_boot_script_run(&fixture_ops, &fixture) == -2);
	assert(fixture.load_count == 2);
	assert(fixture.source_count == 0);
}

static void test_source_failure_does_not_rerun_the_handshake(void)
{
	struct fixture fixture = { .source_status = -1 };

	assert(bm201_emmc_boot_script_run(&fixture_ops, &fixture) == -1);
	assert(fixture.load_count == 1);
	assert(fixture.source_count == 1);
}

int main(void)
{
	test_primary_script();
	test_secondary_load_fallback();
	test_no_script();
	test_source_failure_does_not_rerun_the_handshake();
	puts("BM201 eMMC boot script fallback contract tests passed");
	return 0;
}
