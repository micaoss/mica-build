// SPDX-License-Identifier: GPL-2.0+
/* An idle RockUSB session must service the armed boot watchdog. */
#include <assert.h>
#include <stdio.h>
struct udevice { int unused; };
static struct udevice device;
static unsigned int polls, feeds, interrupts, flushes;
static int g_dnl_detach(void) { return ++polls > 10; }
static int ctrlc(void) { return 0; }
static inline void schedule(void) { feeds++; }
static void dm_usb_gadget_handle_interrupts(struct udevice *dev)
{ assert(dev == &device); interrupts++; }
static void rockusb_flush_write_cache_if_idle(void) { flushes++; }
static void recovery_loop(void)
{
    struct udevice *udc = &device;
#include "recovery-loop.h"
}
int main(void)
{
    recovery_loop();
    fprintf(stderr, "RockUSB idle iterations=%u watchdog services=%u\n", interrupts, feeds);
    assert(interrupts == 10 && flushes == 10 && feeds == 10);
    puts("ROCKUSB_WATCHDOG_PASS: idle recovery keeps watchdog service running");
    return 0;
}
