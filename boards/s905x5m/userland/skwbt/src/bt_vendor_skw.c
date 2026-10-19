/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

/******************************************************************************
 *
 *  Filename:      bt_vendor_skw.c
 *
 *  Description:   SeekWave vendor specific library implementation
 *
 ******************************************************************************/

#undef NDEBUG
#define LOG_TAG "libbt_vendor"


#include <utils/Log.h>
#include "bt_vendor_skw.h"
#include "scom_vendor.h"
#include "skw_btsnoop.h"
#include "skw_log.h"
#include "skw_common.h"
#ifdef SKW_LEGACY_FW_CFG
#include "skw_gen_addr.h"
#include "skw_ext.h"
#include <cutils/properties.h>
#endif

#ifndef SKWBT_CONFIG_FILE
#define SKWBT_CONFIG_FILE       "/vendor/etc/bluetooth/skwbt.conf"
#endif

bt_vendor_callbacks_t *bt_vendor_cbacks = NULL;
uint8_t vnd_local_bd_addr[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
uint8_t port_cnts = 0;

char skwbt_transtype = 0;
static char skwbt_device_node[BT_COM_PORT_SIZE][DEVICE_NODE_MAX_LEN];

int  btboot_fp = -1;
int  btpw_fp = -1;
char btsnoop_log_en = FALSE;
char btcp_log_en = FALSE;
char skwlog_slice = FALSE;
char skwdriverlog_en = TRUE;
char skwbtuartonly = TRUE;
char skwbtNoSleep = FALSE; //No Sleep

extern char skw_btsnoop_path[];
extern char btsnoop_save_log;
#ifdef SKW_LEGACY_FW_CFG
extern Wakeup_ADV_Info_St   wakeup_ADV_Info;
#endif

static char *trim(char *str)
{
    while (isspace(*str))
    {
        ++str;
    }

    if (!*str)
    {
        return str;
    }

    char *end_str = str + strlen(str) - 1;
    while (end_str > str && isspace(*end_str))
    {
        --end_str;
    }

    end_str[1] = '\0';
    return str;
}


static void load_skwbt_conf()
{
    memset(skwbt_device_node, 0, sizeof(skwbt_device_node));
    FILE *fp = fopen(SKWBT_CONFIG_FILE, "rt");
    if (!fp)
    {
        //ALOGE("%s unable to open file '%s': %s", __func__, SKWBT_CONFIG_FILE, strerror(errno));
        strcpy(skwbt_device_node[0], "/dev/ttyS0");
        return ;
    }

    char *split;
    char line[1024];
    int port_index = BT_COM_PORT_CMDEVT;

    while (fgets(line, sizeof(line), fp))
    {
        char *line_ptr = trim(line);

        // Skip blank and comment lines.
        if (*line_ptr == '\0' || *line_ptr == '#' || *line_ptr == '[')
        {
            continue;
        }

        split = strchr(line_ptr, '=');
        if (!split)
        {
            ALOGE("%s no key/value separator found", __func__);
            fclose(fp);
            return;
        }

        *split = '\0';
        split ++;
        if(!strcmp(trim(line_ptr), "BtDeviceNode"))
        {
            int mode = O_RDWR;
#if 0
            if(strstr(split, "BTDATA"))
            {
                port_index = BT_COM_PORT_ACL;
            }
            else if(strstr(split, "BTAUDIO"))
            {
                port_index = BT_COM_PORT_AUDIO;
            }
            else if(strstr(split, "BTISOC"))
            {
                port_index = BT_COM_PORT_ISO;
            }
#endif
            strcpy(skwbt_device_node[port_index], trim(split));
            scomm_vendor_set_port_name(port_index, skwbt_device_node[port_index], mode);

            port_index ++;
        }
    }


    fclose(fp);

    skwbt_transtype = SKWBT_TRANS_TYPE_H4;
    if(skwbt_device_node[0][0] == '?')
    {
        int i = 0;
        while(skwbt_device_node[0][i] != '\0')
        {
            skwbt_device_node[0][i] = skwbt_device_node[0][i + 1];
            i++;
        }
        scomm_vendor_set_port_name(0, skwbt_device_node[0], O_RDWR);
        skwbt_transtype |= SKWBT_TRANS_TYPE_UART;
    }
}

char skwbt_boot_open()
{
    btboot_fp = open("/dev/BTBOOT", O_RDWR);
    if (btboot_fp < 0)
    {
        ALOGE("%s: unable to open : %s", __func__, strerror(errno));
        return FALSE;
    }
    return TRUE;
}


static void load_skwbt_stack_conf()
{
    FILE *fp = fopen(SKWBT_CONFIG_FILE, "rt");
    if (!fp)
    {
        ALOGE("%s unable to open file '%s': %s", __func__, SKWBT_CONFIG_FILE, strerror(errno));
        return;
    }
    char *split;
    int line_num = 0;
    char line[1024];
    while (fgets(line, sizeof(line), fp))
    {
        char *line_ptr = trim(line);
        ++line_num;

        // Skip blank and comment lines.
        if (*line_ptr == '\0' || *line_ptr == '#' || *line_ptr == '[')
        {
            continue;
        }

        split = strchr(line_ptr, '=');
        if (!split)
        {
            ALOGE("%s no key/value separator found on line %d.", __func__, line_num);
            continue;
        }

        *split = '\0';

        if(!strcmp(trim(line_ptr), "SkwBtsnoopDump"))
        {
            if(!strcmp(trim(split + 1), "true"))
            {
                btsnoop_log_en = TRUE;
            }
            else
            {
                btsnoop_log_en = FALSE;
            }
        }
        else if(!strcmp(trim(line_ptr), "BtSnoopFileName"))
        {
            sprintf(skw_btsnoop_path, "%s", trim(split + 1));
        }
        else if(!strcmp(trim(line_ptr), "BtSnoopSaveLog"))
        {
            if(!strcmp(trim(split + 1), "true"))
            {
                btsnoop_save_log = TRUE;
            }
            else
            {
                btsnoop_save_log = FALSE;
            }
        }
        else if(!strcmp(trim(line_ptr), "SkwBtcplog"))
        {
            if(!strcmp(trim(split + 1), "true"))
            {
                btcp_log_en = TRUE;
            }
            else
            {
                btcp_log_en = FALSE;
            }
        }
        else if(!strcmp(trim(line_ptr), "SkwLogSlice"))
        {
            if(!strcmp(trim(split + 1), "true"))
            {
                skwlog_slice = TRUE;
            }
            else
            {
                skwlog_slice = FALSE;
            }
        }
        else if(!strcmp(trim(line_ptr), "SkwBtDrvlog"))
        {
            if(!strcmp(trim(split + 1), "false"))
            {
                skwdriverlog_en = FALSE;
            }
        }
        else if(!strcmp(trim(line_ptr), "SkwBtUartOnly"))
        {
            if(!strcmp(trim(split + 1), "false"))//SkwBtUartOnly is false
            {
                skwbtuartonly = FALSE;
            }
        }
        else if(!strcmp(trim(line_ptr), "SkwBtNoSleep"))
        {
            if(strcmp(trim(split + 1), "true") == 0)//SkwBtNoSleep is true
            {
                skwbtNoSleep = TRUE;
            }
        }
#ifdef SKW_LEGACY_FW_CFG
        else if(!strcmp(trim(line_ptr), "WakeupADVData"))
        {
            char *data_str = trim(split + 1);
            if(data_str)
            {
                scomm_vendor_parse_wakeup_adv_conf(data_str);
            }
        }
#endif


    }

    fclose(fp);
}




/*****************************************************************************
**
**   BLUETOOTH VENDOR INTERFACE LIBRARY FUNCTIONS
**
*****************************************************************************/



/** initialise **/
static int init(const bt_vendor_callbacks_t *p_cb, unsigned char *local_bdaddr)
{
    ALOGI("SeekWave BlueTooth Version: %s", SKW_LIBBT_VERSION);
    if (p_cb == NULL)
    {
        ALOGE("init failed with no user callbacks!");
        return -1;
    }

    scomm_vendor_init();

    load_skwbt_conf();
    load_skwbt_stack_conf();
    skwlog_init();


    bt_vendor_cbacks = (bt_vendor_callbacks_t *) p_cb;//save callback
    memcpy(vnd_local_bd_addr, local_bdaddr, 6);

    if(btsnoop_log_en)
    {
        //enable btsnoop log
        skw_btsnoop_init();
    }
#ifdef SKW_LEGACY_FW_CFG
    skw_addr_gen_init();
#endif

    return 0;
}

/** operations **/
static int op(bt_vendor_opcode_t opcode, void *param)
{
    int retval = 0;

    ALOGD("op for %d", opcode);

    switch(opcode)
    {
        case BT_VND_OP_POWER_CTRL:
        {
            if(skwbt_transtype & SKWBT_TRANS_TYPE_UART)
            {
                int *state = (int *) param;
                if (*state == BT_VND_PWR_OFF)
                {
                    usleep(200000);
                    ALOGD("set power off and delay 200ms");
                }
                else if (*state == BT_VND_PWR_ON)
                {
                    usleep(200000);
                    ALOGD("set power on and delay 1000ms");
                }
            }
        }
        break;

        case BT_VND_OP_FW_CFG:
        {
#ifdef SKW_LEGACY_FW_CFG
            scomm_vendor_config_start();
#else
            if (bt_vendor_cbacks->fwcfg_cb)
                bt_vendor_cbacks->fwcfg_cb(BT_VND_OP_RESULT_SUCCESS);
#endif
        }
        break;

        case BT_VND_OP_SCO_CFG:
        {
            retval = -1;
        }
        break;

        case BT_VND_OP_USERIAL_OPEN:
        {
            int fd = -1, idx = 0;
            int (*fd_array)[] = (int (*)[]) param;


            if(skwbt_transtype & SKWBT_TRANS_TYPE_UART)
            {
                if(skwbtuartonly == FALSE)
                {
                    SKWBT_LOG("open boot");
                    if(!skwbt_boot_open())
                    {
                        retval = 0;
                        break;
                    }
                    btpw_fp = open("/dev/BTDATA", O_RDWR);
                }
                if(scomm_vendor_uart_open(0) != -1)
                {
                    retval = 1;
                    fd = scomm_vendor_socket_open(0);
                }
            }
            else
            {
                int tFd = -1;
                int open_failed = FALSE;
                uint8_t log_enable = 0;
                if(!skwbt_boot_open())
                {
                    retval = 0;
                    break;
                }
                if(ioctl(btboot_fp, IOCTL_CMD_LOG_EN_GET, &log_enable) == 0)
                {
                    ALOGD("SKWBT log_enable res:%d, btcp_log_en:%d, btsnoop_log_en:%d", log_enable, btcp_log_en, btsnoop_log_en);
                    if(btcp_log_en && log_enable)//0:default, 1:release version; 2:debug version
                    {
                        btcp_log_en = log_enable == 2;
                    }
                    if(btsnoop_log_en && log_enable)
                    {
                        btsnoop_log_en = log_enable == 2;
                    }
                }
#if defined(SKW_LEGACY_FW_CFG) && defined(IOCTL_CMD_WAKEUP_ADV_EN)
                if(wakeup_ADV_Info.grp_nums > 0)
                {
                    int res = ioctl(btboot_fp, IOCTL_CMD_WAKEUP_ADV_EN);
                    ALOGD("%s, wakeup adv en res:%d", __func__, res);
                }
#endif
                for (idx = 0; idx < BT_COM_PORT_SIZE; idx++)
                {
                    if(scomm_vendor_check_port_valid(idx) == FALSE)
                    {
                        continue;
                    }
                    if(scomm_vendor_usbsdio_open(idx) != -1)
                    {
                        tFd = scomm_vendor_socket_open(idx);

                        ALOGD("idx:%d, tFd:%d, fd:%d", idx, tFd, fd);
                        if(tFd == -1)
                        {
                            open_failed = TRUE;
                            break;
                        }
                        if(fd == -1)
                        {
                            fd = tFd;
                        }
                    }
                    else
                    {
                        open_failed = TRUE;
                        break;
                    }
                }

                if(open_failed)
                    fd = -1;

                if(idx <= BT_COM_PORT_ACL)
                {
                    skwbt_transtype |= SKWBT_TRANS_TYPE_USB;
                }
                else
                {
                    skwbt_transtype |= SKWBT_TRANS_TYPE_SDIO;
                }
            }
            ALOGD("retval:%d, fd:%d, idx:%d", retval, fd, idx);

            if (fd != -1)
            {
                retval = 1;
                for (idx = 0; idx < CH_MAX; idx++)
                {
                    (*fd_array)[idx] = fd;
                }
#ifdef SKW_LEGACY_FW_CFG
                skw_ext_inotify_thread_init();
                property_set("SKWBT.OPEN.STATE", "1");
#endif
            }
            else
            {
                retval = 0;
            }
        }
        break;

        case BT_VND_OP_USERIAL_CLOSE:
        {
            if(btboot_fp > 0)
            {
                scomm_vendor_write_bt_state();
                close(btboot_fp);
                btboot_fp = -1;
            }
            scomm_vendor_close();
#ifdef SKW_LEGACY_FW_CFG
            skw_ext_inotify_thread_exit();
            property_set("SKWBT.OPEN.STATE", "0");
#endif
        }
        break;

        case BT_VND_OP_GET_LPM_IDLE_TIMEOUT:
        {

        }
        break;

        case BT_VND_OP_LPM_SET_MODE:
        {

        }
        break;

        case BT_VND_OP_LPM_WAKE_SET_STATE:
        {

        }
        break;
        case BT_VND_OP_EPILOG:
        {
            if(bt_vendor_cbacks)
            {
                bt_vendor_cbacks->epilog_cb(BT_VND_OP_RESULT_SUCCESS);
            }
        }
        break;

        default:
            break;
    }

    return retval;
}


/** Close **/
static void cleanup( void )
{
    ALOGD("bt_vendor_skw.c cleanup");

    if(btsnoop_log_en)
    {
        skw_btsnoop_close();
    }
    skwlog_close();

    btsnoop_log_en = FALSE;
    bt_vendor_cbacks = NULL;
    skwbt_transtype = 0;
}



// Entry point
const bt_vendor_interface_t BLUETOOTH_VENDOR_LIB_INTERFACE = {sizeof(bt_vendor_interface_t),
                                                              init,
                                                              op,
                                                              cleanup
                                                             };
