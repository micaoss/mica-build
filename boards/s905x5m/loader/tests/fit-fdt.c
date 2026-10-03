/* SPDX-License-Identifier: GPL-2.0+ */
/* Compile the applied vendor functions; stub only their external services. */
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef unsigned long ulong;
typedef uint8_t u8;
typedef uint32_t u32;
#define CONFIG_AMLOGIC_MODIFY 1
#ifndef TEST_VENDOR_PATH
#define CONFIG_MICA_FILE_BOOT 1
#endif
#define CONFIG_OF_LIBFDT_OVERLAY 1
#define CONFIG_IS_ENABLED(option) ENABLED_##option
#define ENABLED_FIT 1
#define ENABLED_LEGACY_IMAGE_FORMAT 0
#define ENABLED_OF_LIBFDT 1
#define ENABLED_CMD_FDT 1
#define IS_ENABLED(option) 0
#define IMAGE_FORMAT_FIT 2
#define IMAGE_SIZE_INVAL 0
#define IH_ARCH_DEFAULT 22
#define IH_INITRD_ARCH 22
#define IH_TYPE_MULTI 4
#define FIT_FDT_PROP "fdt"
#define debug(...) ((void)0)

struct bootm_headers {
	const void *fit_hdr_os, *fit_hdr_rd, *fit_hdr_fdt;
	const char *fit_uname_cfg, *fit_uname_os, *fit_uname_rd, *fit_uname_fdt;
	int fit_noffset_fdt, legacy_hdr_valid, legacy_hdr_os_copy, verify;
	void *legacy_hdr_os;
	ulong rd_start, rd_end, ft_len;
	char *ft_addr;
};
static struct bootm_headers images;
static char fit[64], control_fdt[64], kernel_fdt[64];
static ulong image_load_addr;
static int environment_present, missing_fdt, rejected_fdt;
static int verified_loads, overlay_reads, overlay_applies;

static ulong hextoul(const char *s, char **end) { return strtoul(s, end, 16); }
static void *map_sysmem(ulong addr, ulong size)
{
	(void)size;
	/* The old absent-environment default must stay readable for the test. */
	return addr == 0x01000000 ? control_fdt : (void *)addr;
}
static ulong map_to_sysmem(const void *p) { return (ulong)p; }
static const char *env_get(const char *name)
{
	static char address[32];
	assert(!strcmp(name, "dtb_mem_addr"));
	snprintf(address, sizeof(address), "%lx", (ulong)control_fdt);
	return environment_present ? address : NULL;
}
static int genimg_has_config(struct bootm_headers *hdr) { return hdr->fit_uname_cfg != NULL; }
static int genimg_get_format(const void *p) { (void)p; return IMAGE_FORMAT_FIT; }
static int fit_check_format(const void *p, ulong size) { (void)size; return p == fit ? 0 : -EINVAL; }
static int fit_parse_conf(const char *s, ulong d, ulong *a, const char **n)
{ (void)s; (void)d; (void)a; (void)n; return 0; }
#define fit_parse_subimage fit_parse_conf
static int fit_get_node_from_config(struct bootm_headers *hdr, const char *name, ulong addr)
{
	assert(hdr == &images && !strcmp(name, "fdt") && addr == (ulong)fit);
	return missing_fdt ? -ENOENT : 1;
}
static int boot_get_fdt_fit(struct bootm_headers *hdr, ulong addr,
		const char **name, const char **config, int arch, ulong *load, ulong *size)
{
	assert(hdr == &images && hdr->verify && addr == (ulong)fit);
	assert(*config && !strcmp(*config, "conf") && arch == IH_ARCH_DEFAULT);
	verified_loads++;
	if (rejected_fdt)
		return -EACCES;
	*name = "fdt";
	*load = (ulong)kernel_fdt;
	*size = sizeof(kernel_fdt);
	return 1;
}
static ulong fdt_totalsize(const void *p) { (void)p; return sizeof(kernel_fdt); }
#define fdt_get_header(p, field) fdt_totalsize(p)
#define fdt_set_totalsize(p, size) ((void)0)
#define fdt_check_header(p) 0
#define fdt_error(...) ((void)0)
#define image_check_type(p, type) 0
#define image_multi_getimg(...) ((void)0)
#define set_working_fdt_addr(addr) ((void)0)
#define boot_get_ramdisk(...) 0
#define boot_get_fpga(...) 0
#define boot_get_loadable(...) 0
static int get_fdto_totalsize(u32 *size) { overlay_reads++; *size = 0; return -ENOENT; }
static void do_fdt_overlay(void) { overlay_applies++; }

#include "vendor-fdt-functions.c"

static int run_case(int environment, int missing, int rejected, int configured, int override)
{
	char address[32], raw[32];
	char *args[] = { address, "-", raw };

	memset(&images, 0, sizeof(images));
	images.fit_hdr_os = fit;
	images.fit_uname_os = "kernel";
	images.fit_uname_cfg = configured ? "conf" : NULL;
	images.verify = 1;
	image_load_addr = (ulong)fit;
	environment_present = environment;
	missing_fdt = missing;
	rejected_fdt = rejected;
	verified_loads = overlay_reads = overlay_applies = 0;
	snprintf(address, sizeof(address), "%lx", (ulong)fit);
	snprintf(raw, sizeof(raw), "%lx", (ulong)control_fdt);
	return bootm_find_images(0, override ? 3 : 1, args, 0, 0);
}

int main(void)
{
#ifdef TEST_VENDOR_PATH
	assert(run_case(1, 0, 0, 1, 0) == 0);
	assert(images.ft_addr == control_fdt && verified_loads == 0);
	assert(overlay_reads == 1 && overlay_applies == 1);
	puts("NON_MICA_VENDOR_FDT_PATH_PASS");
#else
	for (int environment = 0; environment <= 1; environment++) {
		assert(run_case(environment, 0, 0, 1, 0) == 0);
		assert(images.ft_addr == kernel_fdt && verified_loads == 1);
		assert(overlay_reads == 0 && overlay_applies == 0);
		assert(run_case(environment, 1, 0, 1, 0) != 0);
		assert(run_case(environment, 0, 1, 1, 0) != 0);
		assert(run_case(environment, 0, 0, 0, 0) != 0);
		assert(run_case(environment, 0, 0, 1, 1) != 0);
	}
	puts("MICA_FIT_FDT_SELECTION_PASS");
#endif
	return 0;
}
