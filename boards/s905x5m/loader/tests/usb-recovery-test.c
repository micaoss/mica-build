/* Host services around the actual pinned ADNL wait loop, without storage access. */
#include <assert.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

#define CONFIG_USB_GADGET_CRG 1
#define CONFIG_IS_ENABLED(option) 0
#define CMD_RET_FAILURE 1
#define CMD_RET_SUCCESS 0

unsigned int _sofintr_not_occur;
static unsigned long now_ms;
static unsigned int connect_at, configure_at, cancel_at;
static int registration_error, registrations, unregistrations;
static bool configured;
static const char *scenario;

static unsigned long get_timer(unsigned long base);
static int aml_dnl_register(const char *name);
static void aml_dnl_unregister(void);
static int g_dnl_board_usb_cable_connected(void);
static int ctrlc(void);
static void usb_gadget_handle_interrupts(int index);

#include "vendor-adnl.c"

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s: failed %s at line %d (elapsed %lu ms)\n", \
                scenario, #condition, __LINE__, now_ms - 800); \
        exit(1); \
    } \
} while (0)

static unsigned long get_timer(unsigned long base)
{
    return now_ms - base;
}

static int aml_dnl_register(const char *name)
{
    assert(name);
    registrations++;
    return registration_error;
}

static void aml_dnl_unregister(void)
{
    unregistrations++;
}

static int g_dnl_board_usb_cable_connected(void)
{
    return 1;
}

static int ctrlc(void)
{
    return now_ms - 800 >= cancel_at;
}

static void usb_gadget_handle_interrupts(int index)
{
    assert(index == 0);
    now_ms++;
    if (now_ms - 800 >= connect_at)
        _sofintr_not_occur = 0;
    if (!configured && now_ms - 800 >= configure_at) {
        /* The function's set_alt callback clears this after endpoints are ready. */
        configured = true;
        adnl_enum_timeout = 0;
        adnl_identify_timeout = get_timer(0);
    }
}

static void setup(const char *name, unsigned int connect,
                  unsigned int configure, unsigned int cancel)
{
    scenario = name;
    now_ms = 800;
    connect_at = connect;
    configure_at = configure;
    cancel_at = cancel;
    registration_error = registrations = unregistrations = 0;
    configured = false;
}

int main(int argc, char **argv)
{
    unsigned int timeout;

    assert(argc == 2);
    timeout = strtoul(argv[1], NULL, 10);

    setup("old entry without SOF", 9000, 15000, 30000);
    CHECK(aml_v3_usbburning(1200, 0) == 2);
    CHECK(now_ms - 800 == 601 && !configured);
    CHECK(registrations == 1 && unregistrations == 1);

    setup("old entry with delayed configuration", 10, 15000, 30000);
    CHECK(aml_v3_usbburning(1200, 0) == 2);
    CHECK(now_ms - 800 == 1201 && !configured);
    CHECK(registrations == 1 && unregistrations == 1);

    setup("explicit recovery with delayed host", 9000, 15000, 30000);
    CHECK(aml_v3_usbburning(timeout, 0) == CMD_RET_SUCCESS);
    CHECK(now_ms - 800 == 30000 && configured);
    CHECK(registrations == 1 && unregistrations == 1);

    setup("explicit recovery without host", UINT_MAX, UINT_MAX, 30000);
    CHECK(aml_v3_usbburning(timeout, 0) == CMD_RET_SUCCESS);
    CHECK(now_ms - 800 == 30000 && !configured);
    CHECK(registrations == 1 && unregistrations == 1);

    setup("configured host clears finite timer", 10, 100, 5000);
    CHECK(aml_v3_usbburning(1200, 0) == CMD_RET_SUCCESS);
    CHECK(now_ms - 800 == 5000 && configured);
    CHECK(registrations == 1 && unregistrations == 1);

    setup("repeat explicit entry after finite entry", 9000, 15000, 30000);
    CHECK(aml_v3_usbburning(timeout, 0) == CMD_RET_SUCCESS);
    CHECK(now_ms - 800 == 30000 && configured);
    CHECK(registrations == 1 && unregistrations == 1);

    setup("registration error", 10, 100, 5000);
    registration_error = -19;
    CHECK(aml_v3_usbburning(timeout, 0) == -19);
    CHECK(now_ms == 800 && registrations == 1 && unregistrations == 0);

    puts("USB_RECOVERY_WAIT_BEHAVIOR_PASS: delayed host, absent host, cancellation, re-entry, errors");
    return 0;
}
