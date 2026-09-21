// SPDX-License-Identifier: GPL-2.0+

#if defined(BM201_BOOTMENU_PRODUCTION_SEAM)

#define _GNU_SOURCE

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef unsigned short u16;
typedef unsigned long efi_status_t;
typedef unsigned long efi_uintn_t;

#define EFI_SUCCESS 0UL
#define EFI_NOT_FOUND 1UL
#define EFI_ERROR_MASK 0UL
#define EFI_VARIABLE_BOOTSERVICE_ACCESS 1U
#define EFI_VARIABLE_RUNTIME_ACCESS 2U
#define CMD_RET_SUCCESS 0
#define CONFIG_SYS_CBSIZE 64

#define CONFIG_CMD_BOOTEFI_BOOTMGR BM201_CONFIG_CMD_BOOTEFI_BOOTMGR
#define CONFIG_BOOTMENU_DISABLE_UBOOT_CONSOLE \
	BM201_CONFIG_BOOTMENU_DISABLE_UBOOT_CONSOLE
#define CONFIG_IS_ENABLED(option) BM201_CONFIG_##option
#define IS_ENABLED(option) (option)

#define ANSI_CURSOR_POSITION "\033[%d;%dH"
#define ANSI_CLEAR_LINE ""
#define ANSI_CLEAR_LINE_TO_END ""
#define ANSI_CLEAR_CONSOLE ""
#define ANSI_CURSOR_HIDE ""
#define ANSI_CURSOR_SHOW ""
#define ANSI_COLOR_REVERSE ""
#define ANSI_COLOR_RESET ""

#define debug(...) do { } while (0)
#define log_err(...) fprintf(stderr, __VA_ARGS__)
#define U_BOOT_CMD(...)

struct cmd_tbl {
	int unused;
};

struct bootmenu_entry;

struct bootmenu_data {
	int delay;
	int active;
	int count;
	struct bootmenu_entry *first;
};

enum bootmenu_key {
	KEY_NONE = 0,
	KEY_UP,
	KEY_DOWN,
	KEY_SELECT,
	KEY_QUIT,
	KEY_PLUS,
	KEY_MINUS,
	KEY_SPACE,
};

struct list_head {
	struct list_head *next;
	struct list_head *prev;
};

#define container_of(pointer, type, member) \
	((type *)((char *)(pointer) - offsetof(type, member)))
#define list_entry(pointer, type, member) \
	container_of(pointer, type, member)
#define list_for_each_safe(position, following, head) \
	for (position = (head)->next, following = position->next; \
	     position != (head); \
	     position = following, following = position->next)

static void INIT_LIST_HEAD(struct list_head *head)
{
	head->next = head;
	head->prev = head;
}

static void list_add_tail(struct list_head *entry, struct list_head *head)
{
	entry->prev = head->prev;
	entry->next = head;
	head->prev->next = entry;
	head->prev = entry;
}

struct seam_fixture {
	const unsigned char *input;
	unsigned int input_count;
	unsigned int input_index;
	unsigned int efi_init_count;
	unsigned int menu_create_count;
	unsigned int menu_item_count;
	unsigned int menu_default_count;
	unsigned int menu_choice_count;
	unsigned int input_poll_count;
	unsigned int schedule_count;
	unsigned int delay_10ms_count;
	unsigned int literal_bootmenu_count;
	unsigned int automatic_count;
	unsigned int sd_count;
	unsigned int emmc_count;
	unsigned int console_count;
	int oracle_failed;
	char titles[4][32];
	char commands[4][40];
};

static struct seam_fixture seam;
static const int efi_global_variable_guid;

static const char *const seam_titles[] = {
	"Automatic boot",
	"Boot Linux from SD",
	"Boot Linux from eMMC",
	"U-Boot console",
};

static const char *const seam_commands[] = {
	"bm201_boot_source auto",
	"bm201_boot_source sd",
	"bm201_boot_source emmc",
	"",
};

static int do_bootmenu(struct cmd_tbl *cmdtp, int flag, int argc,
		       char *const argv[]);

static char *env_get(const char *name)
{
	if (!strcmp(name, "bootmenu_0"))
		return "Automatic boot=bm201_boot_source auto";
	if (!strcmp(name, "bootmenu_1"))
		return "Boot Linux from SD=bm201_boot_source sd";
	if (!strcmp(name, "bootmenu_2"))
		return "Boot Linux from eMMC=bm201_boot_source emmc";
	if (!strcmp(name, "bootmenu_default"))
		return "0";
	return NULL;
}

static long simple_strtol(const char *text, char **end, unsigned int base)
{
	return strtol(text, end, (int)base);
}

static int run_command(const char *command, int flag)
{
	(void)flag;
	if (!strcmp(command, "bootmenu 3")) {
		char *argv[] = { "bootmenu", "3", NULL };

		seam.literal_bootmenu_count++;
		return do_bootmenu(NULL, 0, 2, argv);
	}
	if (!strcmp(command, seam_commands[0])) {
		seam.automatic_count++;
		return 0;
	}
	if (!strcmp(command, seam_commands[1])) {
		seam.sd_count++;
		return 0;
	}
	if (!strcmp(command, seam_commands[2])) {
		seam.emmc_count++;
		return 0;
	}
	if (!command[0]) {
		seam.console_count++;
		return 0;
	}
	assert(!"unexpected production bootmenu command");
	return -1;
}

static efi_status_t efi_init_obj_list(void)
{
	seam.efi_init_count++;
	return EFI_SUCCESS;
}

static efi_status_t efi_get_variable_int(const void *name, const void *guid,
					 unsigned int *attributes,
					 efi_uintn_t *size, void *data,
					 void *time)
{
	(void)name;
	(void)guid;
	(void)attributes;
	(void)size;
	(void)data;
	(void)time;
	return EFI_NOT_FOUND;
}

static efi_status_t efi_set_variable_int(const void *name, const void *guid,
					 unsigned int attributes,
					 efi_uintn_t size, const void *data,
					 bool ro_check)
{
	(void)name;
	(void)guid;
	(void)attributes;
	(void)size;
	(void)data;
	(void)ro_check;
	assert(!"unexpected EFI variable write");
	return EFI_NOT_FOUND;
}

static int cli_readline_into_buffer(const char *prompt, char *buffer,
				    int timeout)
{
	(void)prompt;
	(void)buffer;
	(void)timeout;
	assert(!"generic readline bypassed the bootmenu input loop");
	return -1;
}

static int tstc(void)
{
	seam.input_poll_count++;
	return seam.input_index < seam.input_count;
}

static int bm201_test_getchar(void)
{
	assert(seam.input_index < seam.input_count);
	return seam.input[seam.input_index++];
}

static void schedule(void)
{
	seam.schedule_count++;
}

static void mdelay(unsigned long milliseconds)
{
	assert(milliseconds == 10);
	seam.delay_10ms_count++;
}

static int bm201_test_printf(const char *format, ...)
{
	(void)format;
	return 0;
}

static int bm201_test_puts(const char *text)
{
	(void)text;
	return 0;
}

static int bm201_test_putc(int character)
{
	return character;
}

#define printf(...) bm201_test_printf(__VA_ARGS__)
#define puts(text) bm201_test_puts(text)
#define putc(character) bm201_test_putc(character)
#define getchar() bm201_test_getchar()

/*
 * Compile the pinned production menu implementation, then wrap only its
 * public boundary calls so the oracle can record ordering and exact entries.
 */
#define menu_create bm201_production_menu_create
#define menu_item_add bm201_production_menu_item_add
#define menu_default_set bm201_production_menu_default_set
#define menu_get_choice bm201_production_menu_get_choice
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#include "menu.c"
#pragma GCC diagnostic pop
#undef menu_create
#undef menu_item_add
#undef menu_default_set
#undef menu_get_choice

static struct menu *menu_create(char *title, int timeout, int prompt,
				void (*display_statusline)(struct menu *),
				void (*item_data_print)(void *),
				char *(*item_choice)(void *),
				void *item_choice_data)
{
	seam.menu_create_count++;
	if (seam.efi_init_count) {
		fputs("FAIL: bootmenu entered EFI initialization before menu creation\n",
		      stderr);
		seam.oracle_failed = 1;
		return NULL;
	}
	assert(timeout == 3);
	assert(prompt == 1);
	return bm201_production_menu_create(title, timeout, prompt,
					    display_statusline,
					    item_data_print, item_choice,
					    item_choice_data);
}

