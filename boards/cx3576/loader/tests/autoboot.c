// Exercise the actual patched main loop, native countdown, and boot command.
#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "autoboot-config.h"

#define IS_ENABLED(symbol) (symbol)
#define ANSI_CLEAR_LINE "\033[2K"
#define GD_FLG_SILENT 1
#define AUTOBOOT_MENUKEY 0
#define BOOTSTAGE_ID_MAIN_LOOP 0
#define EVT_POST_PREBOOT 0
#define EFI_SUCCESS 0
#define version_string "test"
#define debug(...) ((void)0)
#define bootstage_mark_name(...) ((void)0)
#define bootcount_inc() ((void)0)
#define bootcount_error() 0
#define bootretry_init_cmd_timeout() ((void)0)
#define event_notify_null(...) 0
#define update_tftp(...) ((void)0)
#define efi_init_obj_list() 0
#define efi_launch_capsules() ((void)0)
#define process_button_cmds() ((void)0)
#define bootstd_prog_boot() 0
#define panic(...) abort()
#define simple_strtol strtol

struct cmd_tbl { int unused; };
static struct { int flags; } global_data, *gd = &global_data;
static jmp_buf stopped;
static unsigned long now;
static int input_at, input_key, consumed, cli_ready, ctrlc_disabled, launches;
static int stored_bootdelay, menukey;
static char output[512];

static int capture_printf(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int written = vsnprintf(output + strlen(output), sizeof(output) - strlen(output), format, args);
    va_end(args);
    return written;
}
#define printf capture_printf
#define putc(c) capture_printf("%c", (c))

static int tstc(void) { return input_at >= 0 && now >= (unsigned long)input_at && !consumed; }
static int read_key(void) { assert(tstc() && !ctrlc_disabled); consumed++; return input_key; }
#define getchar read_key
static unsigned long get_timer(unsigned long base) { return now - base; }
static void udelay(unsigned long us) { now += us / 1000; }
static int autoboot_keyed(void) { return 0; }
static int abortboot_key_sequence(int delay) { abort(); }
static int menu_show(int delay) { abort(); }
static int ofnode_conf_read_int(const char *key, int fallback) { return fallback; }
static int disable_ctrlc(int value) { int old = ctrlc_disabled; ctrlc_disabled = value; return old; }
static int env_set(const char *key, const char *value) { return 0; }
static char *env_get(const char *key)
{
    if (!strcmp(key, "bootcmd")) return CONFIG_BOOTCOMMAND;
    assert(!strcmp(key, "bootdelay") || !strcmp(key, "preboot") || !strcmp(key, "menucmd"));
    return NULL;
}
static void cli_init(void) { cli_ready = 1; }
static int cli_process_fdt(const char **command) { return 0; }
static void cli_secure_boot_cmd(const char *command) { abort(); }
static void cli_loop(void) { assert(cli_ready && !ctrlc_disabled); longjmp(stopped, 2); }
static void __attribute__((noreturn)) mica_file_boot(void)
{
    assert(cli_ready && !ctrlc_disabled);
    launches++;
    longjmp(stopped, 1);
}
static int run_command_list(const char *command, int length, int flags)
{
    assert(cli_ready && !strcmp(command, "micaboot") && length == -1 && flags == 0);
    mica_file_boot();
}
static int run_command(const char *command, int flags) { return run_command_list(command, -1, flags); }

#include "autoboot-path.h"

static void check_boot(int key_at, int key)
{
    now = 0; input_at = key_at; input_key = key;
    consumed = cli_ready = ctrlc_disabled = launches = 0;
    output[0] = 0;
    int outcome = setjmp(stopped);
    if (!outcome) main_loop();
    assert(strstr(output, "Hit any key to stop autoboot: 1"));
    if (key_at < 0) {
        assert(outcome == 1 && now == 1000 && launches == 1 && consumed == 0);
    } else {
        assert(outcome == 2 && now == (unsigned long)key_at && launches == 0 && consumed == 1);
        // The standard `boot` command resumes the same configured policy.
        outcome = setjmp(stopped);
        if (!outcome) do_bootd(NULL, 0, 1, NULL);
        assert(outcome == 1 && launches == 1);
    }
}

int main(void)
{
    check_boot(-1, 0);
    check_boot(0, ' ');
    check_boot(500, 'x');
    check_boot(990, 3);
    puts("MICA_AUTOBOOT_PASS: one-second prompt, timeout, any-key/Control-C abort, and boot resume");
    return 0;
}
