/* Simulated block I/O around the production selector and record writer. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
typedef uint8_t u8;
#define ALLOC_CACHE_ALIGN_BUFFER(type, name, size) type name[size]
#define MMC_MAX_BLOCK_LEN 512
#define EXT_CSD_CMD_SET_NORMAL 1
#define UCLASS_MMC 7
#define PART_TYPE_EFI 5
struct blk_desc { int devnum, uclass_id; unsigned int blksz; int part_type; };
struct mmc { int sd, present, init_error; struct blk_desc disk; };
struct disk_partition { unsigned long start, size; char name[36], uuid[37]; };
#define IS_SD(mmc) ((mmc)->sd)
static struct mmc devices[2];
static struct disk_partition parts[2][6];
static int count[2], io_error, write_error, flush_error, corrupt_readback, writes, flushes, mica_header, wrong_emmc_guid;
static unsigned char env_storage[2][2][65536];
static uint32_t get_unaligned_le32(const void *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static void put_unaligned_le32(uint32_t v, void *p) { memcpy(p, &v, 4); }
static struct mmc *find_mmc_device(int n) { return &devices[n]; }
static int mmc_getcd(struct mmc *m) { return m->present; }
static int mmc_init(struct mmc *m) { return m->init_error; }
static int blk_select_hwpart_devnum(int cls, int n, int part) { assert(cls == UCLASS_MMC && n < 2 && part == 0); return 0; }
static struct blk_desc *mmc_get_blk_desc(struct mmc *m) { return &m->disk; }
static void part_init(struct blk_desc *d) { assert(d->devnum < 2); }
static int part_get_info(struct blk_desc *d, int n, struct disk_partition *p) {
    if (n > count[d->devnum]) return -1;
    *p = parts[d->devnum][n - 1]; return 0;
}
static unsigned long blk_dread(struct blk_desc *d, unsigned long start, unsigned long blocks, void *out) {
    if (io_error) return 0;
    if (blocks == 2 && start == 0) {
        memset(out, 0, 1024);
        if (d->devnum == 1 || mica_header) {
            static const unsigned char guid[] = {
                0xa0, 0x55, 0x90, 0x5a, 0x03, 0x00, 0x00, 0x40,
                0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            };
            memcpy((unsigned char *)out + 512, "EFI PART", 8);
            memcpy((unsigned char *)out + 512 + 56, guid, sizeof(guid));
            if (d->devnum == 1) ((unsigned char *)out)[512 + 60] = wrong_emmc_guid ? 0x03 : 0x04;
        }
        return blocks;
    }
    int slot = start == (d->devnum ? 262144UL : 245760UL) ? 0 : 1;
    assert(start == (d->devnum ? (slot ? 270336UL : 262144UL) : (slot ? 253952UL : 245760UL)));
    memcpy(out, env_storage[d->devnum][slot], blocks * 512);
    if (corrupt_readback && writes) ((unsigned char *)out)[12] ^= 1;
    return blocks;
}
static unsigned long blk_dwrite(struct blk_desc *d, unsigned long start, unsigned long blocks, const void *in) {
    if (write_error) return 0;
    int slot = start == (d->devnum ? 262144UL : 245760UL) ? 0 : 1;
    assert(start == (d->devnum ? (slot ? 270336UL : 262144UL) : (slot ? 253952UL : 245760UL)));
    memcpy(env_storage[d->devnum][slot], in, blocks * 512); writes++; return blocks;
}
static void blkcache_invalidate(int cls, int n) { assert(cls == UCLASS_MMC && n < 2); }
static int mmc_send_ext_csd(struct mmc *m, u8 *out) { assert(!IS_SD(m)); memset(out, 0, 512); out[33] = 1; return 0; }
static int mmc_switch(struct mmc *m, u8 set, u8 index, u8 value) {
    assert(!IS_SD(m) && set == EXT_CSD_CMD_SET_NORMAL && index == 32 && value == 1);
    flushes++; return flush_error;
}
#include "production.c"

static void setup(void) {
    memset(devices, 0, sizeof(devices)); memset(parts, 0, sizeof(parts));
    memset(env_storage, 0, sizeof(env_storage));
    io_error = write_error = flush_error = corrupt_readback = writes = flushes = mica_header = wrong_emmc_guid = 0;
    for (int d = 0; d < 2; d++) {
        const struct mica_media *media = d ? &emmc_media : &sd_media;
        static const char *names[] = { "firmware", "system", "data" };
        devices[d] = (struct mmc){ .sd = !d, .present = 1, .disk = { d, UCLASS_MMC, 512, PART_TYPE_EFI } };
        count[d] = d ? 6 : 3;
        for (int i = 0; i < 3; i++) {
            parts[d][i].start = media->starts[i]; parts[d][i].size = media->sizes[i];
            strcpy(parts[d][i].name, names[i]); strcpy(parts[d][i].uuid, media->uuids[i]);
        }
        if (d) {
            static const unsigned long starts[] = { 8192, 73728, 221184 };
            static const unsigned long sizes[] = { 24576, 131072, 32768 };
            static const char *vendor_names[] = { "bootloader_a", "reserved", "env" };
            static const char *uuids[] = {
                "708161c1-0000-4000-8000-000000000011",
                "708161c1-0000-4000-8000-000000000014",
                "708161c1-0000-4000-8000-000000000015",
            };
            for (int i = 0; i < 3; i++) {
                parts[d][i + 3].start = starts[i]; parts[d][i + 3].size = sizes[i];
                strcpy(parts[d][i + 3].name, vendor_names[i]);
                strcpy(parts[d][i + 3].uuid, uuids[i]);
            }
        }
    }
}
int main(void) {
    struct mmc *selected; const struct mica_media *profile;
    setup(); assert(select_medium(&selected, &profile) == 1 && selected == &devices[0]);
    devices[0].present = 0; assert(select_medium(&selected, &profile) == 1 && selected == &devices[1]);
    setup(); devices[0].present = 0; wrong_emmc_guid = 1; assert(select_medium(&selected, &profile) < 0);
    setup(); count[0] = 0; devices[0].disk.part_type = 0;
    assert(select_medium(&selected, &profile) == 1 && selected == &devices[1]);
    count[1] = 0; assert(select_medium(&selected, &profile) < 0);
    setup(); count[0] = 1; strcpy(parts[0][0].name, "data"); strcpy(parts[0][0].uuid, "unrelated");
    assert(select_medium(&selected, &profile) == 1 && selected == &devices[1]);
    mica_header = 1; assert(select_medium(&selected, &profile) < 0);
    setup(); parts[0][1].start++; assert(select_medium(&selected, &profile) < 0);
    setup(); parts[0][1].uuid[0] = '0'; assert(select_medium(&selected, &profile) < 0);
    setup(); devices[0].init_error = -1; assert(select_medium(&selected, &profile) < 0);
    setup(); io_error = 1; assert(select_medium(&selected, &profile) < 0);
    setup(); devices[0].present = 0; parts[1][4].start++; assert(select_medium(&selected, &profile) < 0);
    setup(); devices[0].present = 0; assert(select_medium(&selected, &profile) == 1);
    unsigned char *copies = calloc(2, MICA_ENV_SIZE); assert(copies);
    struct mica_boot_records records = { .count = 1 };
    memset(records.entry[0].id, 'a', 64); memset(records.entry[0].kernel, 'b', 64);
    records.entry[0].generation = 1; records.entry[0].tries = 2;
    assert(persist_environment(selected, profile, copies, 0, &records) == 0);
    assert(writes == 1 && flushes == 1);
    assert(read_environment(&selected->disk, profile, copies, &records) == 1);
    assert(records.entry[0].tries == 2);
    records.entry[0].tries = 0; assert(mica_boot_next(&records) < 0);
    write_error = 1; assert(persist_environment(selected, profile, copies, 0, &records) < 0);
    write_error = 0; flush_error = -1; assert(persist_environment(selected, profile, copies, 0, &records) < 0);
    flush_error = 0; corrupt_readback = 1; assert(persist_environment(selected, profile, copies, 0, &records) < 0);
    free(copies); puts("DUAL_MEDIA_PASS"); return 0;
}
