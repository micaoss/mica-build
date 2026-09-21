/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

#ifndef __SCOM_VENDOR_H__
#define __SCOM_VENDOR_H__

#include <pthread.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/types.h>
#include <termios.h>


/* Structure used to configure serial port during open */
typedef struct
{
    uint16_t fmt;       /* Data format */
    uint8_t  baud;      /* Baud rate */
    uint8_t hw_fctrl; /*hardware flowcontrol*/
} tUSERIAL_CFG;


/* Hardware Configuration State */
enum {
	HW_CFG_INIT = 0x00,
    HW_CFG_START,
    HW_CFG_WRITE_OS_TYPE,
    HW_CFG_READ_HCI_VERSION,
    HW_CFG_NV_SEND,
    HW_CFG_NV_SEND_CMPL,
    HW_CFG_WRITE_BD_ADDR,
    HW_CFG_WRITE_WAKEUP_ADV_DATA,
    HW_RESET_CONTROLLER,
    HARDWARE_INIT_COMPLETE
};

#define HCI_CMD_MAX_LEN       258

#define NV_FILE_RD_BLOCK_SIZE 252
#define DEVICE_NODE_MAX_LEN   64

#define NV_TAG_BD_ADDR          0x01
#define NV_TAG_DSP_LOG_SETTING  0x05

enum{
	BT_COM_PORT_CMDEVT = 0x0,//CMD/Evet, in case of UART:ACL + AUDIO
	BT_COM_PORT_ACL,//ACL IN/OUT
	BT_COM_PORT_AUDIO,//AUDIO IN/OUT
	BT_COM_PORT_ISO,
	BT_COM_PORT_SIZE
};


typedef struct
{
    uint32_t    baudrate; //for UART
    uint8_t     state;          /* Hardware configuration state mechine*/
	uint8_t     file_offset;//for nv
	FILE *      nv_fp;
} bt_hw_cfg_cb_st;

typedef struct
{
    int fd;                     //
    int uart_fd[2];
    int signal_fd[2];
    int epoll_fd;
    struct termios termios;     /* serial terminal of BT port */
    char port_name[DEVICE_NODE_MAX_LEN];
    pthread_t thread_socket_id;
    pthread_t thread_uart_id;
    bool thread_socket_started;
    bool thread_uart_started;
    atomic_bool thread_running;
    atomic_bool recv_comm_thread_running;
	atomic_bool is_busying;
	char read_retry;

	atomic_bool driver_state;
	int mode;
} scomm_vnd_st;

typedef struct{
  int  fd;                              // the file descriptor to monitor for events.
  void *context;                       // a context that's passed back to the *_ready functions..
  pthread_mutex_t lock;                // protects the lifetime of this object and all variables.

  void (*read_ready)(void *context);   // function to call when the file descriptor becomes readable.
  void (*write_ready)(void *context);  // function to call when the file descriptor becomes writeable.
}skw_socket_object_st;



#define HCI_CMD_PREAMBLE_SIZE                    3
#define HCI_EVT_CMD_CMPL_OPCODE_OFFSET           3     //opcode's offset in HCI_Command_Complete Event
#define HCI_EVT_CMD_CMPL_STATUS_OFFSET           5     //status's offset in HCI_Command_Complete Event



/*
 *  Definitions for HCI groups
*/
#define HCI_GRP_LINK_CONTROL_CMDS (0x01 << 10)       /* 0x0400 */
#define HCI_GRP_LINK_POLICY_CMDS (0x02 << 10)        /* 0x0800 */
#define HCI_GRP_HOST_CONT_BASEBAND_CMDS (0x03 << 10) /* 0x0C00 */
#define HCI_GRP_INFORMATIONAL_PARAMS (0x04 << 10)    /* 0x1000 */
#define HCI_GRP_STATUS_PARAMS (0x05 << 10)           /* 0x1400 */
#define HCI_GRP_TESTING_CMDS (0x06 << 10)            /* 0x1800 */
#define HCI_GRP_BLE_CMDS (0x08 << 10)               /* 0x2000 (LE Commands) */

#define HCI_GRP_VENDOR_SPECIFIC (0x3F << 10) /* 0xFC00 */

