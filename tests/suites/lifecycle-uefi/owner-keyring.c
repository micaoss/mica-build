// mica-build-side: test helper, built static in the lifecycle suite's acceptance disk (runtime-build.sh), never
// shipped. Drives the .mica_owner keyring the way core's runkit does, so runtime.sh can assert the contract:
//
//   owner-keyring id                 print the keyring's serial (from /proc/keys), or exit 2 when there is none
//   owner-keyring add CERT.der       add a DER certificate to it (exit 0, or errno's name on stderr and exit 1)
//   owner-keyring seal               KEYCTL_RESTRICT_KEYRING with no type: reject every further key (EEXIST = sealed)
//
// The kernel side is mica-linux's CONFIG_MICA_OWNER_KEYRING.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#define KEYCTL_RESTRICT_KEYRING 29

static long keyring_id(void)
{
	FILE *f = fopen("/proc/keys", "r");
	char line[512];
	if (!f)
		return -1;
	while (fgets(line, sizeof(line), f)) {
		// <serial hex> <flags> <usage> <timeout> <perm> <uid> <gid> <type> <description>: ...
		char type[64], desc[256];
		unsigned long serial;
		if (sscanf(line, "%lx %*s %*s %*s %*s %*s %*s %63s %255[^:\n]", &serial, type, desc) == 3 &&
		    strcmp(type, "keyring") == 0 && strcmp(desc, ".mica_owner") == 0) {
			fclose(f);
			return (long)serial;
		}
	}
	fclose(f);
	return -1;
}

static int fail(const char *what)
{
	fprintf(stderr, "owner-keyring: %s: %s\n", what, strerrorname_np(errno) ? strerrorname_np(errno) : strerror(errno));
	return 1;
}

int main(int argc, char **argv)
{
	long id = keyring_id();
	if (argc < 2) {
		fprintf(stderr, "usage: owner-keyring id | add CERT.der | seal\n");
		return 64;
	}
	if (id < 0) {
		fprintf(stderr, "owner-keyring: no .mica_owner keyring in /proc/keys\n");
		return 2;
	}
	if (strcmp(argv[1], "id") == 0) {
		printf("%ld\n", id);
		return 0;
	}
	if (strcmp(argv[1], "add") == 0 && argc == 3) {
		FILE *f = fopen(argv[2], "rb");
		static unsigned char der[65536];
		size_t n;
		if (!f)
			return fail(argv[2]);
		n = fread(der, 1, sizeof(der), f);
		fclose(f);
		if (syscall(SYS_add_key, "asymmetric", NULL, der, n, (int)id) < 0)
			return fail("add_key");
		return 0;
	}
	if (strcmp(argv[1], "seal") == 0) {
		if (syscall(SYS_keyctl, KEYCTL_RESTRICT_KEYRING, (int)id, NULL, NULL) < 0)
			return fail("keyctl restrict");
		return 0;
	}
	fprintf(stderr, "usage: owner-keyring id | add CERT.der | seal\n");
	return 64;
}