static int menu_item_add(struct menu *menu, char *key, void *data);

static int menu_default_set(struct menu *menu, char *key)
{
	assert(!strcmp(key, "0"));
	assert(menu->item_cnt == 4);
	seam.menu_default_count++;
	return bm201_production_menu_default_set(menu, key);
}

static int menu_get_choice(struct menu *menu, void **choice)
{
	seam.menu_choice_count++;
	return bm201_production_menu_get_choice(menu, choice);
}

/*
 * GCC's host-only range analysis does not infer bootmenu.c's MAX_COUNT guard
 * for its two sprintf(entry->key, "%d", i) calls. Keep the diagnostic
 * exception strictly around this test inclusion; the production file is not
 * changed and the surrounding build retains -Werror for every other warning.
 */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wformat-overflow"
#include "bootmenu.c"
#pragma GCC diagnostic pop

#undef printf
#undef puts
#undef putc
#undef getchar

static int menu_item_add(struct menu *menu, char *key, void *data)
{
	struct bootmenu_entry *entry = data;
	unsigned int index = seam.menu_item_count;

	assert(index < 4);
	assert((unsigned int)(key[0] - '0') == index && key[1] == '\0');
	assert(entry->num == index);
	assert(!strcmp(entry->title, seam_titles[index]));
	assert(!strcmp(entry->command, seam_commands[index]));
	snprintf(seam.titles[index], sizeof(seam.titles[index]), "%s",
		 entry->title);
	snprintf(seam.commands[index], sizeof(seam.commands[index]), "%s",
		 entry->command);
	seam.menu_item_count++;
	return bm201_production_menu_item_add(menu, key, data);
}

static int run_seam_case(const unsigned char *input,
			 unsigned int input_count)
{
	unsigned int index;

	memset(&seam, 0, sizeof(seam));
	seam.input = input;
	seam.input_count = input_count;
	assert(run_command("bootmenu 3", 0) == 0);
	if (seam.oracle_failed)
		return 1;
	assert(seam.efi_init_count == 0);
	assert(seam.menu_create_count == 1);
	assert(seam.menu_item_count == 4);
	assert(seam.menu_default_count == 1);
	assert(seam.menu_choice_count == 1);
	assert(seam.literal_bootmenu_count == 1);
	assert(seam.input_index == seam.input_count);
	for (index = 0; index < 4; index++) {
		assert(!strcmp(seam.titles[index], seam_titles[index]));
		assert(!strcmp(seam.commands[index], seam_commands[index]));
	}
	return 0;
}

int main(void)
{
	static const unsigned char serial_sd[] = { '\e', '[', 'B', '\r' };
	static const unsigned char usbkbd_emmc[] = {
		'\e', '[', 'B', '\e', '[', 'B', '\r'
	};
	static const unsigned char escape[] = { '\e' };
	static const unsigned char ctrl_c[] = { 0x3 };

	assert(BM201_CONFIG_EFI_LOADER == 1);
	assert(BM201_CONFIG_CMD_BOOTEFI == 1);
	if (run_seam_case(NULL, 0))
		return 1;
	assert(BM201_CONFIG_CMD_BOOTEFI_BOOTMGR == 0);
	assert(seam.input_poll_count == 300);
	assert(seam.schedule_count == 300);
	assert(seam.delay_10ms_count == 300);
	assert(seam.automatic_count == 1);

	assert(!run_seam_case(serial_sd, sizeof(serial_sd)));
	assert(seam.sd_count == 1);

	assert(!run_seam_case(usbkbd_emmc, sizeof(usbkbd_emmc)));
	assert(seam.emmc_count == 1);

	assert(!run_seam_case(escape, sizeof(escape)));
	assert(seam.console_count == 1);
	assert(seam.automatic_count == 0);
	assert(seam.sd_count == 0);
	assert(seam.emmc_count == 0);

	assert(!run_seam_case(ctrl_c, sizeof(ctrl_c)));
	assert(seam.console_count == 1);
	assert(seam.automatic_count == 0);
	assert(seam.sd_count == 0);
	assert(seam.emmc_count == 0);

	puts("BM201 production bootmenu/menu autoboot contract tests passed");
	return 0;
}

#else

#define _GNU_SOURCE

#include <assert.h>
#include <ctype.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARRAY_SIZE(array) (sizeof(array) / sizeof((array)[0]))

/*
 * Include the production cfgload command so the legacy no-argument search is
 * exercised without copying its candidate table into test-side policy code.
 * The contract Docker stages put empty U-Boot headers ahead of the real tree;
 * these definitions provide only the host fakes needed by cfgload.c.
 */
struct cmd_tbl {
	int unused;
};
typedef struct cmd_tbl cmd_tbl_t;
typedef unsigned long ulong;

typedef long long test_loff_t;
#define loff_t test_loff_t

#define CONFIG_SYS_LOAD_ADDR ((unsigned long)legacy_load_buffer)
#define FS_TYPE_ANY 0
#define SZ_64K (64 * 1024)
#define CMD_RET_SUCCESS 0
#define CMD_RET_FAILURE 1
#define CMD_RET_USAGE 2

#define U_BOOT_CMD(name, maxargs, repeatable, command, usage, help) \
	static int (*const keep_##name)(cmd_tbl_t *, int, int, \
					   char *const []) __attribute__((unused)) = \
		command; \
	static const char *const keep_help_##name __attribute__((unused)) = help

struct legacy_candidate {
	char partition[8];
	char path[32];
};

struct legacy_fixture {
	int nonempty_at;
	unsigned int load_count;
	struct legacy_candidate loads[8];
	unsigned long filesize;
	unsigned int script_count;
	unsigned int override_clear_count;
	int override_present;
	int require_override_absent;
	const char *script;
};

static unsigned char legacy_load_buffer[SZ_64K + 1];
static struct legacy_fixture legacy;

enum host_command_mode {
	HOST_COMMAND_CFGLOAD = 0,
	HOST_COMMAND_VIDEO_RECOVERY,
};

enum video_operation {
	VIDEO_OP_ROUTE_STDOUT,
	VIDEO_OP_ROUTE_STDERR,
	VIDEO_OP_INSTALLER,
	VIDEO_OP_CFGLOAD_SD,
	VIDEO_OP_CFGLOAD_EMMC,
	VIDEO_OP_RESTORE_STDOUT_VIDEO,
	VIDEO_OP_RESTORE_STDERR_VIDEO,
	VIDEO_OP_RESTORE_STDOUT_SERIAL,
	VIDEO_OP_RESTORE_STDERR_SERIAL,
	VIDEO_OP_CLEAR,
	VIDEO_OP_CURSOR_SHOW,
	VIDEO_OP_DIAGNOSTIC,
};

struct parser_fixture {
	unsigned long expected_length;
	unsigned long parsed_length;
	const char *expected_prefix;
	unsigned int invocation_count;
	int execute_rc;
	int length_mismatch;
	int prefix_mismatch;
};

struct production_file {
	const char *data;
	unsigned long size;
	int exists;
	int exists_rc;
	int size_rc;
	int read_rc;
};

struct production_fat_fixture {
	int enabled;
	int close_after_operation;
	int select_rc;
	char locked_partition[8];
	char active_partition[8];
	struct production_file boot_ini;
	struct production_file image;
	unsigned int select_count;
	unsigned int close_count;
	unsigned int exists_count;
	unsigned int size_count;
	unsigned int read_count;
	unsigned int context_loss_count;
	unsigned int unexpected_partition_count;
};

struct video_fixture {
	const char *console_out;
	int vidconsole_available;
	int installer_rc;
	int cfgload_rc;
	int clear_rc;
	enum video_operation operations[24];
	unsigned int operation_count;
	unsigned int installer_count;
	unsigned int cfgload_count;
	unsigned int clear_count;
	unsigned int cursor_count;
	unsigned int diagnostic_count;
	unsigned int storage_write_count;
	unsigned int persistent_write_count;
};

