// The boot test's init: what the kernel booted with, read back over the serial console, then power off.
// Static, so the initramfs is this file alone.
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <unistd.h>

static void show(const char *label, const char *path)
{
	char buf[512];
	int fd = open(path, O_RDONLY);
	ssize_t n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);

	if (fd >= 0)
		close(fd);
	if (n < 0) {
		printf("%s: unreadable\n", label);
		return;
	}
	buf[n] = 0;
	for (ssize_t i = 0; i < n; i++)
		if (buf[i] == '\n' || buf[i] == 0)
			buf[i] = ' ';
	printf("%s: %s\n", label, buf);
}

// A boot record copy: its flag byte and the mica_entries value after the CRC.
static void record(const char *label, const char *path)
{
	unsigned char buf[600];
	int fd = open(path, O_RDONLY);
	ssize_t n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);

	if (fd >= 0)
		close(fd);
	if (n < 6) {
		printf("%s: unreadable\n", label);
		return;
	}
	buf[n] = 0;
	printf("%s: flag %u %s\n", label, buf[4], (char *)buf + 5);
}

int main(void)
{
	char path[128], label[64];

	mount("proc", "/proc", "proc", 0, NULL);
	mount("sysfs", "/sys", "sysfs", 0, NULL);
	mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
	printf("MICA_QEMU_ARMHF_INIT\n");
	show("cmdline", "/proc/cmdline");
	show("deployment", "/proc/device-tree/chosen/mica,deployment-id");
	show("mtd", "/proc/mtd");
	show("ubi mtd", "/sys/class/ubi/ubi0/mtd_num");
	for (int i = 0; i < 8; i++) {
		snprintf(path, sizeof(path), "/sys/class/ubi/ubi0_%d/name", i);
		if (access(path, R_OK))
			break;
		snprintf(label, sizeof(label), "volume %d", i);
		show(label, path);
		snprintf(path, sizeof(path), "/sys/class/ubi/ubi0_%d/type", i);
		show("  type", path);
		snprintf(path, sizeof(path), "/sys/class/ubi/ubi0_%d/data_bytes", i);
		show("  bytes", path);
	}
	record("records-a", "/dev/ubi0_0");
	record("records-b", "/dev/ubi0_1");
	show("watchdog", "/sys/class/watchdog/watchdog0/identity");
	printf("MICA_QEMU_ARMHF_INIT_DONE\n");
	fflush(stdout);
	sync();
	reboot(RB_POWER_OFF);
	return 0;
}
