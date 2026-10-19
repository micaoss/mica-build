/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/


#ifndef __SKW_BTSNOOP_H__
#define __SKW_BTSNOOP_H__


#include <assert.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdbool.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <utils/Log.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>




/* HCI Packet types */
#define HCI_COMMAND_PKT		0x01
#define HCI_ACLDATA_PKT		0x02
#define HCI_SCODATA_PKT		0x03
#define HCI_EVENT_PKT		0x04
#define HCI_ISO_PKT		    0x05
#define HCI_EVENT_SKWLOG	0x07


void skw_btsnoop_init();
void skw_btsnoop_close(void);
void skw_btsnoop_capture(const uint8_t *packet, char is_received);




#endif