struct stdio_dev {
	int unused;
};

static enum host_command_mode command_mode;
static struct parser_fixture parser;
static struct production_fat_fixture production_fat;
static struct video_fixture video_recovery;
static struct stdio_dev video_console_device;

int do_script(cmd_tbl_t *cmdtp, int flag, int argc, char *const argv[]);

static void video_record(enum video_operation operation)
{
	assert(video_recovery.operation_count <
	       ARRAY_SIZE(video_recovery.operations));
	video_recovery.operations[video_recovery.operation_count++] = operation;
}

static char *env_get(const char *name)
{
	if (command_mode == HOST_COMMAND_VIDEO_RECOVERY &&
	    !strcmp(name, "bm201_console_out"))
		return (char *)video_recovery.console_out;
	(void)name;
	return NULL;
}

static int env_set(const char *name, const char *value)
{
	if (command_mode == HOST_COMMAND_VIDEO_RECOVERY) {
		if (!strcmp(name, "stdout") && !strcmp(value, "serial")) {
			video_record(video_recovery.cfgload_count ?
				     VIDEO_OP_RESTORE_STDOUT_SERIAL :
				     VIDEO_OP_ROUTE_STDOUT);
			return 0;
		}
		if (!strcmp(name, "stderr") && !strcmp(value, "serial")) {
			video_record(video_recovery.cfgload_count ?
				     VIDEO_OP_RESTORE_STDERR_SERIAL :
				     VIDEO_OP_ROUTE_STDERR);
			return 0;
		}
		if (!strcmp(name, "stdout") &&
		    !strcmp(value, "serial,vidconsole")) {
			video_record(VIDEO_OP_RESTORE_STDOUT_VIDEO);
			return 0;
		}
		if (!strcmp(name, "stderr") &&
		    !strcmp(value, "serial,vidconsole")) {
			video_record(VIDEO_OP_RESTORE_STDERR_VIDEO);
			return 0;
		}
		assert(!"unexpected production recovery environment mutation");
	}

	if (!strcmp(name, "filesize")) {
		legacy.filesize = value ? strtoul(value, NULL, 16) : 0;
		return 0;
	}
	if (!strcmp(name, "cfgload_devnum")) {
		if (value) {
			legacy.override_present = 1;
		} else {
			legacy.override_present = 0;
			legacy.override_clear_count++;
		}
		return 0;
	}

	return 0;
}

static unsigned long env_get_ulong(const char *name, int base,
				   unsigned long default_value)
{
	(void)base;
	if (!strcmp(name, "filesize"))
		return legacy.filesize;
	return default_value;
}

static unsigned long simple_strtoul(const char *text, char **end, int base)
{
	if (!text)
		return 0;
	return strtoul(text, end, base);
}

static int run_command(const char *command, int flag)
{
	struct legacy_candidate *candidate;
	char command_copy[128];
	char *script_argv[6];
	char *saveptr;
	char *token;
	unsigned int index;
	int script_argc;
	int matched;

	(void)flag;
	if (command_mode == HOST_COMMAND_VIDEO_RECOVERY) {
		if (!strcmp(command, "bm201_emmc_update")) {
			video_record(VIDEO_OP_INSTALLER);
			video_recovery.installer_count++;
			return video_recovery.installer_rc;
		}
		if (!strcmp(command, "cfgload sd")) {
			video_record(VIDEO_OP_CFGLOAD_SD);
			video_recovery.cfgload_count++;
			return video_recovery.cfgload_rc;
		}
		if (!strcmp(command, "cfgload emmc")) {
			video_record(VIDEO_OP_CFGLOAD_EMMC);
			video_recovery.cfgload_count++;
			return video_recovery.cfgload_rc;
		}
		if (!strcmp(command, "cls")) {
			video_record(VIDEO_OP_CLEAR);
			video_recovery.clear_count++;
			return video_recovery.clear_rc;
		}
		if (strstr(command, "saveenv"))
			video_recovery.persistent_write_count++;
		if (strstr(command, "mmc write") || strstr(command, "fatwrite"))
			video_recovery.storage_write_count++;
		assert(!"unexpected production recovery command");
		return -1;
	}

	if (!strncmp(command, "load mmc ", strlen("load mmc "))) {
		assert(legacy.load_count < ARRAY_SIZE(legacy.loads));
		if (legacy.require_override_absent)
			assert(!legacy.override_present);
		candidate = &legacy.loads[legacy.load_count];
		matched = sscanf(command, "load mmc %7s %*s %31s",
				 candidate->partition, candidate->path);
		assert(matched == 2);
		index = legacy.load_count++;
		if ((int)index == legacy.nonempty_at) {
			legacy.filesize = strlen(legacy.script);
			memcpy(legacy_load_buffer, legacy.script, legacy.filesize);
		}
		return 0;
	}
	if (!strncmp(command, "script ", strlen("script "))) {
		legacy.script_count++;
		assert(strlen(command) < sizeof(command_copy));
		strcpy(command_copy, command);
		script_argc = 0;
		for (token = strtok_r(command_copy, " ", &saveptr); token;
		     token = strtok_r(NULL, " ", &saveptr)) {
			assert(script_argc < (int)ARRAY_SIZE(script_argv) - 1);
			script_argv[script_argc++] = token;
		}
		script_argv[script_argc] = NULL;
		return do_script(NULL, 0, script_argc, script_argv);
	}

	assert(!"unexpected production cfgload command");
	return -1;
}

static int fs_set_blk_dev(const char *interface, const char *partition,
			  int fs_type)
{
	if (!production_fat.enabled)
		return -1;
	assert(!strcmp(interface, "mmc"));
	assert(fs_type == FS_TYPE_ANY);
	production_fat.select_count++;
	if (strcmp(partition, production_fat.locked_partition))
		production_fat.unexpected_partition_count++;
	if (production_fat.select_rc)
		return production_fat.select_rc;
	assert(strlen(partition) < sizeof(production_fat.active_partition));
	strcpy(production_fat.active_partition, partition);
	return 0;
}

static void fs_close(void)
{
	production_fat.close_count++;
	production_fat.active_partition[0] = '\0';
}

static struct production_file *production_file_for_path(const char *path)
{
	static struct production_file missing;

	if (!strcmp(path, "/boot.ini"))
		return &production_fat.boot_ini;
	if (!strcmp(path, "/Image"))
		return &production_fat.image;
	assert(!strcmp(path, "/boot/boot.ini"));
	memset(&missing, 0, sizeof(missing));
	return &missing;
}

static int production_fat_context_ready(void)
{
	if (production_fat.active_partition[0])
		return 1;
	production_fat.context_loss_count++;
	return 0;
}

static int fs_exists(const char *path)
{
	struct production_file *file;
	int result;

	production_fat.exists_count++;
	if (!production_fat_context_ready()) {
		if (production_fat.close_after_operation)
			fs_close();
		return -1;
	}
	file = production_file_for_path(path);
	result = file->exists_rc ? file->exists_rc : file->exists;
	if (production_fat.close_after_operation)
		fs_close();
	return result;
}

static int fs_size(const char *path, loff_t *size)
{
	struct production_file *file;
	int result;

	production_fat.size_count++;
	if (!production_fat_context_ready()) {
		if (production_fat.close_after_operation)
			fs_close();
		return -1;
	}
	file = production_file_for_path(path);
	*size = (loff_t)file->size;
	result = file->size_rc;
	if (production_fat.close_after_operation)
		fs_close();
	return result;
}

static unsigned long map_to_sysmem(const void *buffer)
{
	return (unsigned long)buffer;
}

static int fs_read(const char *path, unsigned long address, loff_t offset,
		   loff_t length, loff_t *actual)
{
	struct production_file *file;
	int result;

	production_fat.read_count++;
	if (!production_fat_context_ready()) {
		if (production_fat.close_after_operation)
			fs_close();
		return -1;
	}
	file = production_file_for_path(path);
	assert(offset == 0);
	assert(length >= 0 && (unsigned long)length == file->size);
	result = file->read_rc;
	if (!result) {
		memcpy((void *)(uintptr_t)address, file->data, file->size);
		*actual = (loff_t)file->size;
	}
	if (production_fat.close_after_operation)
		fs_close();
	return result;
}

