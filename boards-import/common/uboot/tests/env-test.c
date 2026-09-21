// SPDX-License-Identifier: GPL-2.0+
/* The FIT loaders' redundant-environment entry, against the layout the assembly
 * writes (mica-build:build/src/fit-environment.ts): CRC and flag in bytes 0-4,
 * "mica_entries=" from byte 5, the value from byte 5 + the key's length, zeros
 * after it. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../mica-records.h"

#define SIZE 65536
#define ID "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
#define KERNEL "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
#define VALUE "v1|" ID "," KERNEL ",7,3"

static unsigned char env[SIZE];

/* What the assembly writes, spelled out rather than derived from the header. */
static void assembly_layout(const char *key, const char *value)
{
	memset(env, 0, SIZE);
	memcpy(env + 5, key, strlen(key));
	memcpy(env + 5 + strlen(key), value, strlen(value));
}

int main(void)
{
	struct mica_boot_records records, again;
	char text[MICA_BOOT_VALUE_LIMIT + 1], long_value[MICA_BOOT_VALUE_LIMIT + 2];
	const char *value;

	assert(MICA_ENV_VALUE_OFFSET == 18);

	/* The assembly's environment decodes to its value. */
	assembly_layout("mica_entries=", VALUE);
	value = mica_env_value(env, SIZE);
	assert(value && !strcmp(value, VALUE));
	assert(!mica_boot_parse(value, &records) && records.count == 1 && records.entry[0].tries == 3);

	/* Persist -> decode round-trips, and the stored entry is the assembly's layout. */
	records.entry[0].tries = 2;
	assert(!mica_boot_render(&records, text));
	memset(env, 0xff, SIZE);
	memset(env + 5, 0, SIZE - 5);
	mica_env_store(env, text);
	assert(!memcmp(env + 5, "mica_entries=", 13) && env[17] == '=' && !strcmp((char *)env + 18, text));
	value = mica_env_value(env, SIZE);
	assert(value && !mica_boot_parse(value, &again) && again.entry[0].tries == 2);

	/* Refused: no "=", another key, a value past the limit, bytes after the terminator. */
	assembly_layout("mica_entriesv", "1|x");
	assert(!mica_env_value(env, SIZE));
	assembly_layout("boot_entries=", VALUE);
	assert(!mica_env_value(env, SIZE));
	memset(long_value, 'a', sizeof(long_value) - 1);
	long_value[sizeof(long_value) - 1] = 0;
	assembly_layout("mica_entries=", long_value);
	assert(!mica_env_value(env, SIZE));
	assembly_layout("mica_entries=", VALUE);
	env[SIZE - 1] = 1;
	assert(!mica_env_value(env, SIZE));

	puts("env-test: PASS");
	return 0;
}
