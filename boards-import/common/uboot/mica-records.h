/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef MICA_BOOT_RECORDS_H
#define MICA_BOOT_RECORDS_H

#include <stdio.h>
#include <string.h>

#define MICA_BOOT_RECORD_LIMIT 2
#define MICA_BOOT_VALUE_LIMIT 512
#define MICA_BOOT_GENERATION_LIMIT 9007199254740991ULL

struct mica_boot_record {
	char id[65];
	char kernel[65];
	unsigned long long generation;
	int tries;
};

struct mica_boot_records {
	struct mica_boot_record entry[MICA_BOOT_RECORD_LIMIT];
	unsigned int count;
};

static inline int mica_boot_id(const char **cursor, const char *end, char id[65])
{
	const char *p = *cursor;
	unsigned int i;

	if (end - p < 65 || p[64] != ',')
		return -1;
	for (i = 0; i < 64; i++)
		if (!((p[i] >= '0' && p[i] <= '9') ||
		      (p[i] >= 'a' && p[i] <= 'f')))
			return -1;
	memcpy(id, p, 64);
	id[64] = 0;
	*cursor = p + 65;
	return 0;
}

static inline int mica_boot_parse(const char *text, struct mica_boot_records *out)
{
	const char *p, *end;
	unsigned int length, i;

	for (length = 0; length <= MICA_BOOT_VALUE_LIMIT && text[length]; length++)
		;
	if (length > MICA_BOOT_VALUE_LIMIT || length < 4 || strncmp(text, "v1|", 3))
		return -1;
	memset(out, 0, sizeof(*out));
	p = text + 3;
	end = text + length;
	while (p < end) {
		struct mica_boot_record *r;

		if (out->count == MICA_BOOT_RECORD_LIMIT)
			return -1;
		r = &out->entry[out->count];
		if (mica_boot_id(&p, end, r->id) || mica_boot_id(&p, end, r->kernel))
			return -1;
		if (p == end || *p < '1' || *p > '9')
			return -1;
		while (p < end && *p >= '0' && *p <= '9') {
			unsigned int digit = *p++ - '0';

			if (r->generation > (MICA_BOOT_GENERATION_LIMIT - digit) / 10)
				return -1;
			r->generation = r->generation * 10 + digit;
		}
		if (end - p < 2 || *p++ != ',')
			return -1;
		if (*p == '-')
			r->tries = -1;
		else if (*p >= '0' && *p <= '3')
			r->tries = *p - '0';
		else
			return -1;
		p++;
		for (i = 0; i < out->count; i++)
			if (!strcmp(out->entry[i].id, r->id) ||
			    out->entry[i].generation <= r->generation)
				return -1;
		out->count++;
		if (p == end)
			return 0;
		if (*p++ != ';' || p == end)
			return -1;
	}
	return -1;
}

static inline int mica_boot_render(const struct mica_boot_records *records,
				  char text[MICA_BOOT_VALUE_LIMIT + 1])
{
	struct mica_boot_records checked;
	unsigned int i, used = 3;

	if (!records->count || records->count > MICA_BOOT_RECORD_LIMIT)
		return -1;
	memcpy(text, "v1|", 4);
	for (i = 0; i < records->count; i++) {
		const struct mica_boot_record *r = &records->entry[i];
		int written;

		if (r->tries < -1 || r->tries > 3)
			return -1;
		written = snprintf(text + used, MICA_BOOT_VALUE_LIMIT + 1 - used,
				   "%s%s,%s,%llu,%c", i ? ";" : "", r->id,
				   r->kernel, r->generation,
				   r->tries < 0 ? '-' : '0' + r->tries);
		if (written < 0 || (unsigned int)written > MICA_BOOT_VALUE_LIMIT - used)
			return -1;
		used += written;
	}
	return mica_boot_parse(text, &checked);
}

/* The one entry of a redundant-environment copy: CRC and flag in bytes 0-4,
 * MICA_ENV_KEY from byte 5, the value right after it, zeros to the end. The
 * offsets derive from the key, never from a counted length. */
#define MICA_ENV_KEY "mica_entries="
#define MICA_ENV_KEY_LENGTH (sizeof(MICA_ENV_KEY) - 1)
#define MICA_ENV_VALUE_OFFSET (5 + MICA_ENV_KEY_LENGTH)

/* The entry's value, or NULL unless the copy holds exactly that entry. */
static inline const char *mica_env_value(const unsigned char *bytes, unsigned int size)
{
	unsigned int end;

	if (memcmp(bytes + 5, MICA_ENV_KEY, MICA_ENV_KEY_LENGTH))
		return NULL;
	for (end = MICA_ENV_VALUE_OFFSET; end < size && bytes[end]; end++)
		;
	if (end - MICA_ENV_VALUE_OFFSET > MICA_BOOT_VALUE_LIMIT || end + 1 >= size)
		return NULL;
	for (; end < size; end++)
		if (bytes[end])
			return NULL;
	return (const char *)bytes + MICA_ENV_VALUE_OFFSET;
}

/* Writes the entry with the value text into a copy zeroed from byte 5. */
static inline void mica_env_store(unsigned char *bytes, const char *text)
{
	memcpy(bytes + 5, MICA_ENV_KEY, MICA_ENV_KEY_LENGTH);
	memcpy(bytes + MICA_ENV_VALUE_OFFSET, text, strlen(text));
}

static inline int mica_boot_next(const struct mica_boot_records *records)
{
	unsigned int i;

	for (i = 0; i < records->count; i++)
		if (records->entry[i].tries != 0)
			return i;
	return -1;
}

static inline int mica_boot_slot(int valid_a, unsigned char a,
				int valid_b, unsigned char b)
{
	if (!valid_a)
		return valid_b ? 1 : -1;
	if (!valid_b)
		return 0;
	return (a == 255 && b == 0) || (b > a && !(b == 255 && a == 0));
}
#endif