static void *map_sysmem(ulong address, unsigned long length)
{
	(void)length;
	return (void *)(uintptr_t)address;
}

static int run_command_list(const char *data, int length, int flag)
{
	(void)flag;
	assert(length >= 0);
	parser.parsed_length = (unsigned long)length;
	parser.invocation_count++;
	if (parser.expected_length &&
	    parser.parsed_length != parser.expected_length) {
		parser.length_mismatch = 1;
		return -1;
	}
	if (parser.expected_prefix &&
	    strncmp(data, parser.expected_prefix,
		    strlen(parser.expected_prefix))) {
		parser.prefix_mismatch = 1;
		return -1;
	}
	return parser.execute_rc;
}

static struct stdio_dev *
stdio_get_by_name(const char *name) __attribute__((unused));

static struct stdio_dev *stdio_get_by_name(const char *name)
{
	assert(!strcmp(name, "vidconsole"));
	return video_recovery.vidconsole_available ?
		&video_console_device : NULL;
}

static int bm201_video_printf(const char *format, ...)
{
	(void)format;
	video_record(VIDEO_OP_DIAGNOSTIC);
	video_recovery.diagnostic_count++;
	return 0;
}

static int bm201_video_puts(const char *text) __attribute__((unused));

static int bm201_video_puts(const char *text)
{
	assert(!strcmp(text, "\033[?25h"));
	video_record(VIDEO_OP_CURSOR_SHOW);
	video_recovery.cursor_count++;
	return 0;
}

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#include "cfgload.c"
#pragma GCC diagnostic pop

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#include "script.c"
#pragma GCC diagnostic pop

#define ANSI_CURSOR_SHOW "\033[?25h"
#define printf(...) bm201_video_printf(__VA_ARGS__)
#define puts(text) bm201_video_puts(text)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#include "boot_source.c"
#pragma GCC diagnostic pop
#undef puts
#undef printf

static const char legacy_script[] =
	"ODROIDC5-UBOOT-CONFIG\n"
	"setenv bootargs legacy-root\n";

static const struct legacy_candidate expected_legacy_candidates[] = {
	{ "0:1", "/boot.ini" },
	{ "0:1", "/boot/boot.ini" },
	{ "1:1", "/boot.ini" },
	{ "1:1", "/boot/boot.ini" },
	{ "1:4", "/boot/boot.ini" },
};

static void reset_legacy(int nonempty_at)
{
	memset(&legacy, 0, sizeof(legacy));
	memset(legacy_load_buffer, 0, sizeof(legacy_load_buffer));
	legacy.nonempty_at = nonempty_at;
	legacy.script = legacy_script;
}

static char *make_boot_ini(unsigned long body_size,
			   unsigned long *file_size)
{
	unsigned long magic_size = strlen(CFGLOAD_BOOTINI_MAGIC);
	char *script;

	assert(body_size > 0);
	*file_size = magic_size + 1 + body_size;
	script = malloc(*file_size + 1);
	assert(script != NULL);
	memcpy(script, CFGLOAD_BOOTINI_MAGIC, magic_size);
	script[magic_size] = '\n';
	memset(script + magic_size + 1, 'x', body_size);
	script[magic_size + 1] = '#';
	script[*file_size] = '\0';
	return script;
}

static void setup_production_fat(const char *boot_ini,
				 unsigned long boot_ini_size,
				 int close_after_operation)
{
	memset(&production_fat, 0, sizeof(production_fat));
	production_fat.enabled = 1;
	production_fat.close_after_operation = close_after_operation;
	strcpy(production_fat.locked_partition, "0:1");
	production_fat.boot_ini.data = boot_ini;
	production_fat.boot_ini.size = boot_ini_size;
	production_fat.boot_ini.exists = 1;
	production_fat.image.size = 4096;
	production_fat.image.exists = 1;
}

static int invoke_strict_sd_cfgload(void)
{
	char *argv[] = { "cfgload", "sd", NULL };

	return do_load_cfgload(NULL, 0, 2, argv);
}

static int invoke_legacy_cfgload(void)
{
	char *argv[] = { "cfgload", NULL };

	return do_load_cfgload(NULL, 0, 1, argv);
}

static int run_fat_device_oracle(void)
{
	unsigned long boot_ini_size;
	char *boot_ini = make_boot_ini(9, &boot_ini_size);
	int status;

	command_mode = HOST_COMMAND_CFGLOAD;
	memset(&parser, 0, sizeof(parser));
	parser.expected_length = 9;
	setup_production_fat(boot_ini, boot_ini_size, 1);
	status = invoke_strict_sd_cfgload();
	if (status != CMD_RET_SUCCESS) {
		if (production_fat.context_loss_count) {
			fprintf(stderr,
				"FAIL: cfgload lost selected FAT device after fs_exists/fs_close before fs_size\n");
		} else {
			fprintf(stderr,
				"FAIL: cfgload could not inspect and read the selected FAT source\n");
		}
		free(boot_ini);
		return 1;
	}

	assert(production_fat.context_loss_count == 0);
	assert(production_fat.unexpected_partition_count == 0);
	assert(production_fat.select_count == 6);
	assert(production_fat.close_count == 5);
	assert(production_fat.exists_count == 2);
	assert(production_fat.size_count == 2);
	assert(production_fat.read_count == 1);
	assert(parser.invocation_count == 1);
	assert(parser.parsed_length == 9);
	free(boot_ini);
	puts("PASS: cfgload reselected mmc 0:1 across fs_exists/fs_close, fs_size, and fs_read");
	return 0;
}

static int run_script_length_oracle(void)
{
	const unsigned long exact_length = 0x1559;
	const char first_command[] = "setenv devtype mmc\n";
	unsigned long boot_ini_size;
	char *boot_ini = make_boot_ini(exact_length, &boot_ini_size);
	char *body = boot_ini + strlen(CFGLOAD_BOOTINI_MAGIC) + 1;
	int status;

	memcpy(body, first_command, sizeof(first_command) - 1);
	memset(&parser, 0, sizeof(parser));
	parser.expected_prefix = first_command;
	if (!script((ulong)(uintptr_t)body, exact_length, 0, 1) ||
	    !parser.prefix_mismatch) {
		fprintf(stderr,
			"FAIL: baseline script header mode did not skip the first executable boot.ini line\n");
		free(boot_ini);
		return 1;
	}

	command_mode = HOST_COMMAND_CFGLOAD;
	memset(&parser, 0, sizeof(parser));
	parser.expected_length = exact_length;
	parser.expected_prefix = first_command;
	setup_production_fat(boot_ini, boot_ini_size, 0);
	status = invoke_strict_sd_cfgload();
	if (parser.length_mismatch) {
		fprintf(stderr,
			"FAIL: strict cfgload loaded 0x1559 bytes but pinned script parser received 0x%lx\n",
			parser.parsed_length);
		free(boot_ini);
		return 1;
	}
	if (parser.prefix_mismatch) {
		fprintf(stderr,
			"FAIL: strict cfgload skipped the first executable boot.ini line\n");
		free(boot_ini);
		return 1;
	}
	if (status != CMD_RET_SUCCESS || parser.invocation_count != 1) {
		fprintf(stderr,
			"FAIL: strict cfgload did not preserve the pinned script result\n");
		free(boot_ini);
		return 1;
	}

	reset_legacy(0);
	legacy.script = boot_ini;
	memset(&parser, 0, sizeof(parser));
	parser.expected_length = exact_length;
	parser.expected_prefix = first_command;
	status = invoke_legacy_cfgload();
	if (parser.length_mismatch) {
		fprintf(stderr,
			"FAIL: legacy cfgload loaded 0x1559 bytes but pinned script parser received 0x%lx\n",
			parser.parsed_length);
		free(boot_ini);
		return 1;
	}
	if (parser.prefix_mismatch) {
		fprintf(stderr,
			"FAIL: legacy cfgload skipped the first executable boot.ini line\n");
		free(boot_ini);
		return 1;
	}
	if (status != CMD_RET_SUCCESS || parser.invocation_count != 1) {
		fprintf(stderr,
			"FAIL: legacy cfgload did not preserve the pinned script result\n");
		free(boot_ini);
		return 1;
	}

	memset(&parser, 0, sizeof(parser));
	parser.expected_length = exact_length;
	parser.expected_prefix = first_command;
	parser.execute_rc = 19;
	setup_production_fat(boot_ini, boot_ini_size, 0);
	assert(invoke_strict_sd_cfgload() == CMD_RET_FAILURE);

	reset_legacy(0);
	legacy.script = boot_ini;
	memset(&parser, 0, sizeof(parser));
	parser.expected_length = exact_length;
	parser.expected_prefix = first_command;
	parser.execute_rc = 19;
	assert(invoke_legacy_cfgload() == CMD_RET_FAILURE);

	memset(&parser, 0, sizeof(parser));
	free(boot_ini);
	puts("PASS: strict and legacy cfgload preserved the first command and passed exactly 0x1559 bytes through pinned do_script");
	return 0;
}

