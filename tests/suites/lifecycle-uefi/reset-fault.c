#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* Test-only micad interposer: interrupt one successful reset deletion. */
static void interrupt_reset(const char *path, int result) {
    if (result || strncmp(path, "/mnt/data/", 10) ||
        access("/var/lib/mica/reset-proof/armed", F_OK)) return;
    int fd = open("/var/lib/mica/reset-proof/fired", O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) return;
    if (write(fd, "reset deletion\n", 15) != 15 || fsync(fd)) _exit(98);
    close(fd);
    fd = open("/var/lib/mica/reset-proof", O_RDONLY | O_DIRECTORY);
    if (fd < 0 || fsync(fd)) _exit(98);
    close(fd);
    fd = open("/dev/console", O_WRONLY);
    if (fd >= 0) {
        dprintf(fd, "FILE_AB_RESET_INTERRUPTION: after successful deletion\n");
        close(fd);
    }
    kill(getpid(), SIGKILL);
    _exit(97);
}
int unlink(const char *path) {
    int (*real)(const char *) = dlsym(RTLD_NEXT, "unlink");
    int result = real(path);
    interrupt_reset(path, result);
    return result;
}
int rmdir(const char *path) {
    int (*real)(const char *) = dlsym(RTLD_NEXT, "rmdir");
    int result = real(path);
    interrupt_reset(path, result);
    return result;
}
