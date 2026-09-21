/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

#ifndef __BT_VENDOR_SKW_H__
#define __BT_VENDOR_SKW_H__


#include "bt_vendor_lib.h"
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <unistd.h>
#include <ctype.h>
#include <cutils/properties.h>


#define SKW_LIBBT_VERSION "0.2"

#define SKWBT_TRANS_TYPE_H4          0x01
#define SKWBT_TRANS_TYPE_UART        0x10
#define SKWBT_TRANS_TYPE_SDIO        0x20
#define SKWBT_TRANS_TYPE_USB         0x40


#define SKW_CHIPID_6316       0x5301
#define SKW_CHIPID_6160       0x0017
#define SKW_CHIPID_6160_LITE  0x5302


//#define IOCTL_CMD_WAKEUP_ADV_EN 0x01
#define IOCTL_CMD_LOG_EN_GET    _IOWR('S', 2, uint8_t *)

#ifndef FALSE
#define FALSE  0
#endif

#ifndef TRUE
#define TRUE   1
#endif


extern bt_vendor_callbacks_t *bt_vendor_cbacks;
extern char skwbt_transtype;
extern char skwbtuartonly;
extern char skwbtNoSleep;
extern int  btboot_fp;
extern int  btpw_fp;

#endif /*BT_UNUSED_H*/