static void reset_video_recovery(int vidconsole_available, int clear_rc)
{
	memset(&video_recovery, 0, sizeof(video_recovery));
	command_mode = HOST_COMMAND_VIDEO_RECOVERY;
	video_recovery.console_out = "serial,vidconsole";
	video_recovery.vidconsole_available = vidconsole_available;
	video_recovery.cfgload_rc = 7;
	video_recovery.clear_rc = clear_rc;
}

static void assert_video_operations(const enum video_operation *expected,
				    unsigned int expected_count)
{
	unsigned int index;

	assert(video_recovery.operation_count == expected_count);
	for (index = 0; index < expected_count; index++)
		assert(video_recovery.operations[index] == expected[index]);
}

#define EXPECT_VIDEO_OPERATIONS(...) \
	do { \
		const enum video_operation expected[] = { __VA_ARGS__ }; \
		assert_video_operations(expected, ARRAY_SIZE(expected)); \
	} while (0)

static int invoke_production_boot_source(void)
{
	char *argv[] = { "bm201_boot_source", "sd", NULL };

	return do_bm201_boot_source(NULL, 0, 2, argv);
}

static int run_video_recovery_oracle(void)
{
	reset_video_recovery(1, 0);
	assert(invoke_production_boot_source() == CMD_RET_FAILURE);
	if (!video_recovery.clear_count || !video_recovery.cursor_count) {
		fprintf(stderr,
			"FAIL: cfgload recovery restored routing without clearing vidconsole and showing its cursor\n");
		return 1;
	}
	EXPECT_VIDEO_OPERATIONS(VIDEO_OP_ROUTE_STDOUT, VIDEO_OP_ROUTE_STDERR,
				VIDEO_OP_INSTALLER, VIDEO_OP_CFGLOAD_SD,
				VIDEO_OP_RESTORE_STDOUT_VIDEO,
				VIDEO_OP_RESTORE_STDERR_VIDEO,
				VIDEO_OP_CLEAR, VIDEO_OP_CURSOR_SHOW,
				VIDEO_OP_DIAGNOSTIC);
	assert(video_recovery.installer_count == 1);
	assert(video_recovery.cfgload_count == 1);
	assert(video_recovery.storage_write_count == 0);
	assert(video_recovery.persistent_write_count == 0);

	reset_video_recovery(1, 11);
	assert(invoke_production_boot_source() == CMD_RET_FAILURE);
	EXPECT_VIDEO_OPERATIONS(VIDEO_OP_ROUTE_STDOUT, VIDEO_OP_ROUTE_STDERR,
				VIDEO_OP_INSTALLER, VIDEO_OP_CFGLOAD_SD,
				VIDEO_OP_RESTORE_STDOUT_VIDEO,
				VIDEO_OP_RESTORE_STDERR_VIDEO,
				VIDEO_OP_CLEAR, VIDEO_OP_CURSOR_SHOW,
				VIDEO_OP_DIAGNOSTIC, VIDEO_OP_DIAGNOSTIC);
	assert(video_recovery.installer_count == 1);
	assert(video_recovery.cfgload_count == 1);
	assert(video_recovery.storage_write_count == 0);
	assert(video_recovery.persistent_write_count == 0);

	reset_video_recovery(0, 0);
	assert(invoke_production_boot_source() == CMD_RET_FAILURE);
	EXPECT_VIDEO_OPERATIONS(VIDEO_OP_ROUTE_STDOUT, VIDEO_OP_ROUTE_STDERR,
				VIDEO_OP_INSTALLER, VIDEO_OP_CFGLOAD_SD,
				VIDEO_OP_RESTORE_STDOUT_SERIAL,
				VIDEO_OP_RESTORE_STDERR_SERIAL,
				VIDEO_OP_CURSOR_SHOW, VIDEO_OP_DIAGNOSTIC);
	assert(video_recovery.clear_count == 0);
	assert(video_recovery.cursor_count == 1);
	assert(video_recovery.storage_write_count == 0);
	assert(video_recovery.persistent_write_count == 0);

	command_mode = HOST_COMMAND_CFGLOAD;
	puts("PASS: returned cfgload failure restored, cleared, and exposed recovery before diagnostics with zero writes");
	return 0;
}

static void assert_legacy_prefix(unsigned int count)
{
	unsigned int index;

	assert(legacy.load_count == count);
	for (index = 0; index < count; index++) {
		assert(!strcmp(legacy.loads[index].partition,
			       expected_legacy_candidates[index].partition));
		assert(!strcmp(legacy.loads[index].path,
			       expected_legacy_candidates[index].path));
	}
}

static void test_legacy_cfgload_order(void)
{
	char *body;

	reset_legacy(-1);
	body = read_cfgload();
	assert(body == NULL);
	assert_legacy_prefix(ARRAY_SIZE(expected_legacy_candidates));

	reset_legacy(2);
	body = read_cfgload();
	assert(body != NULL);
	assert_legacy_prefix(3);
	assert(!strncmp(body, "setenv bootargs legacy-root\n",
			strlen("setenv bootargs legacy-root\n")));
	free(body);
}

static void test_legacy_cfgload_clears_override(void)
{
	char *argv[] = { "cfgload", NULL };

	reset_legacy(0);
	legacy.override_present = 1;
	legacy.require_override_absent = 1;
	assert(do_load_cfgload(NULL, 0, 1, argv) == CMD_RET_SUCCESS);
	assert_legacy_prefix(1);
	assert(legacy.override_clear_count == 1);
	assert(!legacy.override_present);
	assert(legacy.script_count == 1);
}

enum cfg_operation {
	CFG_OP_CLEAR,
	CFG_OP_SELECT,
	CFG_OP_SCRIPT0_SIZE,
	CFG_OP_SCRIPT1_SIZE,
	CFG_OP_READ,
	CFG_OP_IMAGE_SIZE,
	CFG_OP_SET_OVERRIDE,
	CFG_OP_EXECUTE,
	CFG_OP_RELEASE,
	CFG_OP_DIAGNOSE,
};

struct cfg_fixture {
	enum cfgload_file_status script_status[2];
	unsigned long script_size[2];
	const char *script_data[2];
	enum cfgload_file_status image_status;
	unsigned long image_size;
	int select_rc;
	int read_rc;
	int allocate_fails;
	int override_set_rc;
	int execute_rc;

	enum cfg_operation operations[32];
	unsigned int operation_count;
	char selected_partition[8];
	unsigned int select_count;
	unsigned int execute_count;
	unsigned int release_count;
	unsigned int clear_count;
	unsigned int set_count;
	int override_present;
	char override[2];
	char executed_override[2];
	char executed[1024];
	unsigned long executed_size;
	enum cfgload_source_error diagnosed_error;
	unsigned int diagnose_count;
};

static const char strict_script[] =
	"ODROIDC5-UBOOT-CONFIG\n"
	"setenv bootargs \"console=ttyS0 root=PARTUUID=708161c1-02 rw\"\n"
	"booti ${loadaddr_kernel} - ${dtb_mem_addr}\n";

static const char strict_body[] =
	"setenv bootargs \"console=ttyS0 root=PARTUUID=708161c1-02 rw\"\n"
	"booti ${loadaddr_kernel} - ${dtb_mem_addr}\n";

static const struct cfgload_source sd_source = {
	.name = "SD",
	.partition = "0:1",
	.devnum = "0",
};

