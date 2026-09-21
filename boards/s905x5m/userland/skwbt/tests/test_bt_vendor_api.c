#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "include/linux_compat.h"
#include "include/bt_vendor_skw.h"
#include "include/scom_vendor.h"

#define CHECK(condition)                                                      \
    do {                                                                      \
        if (!(condition)) {                                                   \
            fprintf(stderr, "FAIL %s:%d: %s\n", __func__, __LINE__,          \
                    #condition);                                              \
            return 1;                                                         \
        }                                                                     \
    } while (0)

#define SKWBT_CONFIG_FILE "/nonexistent/skwbt.conf"

char skw_btsnoop_path[1024];
char btsnoop_save_log;

static int transport_init_count;
static int transport_close_count;
static int log_init_count;
static int log_close_count;
static int fwcfg_count;
static int epilog_count;
static int xmit_count;
static uint8_t fwcfg_status;
static uint8_t epilog_status;

void scomm_vendor_init(void) { transport_init_count++; }
void scomm_vendor_set_port_name(uint8_t index, char *name, int mode)
{
    (void)index;
    (void)name;
    (void)mode;
}
uint8_t scomm_vendor_check_port_valid(uint8_t index)
{
    (void)index;
    return FALSE;
}
int scomm_vendor_uart_open(uint8_t index) { (void)index; return -1; }
int scomm_vendor_usbsdio_open(uint8_t index) { (void)index; return -1; }
int scomm_vendor_socket_open(uint8_t index) { (void)index; return -1; }
void scomm_vendor_close(void) { transport_close_count++; }
void scomm_vendor_write_bt_state(void) { }

void skw_btsnoop_init(void) { }
void skw_btsnoop_close(void) { }
void skwlog_init(void) { log_init_count++; }
void skwlog_close(void) { log_close_count++; }

static void *mock_alloc(int size) { return malloc((size_t)size); }
static void mock_dealloc(void *buffer) { free(buffer); }
static uint8_t mock_xmit(uint16_t opcode, void *buffer,
                         tINT_CMD_CPLT_CBACK callback)
{
    (void)opcode;
    (void)buffer;
    (void)callback;
    xmit_count++;
    return TRUE;
}
static void mock_epilog(uint8_t status)
{
    epilog_count++;
    epilog_status = status;
}
static void mock_fwcfg(uint8_t status)
{
    fwcfg_count++;
    fwcfg_status = status;
}
static void mock_a2dp(int op, int codec, int rate)
{
    (void)op;
    (void)codec;
    (void)rate;
}

#include "../src/bt_vendor_skw.c"

int main(void)
{
    const bt_vendor_callbacks_t callbacks = {
        .size = sizeof(bt_vendor_callbacks_t),
        .alloc = mock_alloc,
        .dealloc = mock_dealloc,
        .xmit_cb = mock_xmit,
        .epilog_cb = mock_epilog,
        .fwcfg_cb = mock_fwcfg,
        .a2dp_offload_cb = mock_a2dp,
    };
    unsigned char address[6] = { 0x02, 0xad, 0x47, 0x01, 0x36, 0xd8 };

    CHECK(BLUETOOTH_VENDOR_LIB_INTERFACE.init(NULL, address) == -1);
    CHECK(BLUETOOTH_VENDOR_LIB_INTERFACE.init(&callbacks, address) == 0);
    CHECK(transport_init_count == 1);
    CHECK(log_init_count == 1);
    CHECK(memcmp(vnd_local_bd_addr, address, sizeof(address)) == 0);

    CHECK(BLUETOOTH_VENDOR_LIB_INTERFACE.op(BT_VND_OP_FW_CFG, NULL) == 0);
    CHECK(fwcfg_count == 1);
    CHECK(fwcfg_status == BT_VND_OP_RESULT_SUCCESS);
    CHECK(xmit_count == 0);

    CHECK(BLUETOOTH_VENDOR_LIB_INTERFACE.op(BT_VND_OP_EPILOG, NULL) == 0);
    CHECK(epilog_count == 1);
    CHECK(epilog_status == BT_VND_OP_RESULT_SUCCESS);

    CHECK(BLUETOOTH_VENDOR_LIB_INTERFACE.op(BT_VND_OP_USERIAL_CLOSE, NULL) == 0);
    CHECK(transport_close_count == 1);

    BLUETOOTH_VENDOR_LIB_INTERFACE.cleanup();
    CHECK(log_close_count == 1);
    CHECK(bt_vendor_cbacks == NULL);

    puts("vendor API tests passed");
    return 0;
}
