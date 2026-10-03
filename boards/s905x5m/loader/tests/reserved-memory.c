/* Compile the pinned fixup function with its real libfdt implementation. */
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libfdt.h>

static unsigned char original[262144], working[262144];
static size_t original_size;
static int fail_command;
#define RAMOOP_MEM_SIZE 0x100000
#define RSV_MEM_ALIGNMENT 0x400000
#define rsvmem_err(...) fprintf(stderr, __VA_ARGS__)
#define rsvmem_dbg(...) ((void)0)

static int run_command(const char *command, int flag)
{
	char text[256], *tokens[24], *save = NULL, *word;
	fdt32_t cells[8];
	int count = 0, node, len, ret;
	(void)flag;
	if (fail_command)
		return 1;
	assert(strlen(command) < sizeof(text));
	strcpy(text, command);
	for (word = strtok_r(text, " \t;<>", &save); word;
	     word = strtok_r(NULL, " \t;<>", &save)) {
		assert(count < 24);
		tokens[count++] = word;
	}
	assert(count >= 4 && !strcmp(tokens[0], "fdt"));
	if (!strcmp(tokens[1], "get")) {
		assert(count == 6 && !strcmp(tokens[2], "value"));
		node = fdt_path_offset(working, tokens[4]);
		return node < 0 || !fdt_getprop(working, node, tokens[5], &len);
	}
	assert(!strcmp(tokens[1], "set") && count <= 12);
	node = fdt_path_offset(working, tokens[2]);
	assert(node >= 0);
	for (int i = 4; i < count; i++) {
		char *end;
		unsigned long value = strtoul(tokens[i], &end, 0);
		assert(*end == 0 && value <= UINT32_MAX);
		cells[i - 4] = cpu_to_fdt32(value);
	}
	ret = fdt_setprop(working, node, tokens[3], cells, (count - 4) * 4);
	if (ret)
		fprintf(stderr, "%s: %s\n", command, fdt_strerror(ret));
	return ret != 0;
}

#include "vendor-rsvmem-function.c"


static uint32_t value(const char *path, const char *property, int index,
		      int expected_bytes)
{
	int len;
	const fdt32_t *p = fdt_getprop(working, fdt_path_offset(working, path),
				      property, &len);
	assert(p && len == expected_bytes && index * 4 < len);
	return fdt32_to_cpu(p[index]);
}

static void reset(int pad)
{
	memcpy(working, original, original_size);
	if (pad)
		assert(!fdt_open_into(working, working, original_size + pad));
}

int main(int argc, char **argv)
{
	FILE *input;
	assert(argc <= 2);
	if (argc == 1) {
		fdt32_t reg[] = { 0, cpu_to_fdt32(0x07400000), 0, cpu_to_fdt32(0x100000) };
		int node, reserved;
		assert(!fdt_create_empty_tree(original, sizeof(original)));
		node = fdt_add_subnode(original, 0, "secmon");
		assert(node >= 0);
		assert(!fdt_setprop_u32(original, node, "reserve_mem_size", 0x03300000));
		reserved = fdt_add_subnode(original, 0, "reserved-memory");
		assert(reserved >= 0);
		node = fdt_add_subnode(original, reserved, "ramoops");
		assert(node >= 0);
		assert(!fdt_setprop(original, node, "reg", reg, sizeof(reg)));
		node = fdt_add_subnode(original, reserved, "linux,secmon");
		assert(node >= 0);
		reg[1] = cpu_to_fdt32(0x05000000);
		reg[3] = cpu_to_fdt32(0x03300000);
		assert(!fdt_setprop(original, node, "reg", reg, sizeof(reg)));
		assert(!fdt_setprop(original, node, "no-map", NULL, 0));
		assert(!fdt_pack(original));
		original_size = fdt_totalsize(original);
	} else {
	input = fopen(argv[1], "rb");
	assert(input);
	original_size = fread(original, 1, sizeof(original), input);
	assert(!ferror(input) && feof(input));
	fclose(input);
	assert(!fdt_check_header(original));
	assert(fdt_totalsize(original) == original_size);
	}

	for (int pad = 0; pad <= 0x3000; pad += 0x3000) {
		reset(pad);
		assert(!fdt_config_rsv_mem(0, 0x100000, 0x05000000, 0x01c00000));
		assert(value("/secmon", "reserve_mem_size", 0, 4) == 0x01c00000);
		assert(value("/reserved-memory/ramoops", "reg", 1, 16) == 0x06c00000);
		assert(value("/reserved-memory/linux,secmon", "reg", 1, 16) == 0x05000000);
		assert(value("/reserved-memory/linux,secmon", "reg", 3, 16) == 0x01c00000);
		/* Re-entry must preserve the final reservations. */
		assert(!fdt_config_rsv_mem(0, 0x100000, 0x05000000, 0x01c00000));
		assert(value("/secmon", "reserve_mem_size", 0, 4) == 0x01c00000);
		assert(value("/reserved-memory/ramoops", "reg", 1, 16) == 0x06c00000);
	}
	assert(fdt_config_rsv_mem(0, 0, 0, 0x01c00000) == -EINVAL);
	fail_command = 1;
	assert(fdt_config_rsv_mem(0, 0, 0x05000000, 0x01c00000) == -ENODEV);
	puts("RSVMEM_SCALAR_PASS: packed/padded and repeated handoffs agree");
	return 0;
}