static const struct cfgload_source emmc_source = {
	.name = "eMMC",
	.partition = "1:1",
	.devnum = "1",
};

static void cfg_record(struct cfg_fixture *fixture,
		       enum cfg_operation operation)
{
	assert(fixture->operation_count < ARRAY_SIZE(fixture->operations));
	fixture->operations[fixture->operation_count++] = operation;
}

static int cfg_select(void *opaque, const char *partition)
{
	struct cfg_fixture *fixture = opaque;

	cfg_record(fixture, CFG_OP_SELECT);
	fixture->select_count++;
	assert(strlen(partition) < sizeof(fixture->selected_partition));
	strcpy(fixture->selected_partition, partition);
	return fixture->select_rc;
}

static enum cfgload_file_status
cfg_file_size(void *opaque, const char *path, unsigned long *size)
{
	struct cfg_fixture *fixture = opaque;
	unsigned int index;

	if (!strcmp(path, "/Image")) {
		cfg_record(fixture, CFG_OP_IMAGE_SIZE);
		*size = fixture->image_size;
		return fixture->image_status;
	}

	index = !strcmp(path, "/boot.ini") ? 0 : 1;
	assert(index == 0 || !strcmp(path, "/boot/boot.ini"));
	cfg_record(fixture, index ? CFG_OP_SCRIPT1_SIZE : CFG_OP_SCRIPT0_SIZE);
	*size = fixture->script_size[index];
	return fixture->script_status[index];
}

static int cfg_read(void *opaque, const char *path, void *buffer,
		    unsigned long size)
{
	struct cfg_fixture *fixture = opaque;
	unsigned int index = !strcmp(path, "/boot.ini") ? 0 : 1;

	cfg_record(fixture, CFG_OP_READ);
	if (fixture->read_rc)
		return fixture->read_rc;
	assert(size == fixture->script_size[index]);
	memcpy(buffer, fixture->script_data[index], size);
	return 0;
}

static void *cfg_allocate(void *opaque, unsigned long size)
{
	struct cfg_fixture *fixture = opaque;

	if (fixture->allocate_fails)
		return NULL;
	return malloc(size);
}

static void cfg_release(void *opaque, void *buffer)
{
	struct cfg_fixture *fixture = opaque;

	cfg_record(fixture, CFG_OP_RELEASE);
	fixture->release_count++;
	free(buffer);
}

static int cfg_set_devnum(void *opaque, const char *devnum)
{
	struct cfg_fixture *fixture = opaque;

	if (!devnum) {
		cfg_record(fixture, CFG_OP_CLEAR);
		fixture->clear_count++;
		fixture->override_present = 0;
		fixture->override[0] = '\0';
		return 0;
	}

	cfg_record(fixture, CFG_OP_SET_OVERRIDE);
	fixture->set_count++;
	if (fixture->override_set_rc)
		return fixture->override_set_rc;
	assert(!strcmp(devnum, "0") || !strcmp(devnum, "1"));
	fixture->override_present = 1;
	fixture->override[0] = devnum[0];
	fixture->override[1] = '\0';
	return 0;
}

static int cfg_execute(void *opaque, char *script, unsigned long size)
{
	struct cfg_fixture *fixture = opaque;

	cfg_record(fixture, CFG_OP_EXECUTE);
	assert(fixture->override_present);
	strcpy(fixture->executed_override, fixture->override);
	assert(size < sizeof(fixture->executed));
	memcpy(fixture->executed, script, size);
	fixture->executed[size] = '\0';
	fixture->executed_size = size;
	fixture->execute_count++;
	return fixture->execute_rc;
}

static void cfg_diagnose(void *opaque, const struct cfgload_source *source,
			 enum cfgload_source_error error, const char *path,
			 long detail)
{
	struct cfg_fixture *fixture = opaque;

	(void)source;
	(void)path;
	(void)detail;
	cfg_record(fixture, CFG_OP_DIAGNOSE);
	fixture->diagnosed_error = error;
	fixture->diagnose_count++;
}

static const struct cfgload_source_ops cfg_ops = {
	.select = cfg_select,
	.file_size = cfg_file_size,
	.read = cfg_read,
	.allocate = cfg_allocate,
	.release = cfg_release,
	.set_devnum = cfg_set_devnum,
	.execute = cfg_execute,
	.diagnose = cfg_diagnose,
};

static struct cfg_fixture valid_cfg_fixture(void)
{
	struct cfg_fixture fixture = {
		.script_status = { CFGLOAD_FILE_OK, CFGLOAD_FILE_MISSING },
		.script_size = { sizeof(strict_script) - 1, 0 },
		.script_data = { strict_script, NULL },
		.image_status = CFGLOAD_FILE_OK,
		.image_size = 16 * 1024 * 1024,
	};

	return fixture;
}

static void assert_strict_failure(struct cfg_fixture *fixture,
				  const struct cfgload_source *source,
				  enum cfgload_source_error error)
{
	assert(cfgload_source_run(&cfg_ops, fixture, source) == -1);
	assert(fixture->diagnose_count == 1);
	assert(fixture->diagnosed_error == error);
	assert(fixture->execute_count == 0);
	assert(!fixture->override_present);
	assert(fixture->select_count <= 1);
	if (fixture->select_count)
		assert(!strcmp(fixture->selected_partition, source->partition));
}

static void test_strict_source_selection_and_bytes(void)
{
	struct cfg_fixture fixture;

	fixture = valid_cfg_fixture();
	assert(cfgload_source_run(&cfg_ops, &fixture, &sd_source) == 0);
	assert(fixture.select_count == 1);
	assert(!strcmp(fixture.selected_partition, "0:1"));
	assert(fixture.set_count == 1);
	assert(!fixture.override_present);
	assert(fixture.override[0] == '\0');
	assert(fixture.clear_count == 2);
	assert(fixture.execute_count == 1);
	assert(!strcmp(fixture.executed_override, "0"));
	assert(fixture.executed_size == sizeof(strict_body) - 1);
	assert(!memcmp(fixture.executed, strict_body, sizeof(strict_body) - 1));
	assert(fixture.operations[0] == CFG_OP_CLEAR);
	assert(fixture.operations[1] == CFG_OP_SELECT);
	assert(fixture.operations[fixture.operation_count - 2] == CFG_OP_CLEAR);
	assert(fixture.operations[fixture.operation_count - 1] == CFG_OP_RELEASE);

	fixture = valid_cfg_fixture();
	assert(cfgload_source_run(&cfg_ops, &fixture, &emmc_source) == 0);
	assert(fixture.select_count == 1);
	assert(!strcmp(fixture.selected_partition, "1:1"));
	assert(fixture.set_count == 1);
	assert(fixture.execute_count == 1);
	assert(!strcmp(fixture.executed_override, "1"));
	assert(!fixture.override_present);
	assert(strcmp(fixture.selected_partition, "0:1"));
	assert(strcmp(fixture.selected_partition, "1:4"));
}

static void test_strict_script_failures(void)
{
	struct cfg_fixture fixture;
	static const char bad_magic[] = "NOT-THE-MAGIC\nsetenv bootargs bad\n";
	static const char empty_body[] = "ODROIDC5-UBOOT-CONFIG\n";

	fixture = valid_cfg_fixture();
	fixture.script_status[0] = CFGLOAD_FILE_MISSING;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_MISSING);

	fixture = valid_cfg_fixture();
	fixture.script_size[0] = 0;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_MISSING);

	fixture = valid_cfg_fixture();
	fixture.script_status[0] = CFGLOAD_FILE_ERROR;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_STAT_FAILED);

	fixture = valid_cfg_fixture();
	fixture.script_size[0] = CFGLOAD_BOOTINI_MAX_BYTES + 1;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_TOO_LARGE);

	fixture = valid_cfg_fixture();
	fixture.script_data[0] = bad_magic;
	fixture.script_size[0] = sizeof(bad_magic) - 1;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_MAGIC_INVALID);

	fixture = valid_cfg_fixture();
	fixture.script_data[0] = empty_body;
	fixture.script_size[0] = sizeof(empty_body) - 1;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_BODY_EMPTY);

	fixture = valid_cfg_fixture();
	fixture.read_rc = -1;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_READ_FAILED);

	fixture = valid_cfg_fixture();
	fixture.allocate_fails = 1;
	assert_strict_failure(&fixture, &sd_source,
			      CFGLOAD_SOURCE_SCRIPT_ALLOC_FAILED);
}

