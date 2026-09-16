#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../../_out/src/mica-boards.cx3576/common/uboot/mica-records.h"

int main(void)
{
    struct mica_boot_records records;
    char a[65], b[65], c[65], text[513], rendered[513];
    memset(a, 'a', 64); a[64] = 0;
    memset(b, 'b', 64); b[64] = 0;
    memset(c, 'c', 64); c[64] = 0;
    snprintf(text, sizeof(text), "v1|%s,%s,2,3;%s,%s,1,-", a, c, b, c);
    assert(!mica_boot_parse(text, &records));
    assert(records.count == 2 && records.entry[0].generation == 2);
    assert(mica_boot_next(&records) == 0);
    assert(!mica_boot_render(&records, rendered));
    assert(!strcmp(text, rendered));
    for (int tries = 2; tries >= 0; tries--) {
        records.entry[0].tries = tries;
        assert(!mica_boot_render(&records, rendered));
        assert(!mica_boot_parse(rendered, &records));
    }
    assert(mica_boot_next(&records) == 1);
    records.entry[1].tries = 0;
    assert(mica_boot_next(&records) == -1);
    assert(mica_boot_slot(1, 255, 1, 0) == 1);
    assert(mica_boot_slot(1, 0, 1, 255) == 0);
    assert(mica_boot_slot(1, 3, 1, 3) == 0);
    assert(mica_boot_slot(0, 3, 1, 2) == 1);
    assert(mica_boot_slot(0, 3, 0, 2) == -1);
    const char *generations[] = {"0", "02", "9007199254740992", "-1", "2;booti"};
    for (unsigned i = 0; i < sizeof(generations) / sizeof(*generations); i++) {
        snprintf(text, sizeof(text), "v1|%s,%s,%s,3", a, c, generations[i]);
        assert(mica_boot_parse(text, &records));
    }
    snprintf(text, sizeof(text), "v1|%s,%s,2,4", a, c);
    assert(mica_boot_parse(text, &records));
    snprintf(text, sizeof(text), "v1|%s,%s,2,3;%s,%s,1,-", a, c, a, c);
    assert(mica_boot_parse(text, &records));
    snprintf(text, sizeof(text), "v1|%s,%s,1,3;%s,%s,2,-", a, c, b, c);
    assert(mica_boot_parse(text, &records));
    snprintf(text, sizeof(text), "v1|%s,%s,2,3;", a, c);
    assert(mica_boot_parse(text, &records));
    snprintf(text, sizeof(text), "v1|%s,%s,3,3;%s,%s,2,-;%s,%s,1,-", a, c, b, c, c, c);
    assert(mica_boot_parse(text, &records));
    assert(mica_boot_parse("v1|", &records));
    memset(text, 'a', 512); text[512] = 0;
    assert(mica_boot_parse(text, &records));
    puts("FIT_BOOT_RECORDS_PASS");
    return 0;
}
