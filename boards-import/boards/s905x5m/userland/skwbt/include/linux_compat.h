#ifndef LINUX_COMPAT_H
#define LINUX_COMPAT_H

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <termios.h>
#include <limits.h>

// Android property-system constants.
#define PROPERTY_KEY_MAX 32
#define PROPERTY_VALUE_MAX 92

// Android Bluetooth constants.
#define BT_HC_HDR_SIZE 16
#define HCI_CMD_MAX_LEN 258
#define HCI_CMD_PREAMBLE_SIZE 3
#define MSG_STACK_TO_HC_HCI_CMD 0x2000

// Bluetooth vendor-operation results.
#define BT_VND_OP_RESULT_SUCCESS 0
#define BT_VND_OP_RESULT_FAIL 1

// Bluetooth vendor power states.
#define BT_VND_PWR_OFF 0
#define BT_VND_PWR_ON 1

// HCI channel types.
#define CH_CMD 0
#define CH_EVT 1
#define CH_ACL_OUT 2
#define CH_ACL_IN 3
#define CH_MAX 4

// Bluetooth vendor operation codes.
typedef enum {
    BT_VND_OP_POWER_CTRL,
    BT_VND_OP_FW_CFG,
    BT_VND_OP_SCO_CFG,
    BT_VND_OP_USERIAL_OPEN,
    BT_VND_OP_USERIAL_CLOSE,
    BT_VND_OP_GET_LPM_IDLE_TIMEOUT,
    BT_VND_OP_LPM_SET_MODE,
    BT_VND_OP_LPM_WAKE_SET_STATE,
    BT_VND_OP_SET_AUDIO_STATE,
    BT_VND_OP_EPILOG,
    BT_VND_OP_A2DP_OFFLOAD_START,
    BT_VND_OP_A2DP_OFFLOAD_STOP
} bt_vendor_opcode_t;

// Minimal Android logging replacements.
#define ALOGV(fmt, ...) printf("[VERBOSE] " fmt "\n", ##__VA_ARGS__)
#define ALOGD(fmt, ...) printf("[DEBUG] " fmt "\n", ##__VA_ARGS__)
#define ALOGI(fmt, ...) printf("[INFO] " fmt "\n", ##__VA_ARGS__)
#define ALOGW(fmt, ...) printf("[WARN] " fmt "\n", ##__VA_ARGS__)
#define ALOGE(fmt, ...) printf("[ERROR] " fmt "\n", ##__VA_ARGS__)
#define ALOGF(fmt, ...) printf("[FATAL] " fmt "\n", ##__VA_ARGS__)

// Minimal property-system replacement.
static inline int property_get(const char* key, char* value, const char* default_value) {
    (void)key;
    if (default_value)
        strncpy(value, default_value, PROPERTY_VALUE_MAX-1);
    else
        value[0] = '\0';
    return strlen(value);
}

static inline int property_set(const char* key, const char* value) {
    (void)key; (void)value;
    return 0;
}

// Minimal Bluetooth type definitions.
typedef struct {
    uint16_t event;
    uint16_t len;
    uint16_t offset;
    uint16_t layer_specific;
    uint8_t data[];
} HC_BT_HDR;

// Bluetooth vendor callback types.
typedef void (*tINT_CMD_CBACK)(void *p_mem);
typedef void (*tINT_CMD_CPLT_CBACK)(void *p_mem);

// Bluetooth vendor callback interface.
typedef struct {
    size_t size;
    void* (*alloc)(int size);
    void (*dealloc)(void *p_buf);
    uint8_t (*xmit_cb)(uint16_t opcode, void *p_buf, tINT_CMD_CPLT_CBACK p_cback);
    void (*epilog_cb)(uint8_t status);
    void (*a2dp_offload_cb)(int op, int codec_type, int sample_rate);
    void (*fwcfg_cb)(uint8_t status);
} bt_vendor_callbacks_t;

// Bluetooth vendor interface.
typedef struct {
    size_t size;
    int (*init)(const bt_vendor_callbacks_t* p_cb, unsigned char *local_bdaddr);
    int (*op)(bt_vendor_opcode_t opcode, void *param);
    void (*cleanup)(void);
} bt_vendor_interface_t;

#endif // LINUX_COMPAT_H