static void test_strict_image_and_execution_failures(void)
{
	struct cfg_fixture fixture;

	fixture = valid_cfg_fixture();
	fixture.image_status = CFGLOAD_FILE_MISSING;
	assert_strict_failure(&fixture, &emmc_source,
			      CFGLOAD_SOURCE_IMAGE_MISSING);

	fixture = valid_cfg_fixture();
	fixture.image_status = CFGLOAD_FILE_ERROR;
	assert_strict_failure(&fixture, &emmc_source,
			      CFGLOAD_SOURCE_IMAGE_STAT_FAILED);

	fixture = valid_cfg_fixture();
	fixture.image_size = 0;
	assert_strict_failure(&fixture, &emmc_source,
			      CFGLOAD_SOURCE_IMAGE_MISSING);

	fixture = valid_cfg_fixture();
	fixture.execute_rc = 37;
	assert(cfgload_source_run(&cfg_ops, &fixture, &sd_source) == -1);
	assert(fixture.diagnosed_error == CFGLOAD_SOURCE_SCRIPT_FAILED);
	assert(fixture.execute_count == 1);
	assert(fixture.select_count == 1);
	assert(!strcmp(fixture.selected_partition, "0:1"));
	assert(!fixture.override_present);
	assert(fixture.clear_count == 2);
	assert(fixture.operations[fixture.operation_count - 1] ==
	       CFG_OP_DIAGNOSE);
}

enum boot_operation {
	BOOT_OP_ROUTE_SERIAL,
	BOOT_OP_INSTALLER,
	BOOT_OP_SD_PROBE,
	BOOT_OP_CFGLOAD_SD,
	BOOT_OP_CFGLOAD_EMMC,
	BOOT_OP_RESTORE,
};

struct boot_fixture {
	int route_rc;
	int installer_rc;
	int sd_image_status;
	int cfgload_rc;
	int restore_rc;
	enum boot_operation operations[12];
	unsigned int operation_count;
	unsigned int installer_count;
	unsigned int cfgload_count;
	unsigned int restore_count;
	unsigned int storage_write_count;
};

static void boot_record(struct boot_fixture *fixture,
			enum boot_operation operation)
{
	assert(fixture->operation_count < ARRAY_SIZE(fixture->operations));
	fixture->operations[fixture->operation_count++] = operation;
}

static int boot_route_serial(void *opaque)
{
	struct boot_fixture *fixture = opaque;

	boot_record(fixture, BOOT_OP_ROUTE_SERIAL);
	return fixture->route_rc;
}

static int boot_run_installer(void *opaque)
{
	struct boot_fixture *fixture = opaque;

	boot_record(fixture, BOOT_OP_INSTALLER);
	fixture->installer_count++;
	/* The installer is the only write-capable callback in this policy fake. */
	fixture->storage_write_count++;
	return fixture->installer_rc;
}

static int boot_sd_image_present(void *opaque)
{
	struct boot_fixture *fixture = opaque;

	boot_record(fixture, BOOT_OP_SD_PROBE);
	return fixture->sd_image_status;
}

static int boot_run_cfgload(void *opaque, enum bm201_linux_source source)
{
	struct boot_fixture *fixture = opaque;

	boot_record(fixture, source == BM201_LINUX_SOURCE_SD ?
		    BOOT_OP_CFGLOAD_SD : BOOT_OP_CFGLOAD_EMMC);
	fixture->cfgload_count++;
	return fixture->cfgload_rc;
}

static int boot_restore_console(void *opaque)
{
	struct boot_fixture *fixture = opaque;

	boot_record(fixture, BOOT_OP_RESTORE);
	fixture->restore_count++;
	return fixture->restore_rc;
}

static const struct bm201_boot_source_ops boot_ops = {
	.route_serial = boot_route_serial,
	.run_installer = boot_run_installer,
	.sd_image_present = boot_sd_image_present,
	.run_cfgload = boot_run_cfgload,
	.restore_console = boot_restore_console,
};

static void expect_boot_operations(const struct boot_fixture *fixture,
				   const enum boot_operation *expected,
				   unsigned int expected_count)
{
	unsigned int index;

	assert(fixture->operation_count == expected_count);
	for (index = 0; index < expected_count; index++)
		assert(fixture->operations[index] == expected[index]);
}

#define EXPECT_BOOT_OPERATIONS(fixture, ...) \
	do { \
		const enum boot_operation expected[] = { __VA_ARGS__ }; \
		expect_boot_operations(&(fixture), expected, ARRAY_SIZE(expected)); \
	} while (0)

static void test_boot_source_choices(void)
{
	struct bm201_boot_source_outcome outcome;
	struct boot_fixture fixture = { .sd_image_status = 1 };

	assert(bm201_boot_source_run(&boot_ops, &fixture, "auto", &outcome) ==
	       BM201_BOOT_SOURCE_RETURNED);
	assert(outcome.source == BM201_LINUX_SOURCE_SD);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_INSTALLER,
			       BOOT_OP_SD_PROBE, BOOT_OP_CFGLOAD_SD,
			       BOOT_OP_RESTORE);
	assert(fixture.installer_count == 1);
	assert(fixture.cfgload_count == 1);
	assert(fixture.restore_count == 1);
	assert(fixture.storage_write_count == fixture.installer_count);

	memset(&fixture, 0, sizeof(fixture));
	assert(bm201_boot_source_run(&boot_ops, &fixture, "auto", &outcome) ==
	       BM201_BOOT_SOURCE_RETURNED);
	assert(outcome.source == BM201_LINUX_SOURCE_EMMC);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_INSTALLER,
			       BOOT_OP_SD_PROBE, BOOT_OP_CFGLOAD_EMMC,
			       BOOT_OP_RESTORE);
	assert(fixture.installer_count == 1);
	assert(fixture.cfgload_count == 1);
	assert(fixture.storage_write_count == fixture.installer_count);

	memset(&fixture, 0, sizeof(fixture));
	fixture.sd_image_status = 1;
	assert(bm201_boot_source_run(&boot_ops, &fixture, "sd", &outcome) ==
	       BM201_BOOT_SOURCE_RETURNED);
	assert(outcome.source == BM201_LINUX_SOURCE_SD);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_INSTALLER,
			       BOOT_OP_CFGLOAD_SD, BOOT_OP_RESTORE);
	assert(fixture.installer_count == 1);
	assert(fixture.cfgload_count == 1);
	assert(fixture.storage_write_count == fixture.installer_count);

	memset(&fixture, 0, sizeof(fixture));
	fixture.sd_image_status = 1;
	assert(bm201_boot_source_run(&boot_ops, &fixture, "emmc", &outcome) ==
	       BM201_BOOT_SOURCE_RETURNED);
	assert(outcome.source == BM201_LINUX_SOURCE_EMMC);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_INSTALLER,
			       BOOT_OP_CFGLOAD_EMMC, BOOT_OP_RESTORE);
	assert(fixture.installer_count == 1);
	assert(fixture.cfgload_count == 1);
	assert(fixture.storage_write_count == fixture.installer_count);
}

