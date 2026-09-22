/* A disposable guest probe of permission to revoke a built-in content key. */
#include <errno.h>
#include <linux/keyctl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void)
{
    FILE *keys = fopen("/proc/keys", "r");
    char line[4096];
    unsigned int id;
    int found = 0;
    if (!keys) return 1;
    while (fgets(line, sizeof(line), keys)) {
        if (!strstr(line, " asymmetri ") ||
            !strstr(line, "mica development verity content anchor") ||
            sscanf(line, "%x", &id) != 1) continue;
        found++;
        printf("LIFECYCLE keyring %s", line);
        errno = 0;
        long result = syscall(SYS_keyctl, KEYCTL_REVOKE, id, 0, 0, 0);
        printf("LIFECYCLE revoke key=%x result=%ld errno=%d\n", id, result, errno);
    }
    fclose(keys);
    if (!found) fprintf(stderr, "LIFECYCLE no matching built-in content key\n");
    return found ? 0 : 1;
}
