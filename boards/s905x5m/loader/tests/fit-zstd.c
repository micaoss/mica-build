/* SPDX-License-Identifier: GPL-2.0+ */
#include <common.h>
#include <abuf.h>
#include <linux/zstd.h>

static size_t allocation_limit, allocated, largest_allocation;

static void *bounded_malloc(size_t size)
{
	if (size > largest_allocation)
		largest_allocation = size;
	if (size > allocation_limit - allocated)
		return NULL;
	void *result = malloc(size);
	if (result)
		allocated += size;
	return result;
}
static void bounded_free(void *p)
{
	if (p)
		allocated = 0;
	free(p);
}

#define malloc bounded_malloc
#define free bounded_free
#include "vendor-zstd-wrapper.c"
#undef malloc
#undef free

int probe_decode(void *src, size_t src_size, void *dst, size_t dst_size,
		size_t budget)
{
	struct abuf in = { src, src_size }, out = { dst, dst_size };
	allocation_limit = budget;
	allocated = largest_allocation = 0;
	int ret = zstd_decompress(&in, &out);
	assert(allocated == 0);
	return ret;
}

size_t probe_largest_allocation(void) { return largest_allocation; }
