// Exercise the actual firmware policy with deterministic block-device failures.
#include <assert.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef long long loff_t;
#define __noreturn __attribute__((noreturn))
#define ARCH_DMA_MINALIGN 64
#define UCLASS_WDT 1
#define UCLASS_MMC 2
#define BUTTON_ON 1
#define FS_TYPE_EXT 1
#ifdef S905X5M
#define IS_SD(mmc) selected_sd
#define BOOT_EMMC 1
static int boot_source = BOOT_EMMC, boot_index = 1, selected_sd = 1;
static int store_get_type(void) { return boot_source; }
static int store_bootup_bootidx(const char *name) { assert(!strcmp(name, "bootloader")); return boot_index; }
#define ENV_A 245760
#define ENV_B 253952
#define SYSTEM_START 262144
#define FIRMWARE_SECTORS 262080
#define FIT_ADDRESS 0x28000000UL
#define WATCHDOG_MS 60000
#define EXPECT_FLUSHES 0
#else
#define IS_SD(mmc) 0
#define ENV_A 32768
#define ENV_B 34816
#define SYSTEM_START 36864
#define FIRMWARE_SECTORS 36800
#define FIT_ADDRESS 0x60000000UL
#define WATCHDOG_MS 120000
#define EXPECT_FLUSHES 1
#endif
struct blk_desc { unsigned int blksz; int uclass_id, devnum; };
struct mmc { int unused; };
struct udevice { int unused; };
struct cmd_tbl {
    const char *name;
    int maxargs, repeatable;
    int (*cmd)(struct cmd_tbl *, int, int, char *const []);
};
static struct cmd_tbl registered_command;
#define U_BOOT_CMD(name, maxargs, repeatable, command, usage, help) \
    static void __attribute__((constructor)) register_command(void) \
    { registered_command = (struct cmd_tbl){#name, maxargs, repeatable, command}; }
struct disk_partition { unsigned long start, size; unsigned char name[16]; };
static struct blk_desc disk = {512, UCLASS_MMC, 0};
static struct mmc mmc;
static struct udevice device;
static unsigned char medium[2][65536], buffer[131072];
static jmp_buf stopped;
static int fault, reads, writes, flushes, invalidations, loads, launches, armed;
static int fail_copy = -1;
static int watchdog_probe_error, watchdog_start_error;
static int recovery_key, recovery_calls;
static unsigned long system_sectors = 2097152, data_sectors = 524288;
static uint32_t crc32(uint32_t crc, const unsigned char *p, size_t size)
{
    crc = ~crc;
    while (size--) {
        crc ^= *p++;
        for (int bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1)));
    }
    return ~crc;
}
static uint32_t get_unaligned_le32(const unsigned char *p)
{ return p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static void put_unaligned_le32(uint32_t value, unsigned char *p)
{ for (int n = 0; n < 4; n++) p[n] = value >> (8 * n); }
static unsigned long blk_dread(struct blk_desc *d, unsigned long sector, unsigned long blocks, void *out)
{
    assert(armed && d == &disk && blocks == 128);
    int copy = sector == ENV_A ? 0 : 1;
    assert(sector == ENV_A || sector == ENV_B);
    reads++;
    if (copy == fail_copy || (fault == 3 && writes)) return 127;
    memcpy(out, medium[copy], 65536);
    if (fault == 4 && writes) ((unsigned char *)out)[100] ^= 1;
    return blocks;
}
static unsigned long blk_dwrite(struct blk_desc *d, unsigned long sector, unsigned long blocks, const void *in)
{
    assert(d == &disk && sector == ENV_B && blocks == 128 && loads == 0);
    writes++;
    memcpy(medium[1], in, fault == 1 ? 32768 : 65536);
    return fault == 1 ? 64 : blocks;
}
#ifndef S905X5M
static int mmc_flush_cache(struct mmc *m)
{ assert(m == &mmc && writes == 1 && loads == 0); flushes++; return fault == 2 ? -1 : 0; }
#endif
static void blkcache_invalidate(int kind, int number)
{ assert(kind == UCLASS_MMC && number == 0 && flushes == EXPECT_FLUSHES); invalidations++; }
static struct blk_desc *mmc_get_blk_desc(struct mmc *m) { assert(m == &mmc); return &disk; }
static int part_get_info(struct blk_desc *d, int number, struct disk_partition *p)
{
    const unsigned long starts[] = {64, SYSTEM_START, SYSTEM_START + system_sectors};
    const unsigned long sizes[] = {FIRMWARE_SECTORS, system_sectors, data_sectors};
    const char *names[] = {"firmware", "system", "data"};
    assert(d == &disk);
    if (number == 4) return -1;
    p->start = starts[number - 1]; p->size = sizes[number - 1];
    strcpy((char *)p->name, names[number - 1]); return 0;
}
static void disable_ctrlc(int disable) { assert(disable == 1 || disable == 0); }
static int env_set(const char *key, const char *value)
{
    assert((!strcmp(key, "verify") && !strcmp(value, "yes")) ||
           (!strcmp(key, "bootargs") && strstr(value, "dm_verity.require_signatures=1")));
    return 0;
}
#ifndef S905X5M
static int button_get_by_label(const char *label, struct udevice **out)
{ assert(!strcmp(label, "recovery")); *out = &device; return 0; }
static int button_get_state(struct udevice *d) { assert(d == &device); return recovery_key; }
#endif
static int uclass_get_device(int kind, int number, struct udevice **out)
{ assert(kind == UCLASS_WDT && number == 0); *out = &device; return watchdog_probe_error; }
static int wdt_start(struct udevice *d, unsigned long timeout, int flags)
{ assert(d == &device && timeout == WATCHDOG_MS && flags == 0); if (watchdog_start_error) return watchdog_start_error; armed = 1; return 0; }
static void wdt_reset(struct udevice *d) { assert(d == &device); }
static struct mmc *find_mmc_device(int n) { assert(armed && n == 0); return &mmc; }
static int mmc_init(struct mmc *m) { assert(m == &mmc); return 0; }
static int blk_select_hwpart_devnum(int kind, int device_number, int partition)
{ assert(kind == UCLASS_MMC && device_number == 0 && partition == 0); return 0; }
static void *memalign(size_t align, size_t size)
{ assert(align == 64 && size == sizeof(buffer)); return buffer; }
static void release_buffer(void *p) { assert(p == buffer); }
#define free release_buffer
static int fs_set_blk_dev(const char *kind, const char *part, int type)
{ assert(!strcmp(kind, "mmc") && !strcmp(part, "0:2") && type == FS_TYPE_EXT); return 0; }
static int fs_size(const char *path, loff_t *size) { assert(strstr(path, "/boot.itb")); *size = 4096; return 0; }
static int fs_read(const char *path, unsigned long address, loff_t offset, loff_t size, loff_t *loaded)
{
    (void)path; assert(address == FIT_ADDRESS && offset == 0 && size == 4096);
    assert(!fault && writes == 1 && flushes == EXPECT_FLUSHES && invalidations == 1 && reads == 3);
    loads++; *loaded = size; return 0;
}
static int fdt_check_header(const void *p) { (void)p; return 0; }
static loff_t fdt_totalsize(const void *p) { (void)p; return 4096; }
#ifndef S905X5M
static void bootm_boot_start(unsigned long address, const char *args)
{ assert(address == FIT_ADDRESS && strstr(args, "dm_verity.require_signatures=1")); launches++; longjmp(stopped, 1); }
static int run_command(const char *command, int flag)
{ assert(!strcmp(command, "rockusb 0 mmc 0") && flag == 0); recovery_calls++; return 0; }
#else
static int run_command(const char *command, int flag)
{ assert(!strcmp(command, "bootm 0x28000000") && flag == 0); launches++; longjmp(stopped, 1); }
static void cli_loop(void) { recovery_calls++; longjmp(stopped, 2); }
#endif
static void __noreturn hang(void) { longjmp(stopped, 2); }
static void do_reset(void *command, int flag, int argc, void *argv)
{ (void)command; (void)flag; (void)argc; (void)argv; longjmp(stopped, 3); }
#ifdef S905X5M
#include "../../_out/src/mica-boards/boards/s905x5m/loader/mica-file-boot.c"
#else
#include "../../_out/src/mica-boards/boards/cx3576/loader/mica-file-boot.c"
#endif

static void boot_command(void)
{
    char *argv[] = {"micaboot", NULL};
    assert(registered_command.cmd && !strcmp(registered_command.name, "micaboot"));
    assert(registered_command.maxargs == 1 && registered_command.repeatable == 0);
    registered_command.cmd(&registered_command, 0, 1, argv);
    abort();
}

static void prepare(void)
{
    char id[65], kernel[65], text[513];
    memset(id, 'a', 64); id[64] = 0;
    memset(kernel, 'b', 64); kernel[64] = 0;
    snprintf(text, sizeof(text), "v1|%s,%s,2,3", id, kernel);
    memset(medium, 0, sizeof(medium));
    for (int n = 0; n < 2; n++) {
        medium[n][4] = n == 0 ? 2 : 1;
        memcpy(medium[n] + 5, "mica_entries=", 13);
        memcpy(medium[n] + 18, text, strlen(text));
        put_unaligned_le32(crc32(0, medium[n] + 5, 65531), medium[n]);
    }
    reads = writes = flushes = invalidations = loads = launches = armed = 0;
    fail_copy = -1;
    watchdog_probe_error = watchdog_start_error = 0;
    recovery_key = recovery_calls = 0;
    system_sectors = 2097152; data_sectors = 524288;
#ifdef S905X5M
    boot_source = BOOT_EMMC; boot_index = 1; selected_sd = 1;
#endif
}
int main(void)
{
    unsigned char original[65536];
    for (fault = 0; fault <= 4; fault++) {
#ifdef S905X5M
        if (fault == 2) continue; /* SD has no eMMC cache flush operation. */
#endif
        prepare(); memcpy(original, medium[0], sizeof(original));
        int outcome = setjmp(stopped);
        if (!outcome) boot_command();
        assert(!memcmp(original, medium[0], sizeof(original)));
        assert(armed && writes == 1);
        if (!fault) {
            struct mica_boot_records records;
            assert(outcome == 1 && launches == 1 && loads == 1);
            assert(valid_environment(medium[1]) && !decode_environment(medium[1], &records));
            assert(records.entry[0].tries == 2 && medium[1][4] == 3);
        } else {
            assert(outcome == 2 && launches == 0 && loads == 0);
            assert(flushes == (fault == 1 ? 0 : EXPECT_FLUSHES));
        }
    }
    for (int phase = 0; phase < 2; phase++) {
        prepare();
        if (phase == 0) watchdog_probe_error = -38;
        else watchdog_start_error = -5;
        int outcome = setjmp(stopped);
        if (!outcome) boot_command();
        assert(outcome == 2 && armed == 0 && writes == 0 && reads == 0 && loads == 0 && launches == 0);
    }
#ifdef S905X5M
    for (int invalid = 0; invalid < 3; invalid++) {
        prepare();
        if (invalid == 0) boot_source = 0;
        else if (invalid == 1) boot_index = 2;
        else selected_sd = 0;
        int outcome = setjmp(stopped);
        if (!outcome) boot_command();
        assert(outcome == 2 && reads == 0 && writes == 0 && loads == 0 && launches == 0);
        assert(armed == (invalid == 2));
    }
#endif
    fault = 0;
    prepare(); data_sectors = 8 * 2097152UL;
    assert(valid_layout(&disk) == 0);
    for (int invalid = 0; invalid < 2; invalid++) {
        prepare();
        if (invalid == 0) system_sectors = 4194304;
        else data_sectors = 524287;
        int outcome = setjmp(stopped);
        if (!outcome) boot_command();
        assert(outcome == 2 && writes == 0 && reads == 0 && loads == 0 && launches == 0);
    }
    // One unreadable copy may use the other; two corrupt copies must stop.
    fault = 0; prepare(); fail_copy = 1; armed = 1;
    assert(read_environment(&disk, buffer, &(struct mica_boot_records){0}) == 0);
    prepare(); medium[0][0] ^= 1; medium[1][0] ^= 1;
    int outcome = setjmp(stopped);
    if (!outcome) boot_command();
    assert(outcome == 2 && writes == 0 && loads == 0 && launches == 0);
#ifndef S905X5M
    prepare(); recovery_key = BUTTON_ON;
    outcome = setjmp(stopped);
    if (!outcome) boot_command();
    assert(outcome == 2 && recovery_calls == 1 && armed == 0);
    assert(writes == 0 && reads == 0 && loads == 0 && launches == 0);
#endif
    puts("FIT_FIRMWARE_IO_PASS: actual C policy refuses write, flush and readback failures before FIT load");
    return 0;
}