/* Group occupies high 6 bits of the HCI command rest is opcode itself */
#define HCI_OGF(p) (uint8_t)((0xFC00 & (p)) >> 10)
#define HCI_OCF(p) (0x3FF & (p))


#define HCI_RESET                       (0x0003 | HCI_GRP_HOST_CONT_BASEBAND_CMDS)
#define HCI_READ_LOCAL_VERSION_INFO     (0x0001 | HCI_GRP_INFORMATIONAL_PARAMS)

#define HCI_CMD_SKW_BT_NVDS             0xFC80
#define HCI_CMD_WRITE_BD_ADDR           0xFC82
#define HCI_CMD_WRITE_OS_TYPE           0xFC83
#define HCI_CMD_WRITE_WAKEUP_ADV_DATA   0xFC84
#define HCI_CMD_WRITE_WAKEUP_ADV_ENABLE 0xFC85


#define HCI_COMMAND_COMPLETE_EVENT      0x0E
#define HCI_COMMAND_STATUS_EVENT        0x0F
#define HCI_HARDWARE_ERROR_EVENT        0x10

#define HWERR_CODE_CP_ERROR             0x10

#define CP_ERR_ENOTCONN -107 //Transport endpoint


#define HCI_COMMAND_PKT_PREAMBLE_SIZE		0x03
#define HCI_ACLDATA_PKT_PREAMBLE_SIZE		0x04
#define HCI_SCODATA_PKT_PREAMBLE_SIZE		0x03
#define HCI_EVENT_PKT_PREAMBLE_SIZE  		0x02
#define HCI_ISODATA_PKT_PREAMBLE_SIZE		0x04
#define HCI_EVENT_SKWLOG_PREAMBLE_SIZE  	0x03

#define HCI_COMMON_DATA_LENGTH_INDEX  0x03
#define HCI_EVENT_DATA_LENGTH_INDEX   0x02
#define HCI_SKWLOG_DATA_LENGTH_INDEX  0x02



//---------------------UART Para Start-------------------------//

/**** baud rates ****/
#define USERIAL_BAUD_300        0
#define USERIAL_BAUD_600        1
#define USERIAL_BAUD_1200       2
#define USERIAL_BAUD_2400       3
#define USERIAL_BAUD_9600       4
#define USERIAL_BAUD_19200      5
#define USERIAL_BAUD_57600      6
#define USERIAL_BAUD_115200     7
#define USERIAL_BAUD_230400     8
#define USERIAL_BAUD_460800     9
#define USERIAL_BAUD_921600     10
#define USERIAL_BAUD_1M         11
#define USERIAL_BAUD_1_5M       12
#define USERIAL_BAUD_2M         13
#define USERIAL_BAUD_3M         14
#define USERIAL_BAUD_4M         15
#define USERIAL_BAUD_AUTO       16

/**** Data Format ****/
/* Stop Bits */
#define USERIAL_STOPBITS_1      1
#define USERIAL_STOPBITS_1_5    (1<<1)
#define USERIAL_STOPBITS_2      (1<<2)

/* Parity Bits */
#define USERIAL_PARITY_NONE     (1<<3)
#define USERIAL_PARITY_EVEN     (1<<4)
#define USERIAL_PARITY_ODD      (1<<5)

/* Data Bits */
#define USERIAL_DATABITS_5      (1<<6)
#define USERIAL_DATABITS_6      (1<<7)
#define USERIAL_DATABITS_7      (1<<8)
#define USERIAL_DATABITS_8      (1<<9)


#define USERIAL_HW_FLOW_CTRL_OFF  0
#define USERIAL_HW_FLOW_CTRL_ON    1


//---------------------UART Para End-------------------------//



void scomm_vendor_init();

void scomm_vendor_set_port_name(uint8_t port_index, char *port_name, int mode);

uint8_t scomm_vendor_check_port_valid(uint8_t port_index);

int scomm_vendor_uart_open(uint8_t port_index);

int scomm_vendor_usbsdio_open(uint8_t port_index);

int scomm_vendor_socket_open(uint8_t port_index);

void scomm_vendor_close();

void scomm_vendor_write_bt_state();

#ifdef SKW_LEGACY_FW_CFG
void scomm_vendor_config_start();

void scomm_vendor_parse_wakeup_adv_conf(char *data_str);
#endif


#endif