static void test_boot_source_failures(void)
{
	struct bm201_boot_source_outcome outcome;
	struct boot_fixture fixture = { 0 };

	assert(bm201_boot_source_run(&boot_ops, &fixture, "invalid", &outcome) ==
	       BM201_BOOT_SOURCE_INVALID);
	assert(fixture.operation_count == 0);
	assert(fixture.installer_count == 0);
	assert(fixture.storage_write_count == 0);

	memset(&fixture, 0, sizeof(fixture));
	fixture.route_rc = 4;
	assert(bm201_boot_source_run(&boot_ops, &fixture, "sd", &outcome) ==
	       BM201_BOOT_SOURCE_ROUTE_FAILED);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_RESTORE);
	assert(fixture.installer_count == 0);
	assert(fixture.cfgload_count == 0);
	assert(fixture.storage_write_count == 0);
	assert(fixture.restore_count == 1);

	memset(&fixture, 0, sizeof(fixture));
	fixture.installer_rc = 5;
	assert(bm201_boot_source_run(&boot_ops, &fixture, "emmc", &outcome) ==
	       BM201_BOOT_SOURCE_INSTALLER_FAILED);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_INSTALLER,
			       BOOT_OP_RESTORE);
	assert(fixture.installer_count == 1);
	assert(fixture.cfgload_count == 0);
	assert(fixture.restore_count == 1);
	assert(fixture.storage_write_count == 1);

	memset(&fixture, 0, sizeof(fixture));
	fixture.sd_image_status = 1;
	fixture.cfgload_rc = 6;
	assert(bm201_boot_source_run(&boot_ops, &fixture, "auto", &outcome) ==
	       BM201_BOOT_SOURCE_CFGLOAD_FAILED);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_INSTALLER,
			       BOOT_OP_SD_PROBE, BOOT_OP_CFGLOAD_SD,
			       BOOT_OP_RESTORE);
	assert(fixture.cfgload_count == 1);
	assert(outcome.source == BM201_LINUX_SOURCE_SD);
	assert(fixture.restore_count == 1);

	memset(&fixture, 0, sizeof(fixture));
	fixture.cfgload_rc = 7;
	assert(bm201_boot_source_run(&boot_ops, &fixture, "emmc", &outcome) ==
	       BM201_BOOT_SOURCE_CFGLOAD_FAILED);
	EXPECT_BOOT_OPERATIONS(fixture, BOOT_OP_ROUTE_SERIAL, BOOT_OP_INSTALLER,
			       BOOT_OP_CFGLOAD_EMMC, BOOT_OP_RESTORE);
	assert(outcome.source == BM201_LINUX_SOURCE_EMMC);
	assert(fixture.installer_count == 1);
	assert(fixture.cfgload_count == 1);
	assert(fixture.restore_count == 1);
}

struct menu_assignment {
	const char *name;
	const char *value;
};

struct menu_fixture {
	int fail_at;
	struct menu_assignment assignments[20];
	unsigned int assignment_count;
	const char *bootdelay;
	unsigned int boot_source_count;
	unsigned int installer_count;
};

static int menu_set(void *opaque, const char *name, const char *value)
{
	struct menu_fixture *fixture = opaque;
	unsigned int index = fixture->assignment_count;

	assert(index < ARRAY_SIZE(fixture->assignments));
	fixture->assignments[index].name = name;
	fixture->assignments[index].value = value;
	fixture->assignment_count++;
	if ((int)index == fixture->fail_at)
		return -100 - (int)index;
	if (!strcmp(name, "bootdelay"))
		fixture->bootdelay = value;
	return 0;
}

static const struct bm201_menu_env_ops menu_ops = {
	.set = menu_set,
};

static const struct menu_assignment expected_menu_assignments[] = {
	{ "stdin", "serial" },
	{ "stdout", "serial" },
	{ "stderr", "serial" },
	{ "bootdelay", "-1" },
	{ "bootcmd", "" },
	{ "bm201_console_out", "serial" },
	{ "cfgload_devnum", NULL },
	{ "bootmenu_0", "Automatic boot=bm201_boot_source auto" },
	{ "bootmenu_1", "Boot Linux from SD=bm201_boot_source sd" },
	{ "bootmenu_2", "Boot Linux from eMMC=bm201_boot_source emmc" },
	{ "bootmenu_3", NULL },
	{ "bootmenu_default", "0" },
	{ "bootcmd", "bootmenu 3" },
};

static void assert_assignment(const struct menu_assignment *actual,
			      const struct menu_assignment *expected)
{
	assert(!strcmp(actual->name, expected->name));
	if (!expected->value)
		assert(actual->value == NULL);
	else
		assert(actual->value != NULL &&
		       !strcmp(actual->value, expected->value));
}

static void test_menu_environment(void)
{
	struct bm201_menu_setup_outcome outcome;
	struct menu_fixture fixture = { .fail_at = -1 };
	unsigned int index;

	assert(!strcmp(BM201_CONSOLE_SERIAL, "serial"));
	assert(!strcmp(BM201_CONSOLE_VIDEO, "serial,vidconsole"));
	assert(!strcmp(BM201_BOOTMENU_AUTOMATIC,
		       "Automatic boot=bm201_boot_source auto"));
	assert(!strcmp(BM201_BOOTMENU_SD,
		       "Boot Linux from SD=bm201_boot_source sd"));
	assert(!strcmp(BM201_BOOTMENU_EMMC,
		       "Boot Linux from eMMC=bm201_boot_source emmc"));
	assert(!strcmp(BM201_BOOTMENU_COMMAND, "bootmenu 3"));

	assert(bm201_menu_setup(&menu_ops, &fixture, &outcome) ==
	       BM201_MENU_SETUP_OK);
	assert(fixture.assignment_count ==
	       ARRAY_SIZE(expected_menu_assignments));
	for (index = 0; index < fixture.assignment_count; index++)
		assert_assignment(&fixture.assignments[index],
				  &expected_menu_assignments[index]);
	assert(!strcmp(fixture.bootdelay, "-1"));
	assert(fixture.boot_source_count == 0);
	assert(fixture.installer_count == 0);

	assert(bm201_menu_activate(&menu_ops, &fixture) == 0);
	assert(fixture.assignment_count ==
	       ARRAY_SIZE(expected_menu_assignments) + 1);
	assert(!strcmp(fixture.assignments[fixture.assignment_count - 1].name,
		       "bootdelay"));
	assert(!strcmp(fixture.assignments[fixture.assignment_count - 1].value,
		       "-2"));
	assert(!strcmp(fixture.bootdelay, "-2"));
}

static void test_menu_assignment_failures(void)
{
	struct bm201_menu_setup_outcome outcome;
	struct menu_fixture fixture;
	unsigned int fail_at;
	enum bm201_menu_setup_result result;

	for (fail_at = 0; fail_at < ARRAY_SIZE(expected_menu_assignments);
	     fail_at++) {
		memset(&fixture, 0, sizeof(fixture));
		fixture.fail_at = fail_at;
		result = bm201_menu_setup(&menu_ops, &fixture, &outcome);
		assert(result == (fail_at < 5 ? BM201_MENU_SETUP_SAFE_FAILED :
				 BM201_MENU_SETUP_POLICY_FAILED));
		assert(outcome.failed_status == -100 - (int)fail_at);
		assert(!strcmp(outcome.failed_name,
			       expected_menu_assignments[fail_at].name));
		assert(!fixture.bootdelay || strcmp(fixture.bootdelay, "-2"));
		assert(fixture.boot_source_count == 0);
		assert(fixture.installer_count == 0);
	}

	memset(&fixture, 0, sizeof(fixture));
	fixture.fail_at = ARRAY_SIZE(expected_menu_assignments);
	assert(bm201_menu_setup(&menu_ops, &fixture, &outcome) ==
	       BM201_MENU_SETUP_OK);
	assert(!strcmp(fixture.bootdelay, "-1"));
	assert(bm201_menu_activate(&menu_ops, &fixture) != 0);
	assert(!strcmp(fixture.bootdelay, "-1"));
	assert(fixture.boot_source_count == 0);
	assert(fixture.installer_count == 0);
}

int main(int argc, char **argv)
{
	if (argc == 2) {
		if (!strcmp(argv[1], "fat"))
			return run_fat_device_oracle();
		if (!strcmp(argv[1], "script"))
			return run_script_length_oracle();
		if (!strcmp(argv[1], "video"))
			return run_video_recovery_oracle();
		fprintf(stderr, "unknown oracle: %s\n", argv[1]);
		return 2;
	}
	assert(argc == 1);

	if (run_fat_device_oracle() || run_script_length_oracle() ||
	    run_video_recovery_oracle())
		return 1;

	test_legacy_cfgload_order();
	test_legacy_cfgload_clears_override();
	test_strict_source_selection_and_bytes();
	test_strict_script_failures();
	test_strict_image_and_execution_failures();
	test_boot_source_choices();
	test_boot_source_failures();
	test_menu_environment();
	test_menu_assignment_failures();

	puts("BM201 boot source and menu contract tests passed");
	return 0;
}

#endif
