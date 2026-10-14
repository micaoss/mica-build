#include <assert.h>
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#define CMD_RET_SUCCESS 0
#define CMD_RET_FAILURE 1
#define CMD_RET_USAGE -1
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
typedef struct cmd_tbl cmd_tbl_t;
struct cmd_tbl {
    int (*cmd)(cmd_tbl_t *, int, int, char *const []);
};
static int result;

static int subcommand(cmd_tbl_t *cmdtp, int flag, int argc, char *const argv[])
{
    (void)cmdtp;
    assert(flag == 0 && argc == 1 && !strcmp(argv[0], "check"));
    return result;
}

static cmd_tbl_t cmd_rsvmem_sub[] = { { subcommand } };

static cmd_tbl_t *find_cmd_tbl(const char *name, cmd_tbl_t *table, size_t count)
{
    assert(count == 1);
    return !strcmp(name, "check") ? table : NULL;
}

#include "vendor-rsvmem-command.c"

int main(void)
{
    char *args[] = { "rsvmem", "check" };
    int errors[] = { -ENODEV, -EBADMSG, -EFAULT, -EINVAL, CMD_RET_FAILURE };
    result = 0;
    assert(do_rsvmem(NULL, 0, 2, args) == CMD_RET_SUCCESS);
    for (size_t i = 0; i < ARRAY_SIZE(errors); i++) {
        result = errors[i];
        assert(do_rsvmem(NULL, 0, 2, args) == CMD_RET_FAILURE);
    }
    args[1] = "unknown";
    assert(do_rsvmem(NULL, 0, 2, args) == CMD_RET_USAGE);
    puts("RSVMEM_COMMAND_PASS: errors remain failures at the shell boundary");
    return 0;
}
