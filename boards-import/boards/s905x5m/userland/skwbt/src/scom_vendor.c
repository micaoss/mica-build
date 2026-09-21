/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

/******************************************************************************
 *
 *  Filename:      scom_vendor.c
 *
 *  Description:   serials communication operation
 *
 ******************************************************************************/

#include <pthread.h>
#include <utils/Log.h>
#include <termios.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <sys/eventfd.h>
#include <cutils/sockets.h>
#include <poll.h>
#include "scom_vendor.h"
#include "skw_h4.h"
#include "bt_hci_bdroid.h"
#include "skw_common.h"
#include "bt_vendor_skw.h"
#include "skw_btsnoop.h"
#include "skw_log.h"
#ifdef SKW_LEGACY_FW_CFG
#include "skw_gen_addr.h"
#include "skw_ext.h"
#endif



scomm_vnd_st         scomm_vnd[BT_COM_PORT_SIZE];
skw_socket_object_st skw_socket_object;
static pthread_mutex_t write2host_lock;
static struct skw_h4_stream host_stream;
#ifdef SKW_LEGACY_FW_CFG
bt_hw_cfg_cb_st      hw_cfg_cb;
uint16_t             chip_version = 0;
Wakeup_ADV_Info_St   wakeup_ADV_Info = {0};
#endif
extern char btcp_log_en;

static int set_nonblocking_cloexec(int fd)
{
    int flags = fcntl(fd, F_GETFL);

    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
        return -1;
    flags = fcntl(fd, F_GETFD);
    if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0)
        return -1;
    return 0;
}

static void close_owned_fd(int *fd)
{
    int owned = *fd;

    *fd = -1;
    if (owned >= 0 && close(owned) < 0)
        ALOGE("close fd %d failed: %s", owned, strerror(errno));
}

static void wake_port(scomm_vnd_st *scomm)
{
    const uint8_t wake = 1;

    if (scomm->signal_fd[0] >= 0)
        (void)send(scomm->signal_fd[0], &wake, sizeof(wake),
                   MSG_DONTWAIT | MSG_NOSIGNAL);
}

static void scomm_vendor_fail_transport(uint8_t failed_port)
{
    scomm_vnd_st *failed = &scomm_vnd[failed_port];

    ALOGE("transport failure on port %u", failed_port);
    atomic_store(&failed->driver_state, false);
    atomic_store(&failed->thread_running, false);
    wake_port(failed);
    if (failed->uart_fd[1] >= 0)
        (void)shutdown(failed->uart_fd[1], SHUT_RDWR);

    if (failed_port != BT_COM_PORT_CMDEVT)
    {
        scomm_vnd_st *host = &scomm_vnd[BT_COM_PORT_CMDEVT];

        atomic_store(&host->driver_state, false);
        atomic_store(&host->thread_running, false);
        wake_port(host);
        if (host->uart_fd[1] >= 0)
            (void)shutdown(host->uart_fd[1], SHUT_RDWR);
    }
}

static int write_transport(scomm_vnd_st *scomm, int fd,
                           const uint8_t *buffer, size_t length,
                           bool socket_output)
{
    size_t written = 0;

    while (written < length && atomic_load(&scomm->thread_running))
    {
        ssize_t ret = socket_output
            ? send(fd, buffer + written, length - written, MSG_NOSIGNAL)
            : write(fd, buffer + written, length - written);

        if (ret > 0)
        {
            written += (size_t)ret;
            continue;
        }
        if (ret < 0 && errno == EINTR)
            continue;
        if (ret < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
        {
            struct pollfd pfd = { .fd = fd, .events = POLLOUT };
            int ready;

            do
            {
                ready = poll(&pfd, 1, 500);
            } while (ready < 0 && errno == EINTR &&
                     atomic_load(&scomm->thread_running));
            if (!atomic_load(&scomm->thread_running))
                return -1;
            if (ready >= 0 && !(pfd.revents & (POLLERR | POLLHUP | POLLNVAL)))
                continue;
        }
        if (ret == 0)
            errno = EIO;
        return -1;
    }

    return written == length ? 0 : -1;
}


#ifdef SKW_LEGACY_FW_CFG
#ifndef SKWBT_NV_FILE_PATH
#define SKWBT_NV_FILE_PATH       "/vendor/etc/bluetooth"
#endif
#endif


static tUSERIAL_CFG userial_H4_cfg =
{
    (USERIAL_DATABITS_8 | USERIAL_PARITY_NONE | USERIAL_STOPBITS_1),
    //USERIAL_BAUD_115200,
    USERIAL_BAUD_3M,
    //USERIAL_BAUD_1_5M,
    USERIAL_HW_FLOW_CTRL_ON
};


char hex2char(int num)
{
    char ch;
    if(num >= 0 && num <= 9)
    {
        ch = num + 48;
    }
    else if(num > 9 && num <= 15)
    {
        ch = (num - 10) + 65;
    }
    else
    {
        ch = '\0';
    }
    return ch;
}

void hex2String(unsigned char hex[], unsigned char str[], int N)
{
    int i = 0, j;
    for(i = 0, j = 0; i < N; i++, j += 2)
    {
        str[j] = hex2char((hex[i] & 0xF0) >> 4);
        str[j + 1] = hex2char(hex[i] & 0x0F);
    }
    str[N << 1] = 0;
}

#ifdef SKW_LEGACY_FW_CFG
static unsigned char char2hex(char ch)
{
    unsigned char num = 0;
    if(ch >= '0' && ch <= '9')
    {
        num = ch - 48;//0:48
    }
    else if(ch >= 'a' && ch <= 'f')
    {
        num = ch + 10 - 97;//a:97
    }
    else if(ch >= 'A' && ch <= 'F')
    {
        num = ch + 10 - 65;//A:65
    }
    return num;
}
#endif

void scomm_vendor_init()
{
    uint8_t i;
    memset(&host_stream, 0, sizeof(host_stream));
    for(i = 0; i < BT_COM_PORT_SIZE; i++)
    {
        memset(&scomm_vnd[i], 0, sizeof(scomm_vnd_st));
        scomm_vnd[i].fd           = -1;
        scomm_vnd[i].uart_fd[0]   = -1;
        scomm_vnd[i].uart_fd[1]   = -1;
        scomm_vnd[i].signal_fd[0] = -1;
        scomm_vnd[i].signal_fd[1] = -1;
        scomm_vnd[i].epoll_fd     = -1;
        atomic_init(&scomm_vnd[i].thread_running, false);
        atomic_init(&scomm_vnd[i].recv_comm_thread_running, false);
        atomic_init(&scomm_vnd[i].is_busying, false);
        atomic_init(&scomm_vnd[i].driver_state, false);
        scomm_vnd[i].mode         = O_RDWR;
    }

    pthread_mutex_init(&write2host_lock, NULL);
}

void scomm_vendor_set_port_name(uint8_t port_index, char *port_name, int mode)
{
    memset(scomm_vnd[port_index].port_name, 0, DEVICE_NODE_MAX_LEN);
    memcpy(scomm_vnd[port_index].port_name, port_name, strlen(port_name));
    scomm_vnd[port_index].mode = mode;

    ALOGD("skwbt_device_node:%s, port:%d", port_name, port_index);
}


/*******************************************************************************
**
** Function        scomm_vendor_tcio_baud
**
** Description     helper function converts USERIAL baud rates into TCIO
**                  conforming baud rates
**
** Returns         TRUE/FALSE
**
*******************************************************************************/
uint8_t scomm_vendor_tcio_baud(uint8_t cfg_baud, uint32_t *baud)
{
    if (cfg_baud == USERIAL_BAUD_115200)
    {
        *baud = B115200;
    }
    else if (cfg_baud == USERIAL_BAUD_4M)
    {
        *baud = B4000000;
    }
    else if (cfg_baud == USERIAL_BAUD_3M)
    {
        *baud = B3000000;
    }
    else if (cfg_baud == USERIAL_BAUD_2M)
    {
        *baud = B2000000;
    }
    else if (cfg_baud == USERIAL_BAUD_1M)
    {
        *baud = B1000000;
    }
    else if (cfg_baud == USERIAL_BAUD_1_5M)
    {
        *baud = B1500000;
    }
    else if (cfg_baud == USERIAL_BAUD_921600)
    {
        *baud = B921600;
    }
    else if (cfg_baud == USERIAL_BAUD_460800)
    {
        *baud = B460800;
    }
    else if (cfg_baud == USERIAL_BAUD_230400)
    {
        *baud = B230400;
    }
    else if (cfg_baud == USERIAL_BAUD_57600)
    {
        *baud = B57600;
    }
    else if (cfg_baud == USERIAL_BAUD_19200)
    {
        *baud = B19200;
    }
    else if (cfg_baud == USERIAL_BAUD_9600)
    {
        *baud = B9600;
    }
    else if (cfg_baud == USERIAL_BAUD_1200)
    {
        *baud = B1200;
    }
    else if (cfg_baud == USERIAL_BAUD_600)
    {
        *baud = B600;
    }
    else
    {
        ALOGE( "userial vendor open: unsupported baud idx %i", cfg_baud);
        *baud = B115200;
        return FALSE;
    }

    return TRUE;
}


/*******************************************************************************
**
** Function        scomm_vendor_uart_open
**
** Description     Uart Open
**
** Returns         None
**
*******************************************************************************/
int scomm_vendor_uart_open(uint8_t port_index)
{
    tUSERIAL_CFG *p_cfg = &userial_H4_cfg;
    uint32_t baud;
    uint8_t data_bits;
    uint16_t parity;
    uint8_t stop_bits;

    scomm_vnd[port_index].fd = -1;

    if (!scomm_vendor_tcio_baud(p_cfg->baud, &baud))
    {
        return -1;
    }

    if(p_cfg->fmt & USERIAL_DATABITS_8)
    {
        data_bits = CS8;
    }
    else if(p_cfg->fmt & USERIAL_DATABITS_7)
    {
        data_bits = CS7;
    }
    else if(p_cfg->fmt & USERIAL_DATABITS_6)
    {
        data_bits = CS6;
    }
    else if(p_cfg->fmt & USERIAL_DATABITS_5)
    {
        data_bits = CS5;
    }
    else
    {
        ALOGE("userial vendor open: unsupported data bits");
        return -1;
    }

    if(p_cfg->fmt & USERIAL_PARITY_NONE)
    {
        parity = 0;
    }
    else if(p_cfg->fmt & USERIAL_PARITY_EVEN)
    {
        parity = PARENB;
    }
    else if(p_cfg->fmt & USERIAL_PARITY_ODD)
    {
        parity = (PARENB | PARODD);
    }
    else
    {
        ALOGE("userial vendor open: unsupported parity bit mode");
        return -1;
    }

    if(p_cfg->fmt & USERIAL_STOPBITS_1)
    {
        stop_bits = 0;
    }
    else if(p_cfg->fmt & USERIAL_STOPBITS_2)
    {
        stop_bits = CSTOPB;
    }
    else
    {
        ALOGE("userial vendor open: unsupported stop bits");
        return -1;
    }

    ALOGI("userial vendor open: opening %s,baud:%d", scomm_vnd[port_index].port_name, p_cfg->baud);

    if ((scomm_vnd[port_index].fd = open(scomm_vnd[port_index].port_name, O_RDWR)) == -1)
    {
        ALOGE("userial vendor open: unable to open %s, %s", scomm_vnd[port_index].port_name, strerror(errno));
        return -1;
    }
    if (set_nonblocking_cloexec(scomm_vnd[port_index].fd) < 0)
    {
        ALOGE("%s: unable to configure %s: %s", __func__,
              scomm_vnd[port_index].port_name, strerror(errno));
        close_owned_fd(&scomm_vnd[port_index].fd);
        return -1;
    }

    tcflush(scomm_vnd[port_index].fd, TCIOFLUSH);

    tcgetattr(scomm_vnd[port_index].fd, &scomm_vnd[port_index].termios);
    cfmakeraw(&scomm_vnd[port_index].termios);

    if(p_cfg->hw_fctrl == USERIAL_HW_FLOW_CTRL_ON)
    {
        ALOGI("userial vendor open: with HW flowctrl ON");
        scomm_vnd[port_index].termios.c_cflag |= (CRTSCTS | stop_bits | parity);
    }
    else
    {
        ALOGI("userial vendor open: with HW flowctrl OFF");
        scomm_vnd[port_index].termios.c_cflag &= ~CRTSCTS;
        scomm_vnd[port_index].termios.c_cflag |= (stop_bits | parity);

    }

    scomm_vnd[port_index].termios.c_cflag &= ~CSIZE;
    scomm_vnd[port_index].termios.c_cflag |= data_bits;

    tcsetattr(scomm_vnd[port_index].fd, TCSANOW, &scomm_vnd[port_index].termios);
    tcflush(scomm_vnd[port_index].fd, TCIOFLUSH);

    tcsetattr(scomm_vnd[port_index].fd, TCSANOW, &scomm_vnd[port_index].termios);
    tcflush(scomm_vnd[port_index].fd, TCIOFLUSH);
    tcflush(scomm_vnd[port_index].fd, TCIOFLUSH);

    /* set input/output baudrate */
    cfsetospeed(&scomm_vnd[port_index].termios, baud);
    cfsetispeed(&scomm_vnd[port_index].termios, baud);
    tcsetattr(scomm_vnd[port_index].fd, TCSANOW, &scomm_vnd[port_index].termios);


    ALOGE("UART device fd = %d Open", scomm_vnd[port_index].fd);


    return scomm_vnd[port_index].fd;

}


/*******************************************************************************
**
** Function        scomm_vendor_usbsdio_open
**
** Description     check port name valid
**
** Returns         None
**
*******************************************************************************/
uint8_t scomm_vendor_check_port_valid(uint8_t port_index)
{
    if(scomm_vnd[port_index].port_name[0] == 0)
    {
        return FALSE;
    }
    return TRUE;
}



/*******************************************************************************
**
** Function        scomm_vendor_usbsdio_open
**
** Description     USB/SDIO Open
**
** Returns         None
**
*******************************************************************************/
int scomm_vendor_usbsdio_open(uint8_t port_index)
{
    if ((scomm_vnd[port_index].fd = open(scomm_vnd[port_index].port_name, O_RDWR)) == -1)
    {
        ALOGE("%s: unable to open %s: %s", __func__, scomm_vnd[port_index].port_name, strerror(errno));
        return -1;
    }
    if (set_nonblocking_cloexec(scomm_vnd[port_index].fd) < 0)
    {
        ALOGE("%s: unable to configure %s: %s", __func__,
              scomm_vnd[port_index].port_name, strerror(errno));
        close_owned_fd(&scomm_vnd[port_index].fd);
        return -1;
    }
    ALOGD("USB/SDIO device[%d], %s fd = %d open", port_index, scomm_vnd[port_index].port_name, scomm_vnd[port_index].fd);

    return scomm_vnd[port_index].fd;
}


/*******************************************************************************
**
** Function        scomm_vendor_recv_rawdata
**
** Description     recv data from host and process
**
** Returns         None
**
*******************************************************************************/
uint8_t pkt_cnts = 0;
static int host_frame_allowed(const struct skw_h4_frame *frame)
{
    switch (frame->type)
    {
        case SKW_H4_COMMAND_PKT:
            return frame->frame_size <= SKW_H4_COMMAND_MAX_FRAME;
        case SKW_H4_ACL_PKT:
            return frame->frame_size <= SKW_H4_KERNEL_MAX_FRAME;
        case SKW_H4_SCO_PKT:
            return frame->frame_size <= SKW_H4_SCO_MAX_FRAME;
        case SKW_H4_ISO_PKT:
            return frame->frame_size <= SKW_H4_ISO_MAX_FRAME;
        default:
            return FALSE;
    }
}

static uint8_t host_frame_port(uint8_t pkt_type)
{
    if (!(skwbt_transtype & SKWBT_TRANS_TYPE_SDIO))
        return BT_COM_PORT_CMDEVT;

    switch (pkt_type)
    {
        case SKW_H4_ACL_PKT:
            return BT_COM_PORT_ACL;
        case SKW_H4_SCO_PKT:
            return BT_COM_PORT_AUDIO;
        case SKW_H4_ISO_PKT:
            return BT_COM_PORT_ISO;
        default:
            return BT_COM_PORT_CMDEVT;
    }
}

static int send_host_frame_to_device(const uint8_t *buffer, size_t length)
{
    uint8_t str_buffer[129] = {0};
    uint8_t send_port = host_frame_port(buffer[0]);
    scomm_vnd_st *destination = &scomm_vnd[send_port];

    hex2String((unsigned char *)buffer, str_buffer,
               (int)(length > 64 ? 64 : length));
    SKWBT_LOG("total_len:%zu, port:%u, %s", length, send_port, str_buffer);
    skw_btsnoop_capture(buffer, FALSE);

    if((skwbt_transtype & SKWBT_TRANS_TYPE_UART) &&
       (skwbtuartonly == FALSE) && (skwbtNoSleep == FALSE) && (btpw_fp >= 0))
    {
        const uint8_t count = pkt_cnts++;
        if (write(btpw_fp, &count, sizeof(count)) < 0)
            ALOGE("%s wake write failed: %s", __func__, strerror(errno));
    }

    if (destination->fd < 0 || !atomic_load(&destination->driver_state))
    {
        errno = ENOTCONN;
        return -1;
    }
    return write_transport(destination, destination->fd, buffer, length, false);
}

static void scomm_vendor_recv_rawdata(void *context)
{
    uint8_t port_index = (uint8_t)(uintptr_t)context;
    scomm_vnd_st *scomm = &scomm_vnd[port_index];

    for (;;)
    {
        size_t available = sizeof(host_stream.data) - host_stream.length;
        ssize_t bytes_read;

        if (available == 0)
        {
            ALOGE("%s host frame exceeds %zu bytes", __func__,
                  sizeof(host_stream.data));
            scomm_vendor_fail_transport(port_index);
            return;
        }

        bytes_read = read(scomm->uart_fd[1],
                          host_stream.data + host_stream.length, available);
        if (bytes_read > 0)
        {
            host_stream.length += (size_t)bytes_read;
            while (host_stream.length > 0)
            {
                struct skw_h4_frame frame;
                enum skw_h4_status status = skw_h4_stream_next(&host_stream,
                                                                &frame);

                if (status == SKW_H4_INVALID ||
                    (frame.frame_size != 0 && !host_frame_allowed(&frame)))
                {
                    ALOGE("%s invalid host frame type 0x%02x, size %zu",
                          __func__, frame.type, frame.frame_size);
                    scomm_vendor_fail_transport(port_index);
                    return;
                }
                if (status == SKW_H4_INCOMPLETE)
                    break;
                if (send_host_frame_to_device(host_stream.data,
                                              frame.frame_size) < 0)
                {
                    ALOGE("%s device write failed: %s", __func__,
                          strerror(errno));
                    scomm_vendor_fail_transport(port_index);
                    return;
                }
                (void)skw_h4_stream_consume(&host_stream, frame.frame_size);
            }
            return;
        }
        if (bytes_read < 0 && errno == EINTR)
            continue;
        if (bytes_read < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
            return;

        ALOGE("%s host socket closed: %s", __func__,
              bytes_read == 0 ? "eof" : strerror(errno));
        scomm_vendor_fail_transport(port_index);
        return;
    }
}

static void *scomm_vendor_recv_socket_thread(void *arg)
{
    //SKW_UNUSED(arg);
    int port_index = (int)(uintptr_t)arg;
    struct epoll_event events[64];
    scomm_vnd_st *scomm = &scomm_vnd[port_index];
    int j, ret;

    ALOGD("%s [%d] start", __func__, port_index);

    while(atomic_load(&scomm->thread_running))
    {
        do
        {
            ret = epoll_wait(scomm->epoll_fd, events, 32, 500);

            //ALOGE("recv_socket_thread ret:%d, state:%d", ret, scomm->thread_running);

        } while(atomic_load(&scomm->thread_running) &&
                (ret == -1) && (errno == EINTR));

        if (ret < 0)
        {
            if (atomic_load(&scomm->thread_running))
            {
                ALOGE("%s error in epoll_wait:%d, %s", __func__, ret,
                      strerror(errno));
                scomm_vendor_fail_transport((uint8_t)port_index);
            }
            break;
        }
        for (j = 0; (j < ret) && atomic_load(&scomm->thread_running); ++j)
        {
            skw_socket_object_st *object = (skw_socket_object_st *)events[j].data.ptr;
            if (events[j].data.ptr == NULL)
            {
                continue;
            }
            else
            {
                if (events[j].events & (EPOLLIN | EPOLLHUP | EPOLLRDHUP | EPOLLERR) && object->read_ready)
                {
                    object->read_ready(object->context);
                    //object->read_ready(port_index);
                }
                if (events[j].events & EPOLLOUT && object->write_ready)
                {
                    object->write_ready(object->context);
                    //object->read_ready(port_index);
                }
            }
        }
    }
    ALOGD("%s [%d] exit", __func__, port_index);
    return NULL;
}


/*******************************************************************************
**
** Function        scomm_vendor_send_to_host
**
** Description     send data to host
**
** Returns         None
**
*******************************************************************************/
static int scomm_vendor_send_to_host(uint8_t port_index,
                                     const unsigned char *buffer,
                                     size_t total_length)
{
    scomm_vnd_st *scomm = &scomm_vnd[port_index];
    int result;

    pthread_mutex_lock(&write2host_lock);
    result = scomm->uart_fd[1] >= 0
        ? write_transport(scomm, scomm->uart_fd[1], buffer, total_length, true)
        : -1;
    pthread_mutex_unlock(&write2host_lock);

    if (result < 0 && atomic_load(&scomm->thread_running))
    {
        ALOGE("%s host write failed: %s", __func__, strerror(errno));
        scomm_vendor_fail_transport(port_index);
    }
    return result;
}


/*******************************************************************************
**
** Function        scomm_vendor_send_hw_error
**
** Description     send HCI_HW_ERR command to hsot
**
** Returns         None
**
*******************************************************************************/

void scomm_vendor_send_hw_error()
{
    unsigned char p_buf[10];

    ALOGE("%s, CP Error", __func__);

    p_buf[0] = HCI_EVENT_PKT;//event
    p_buf[1] = HCI_HARDWARE_ERROR_EVENT;//hardware error
    p_buf[2] = 0x01;//len
    p_buf[3] = HWERR_CODE_CP_ERROR;//userial error code
    (void)scomm_vendor_send_to_host(0, p_buf, 4);
}

/*******************************************************************************
**
** Function        scomm_vendor_find_valid_type
**
** Description     find the index of valid packet type
**
** Returns         None
**
*******************************************************************************/
int scomm_vendor_find_valid_type(uint8_t *buffer, uint16_t len)
{
    int i;
    for(i = 0; i < len; i++)
    {
        switch(buffer[i])
        {
            case HCI_EVENT_PKT:
            case HCI_ACLDATA_PKT:
            case HCI_SCODATA_PKT:
            //case HCI_COMMAND_PKT:
            case HCI_EVENT_SKWLOG:
                return i;
            default:
                break;
        }
#if 0
        if((HCI_EVENT_PKT == buffer[i]) || (HCI_ACLDATA_PKT == buffer[i]) || (HCI_SCODATA_PKT == buffer[i]) || (HCI_COMMAND_PKT == buffer[i])
                || (HCI_EVENT_SKWLOG == buffer[i]))
        {
            return i;
        }
#endif
    }
    return len;
}


/*******************************************************************************
**
** Function        scomm_vendor_recv_scomm_thread
**
** Description     recv data from UART/USB/SDIO and process
**
** Returns         None
**
*******************************************************************************/
static void *scomm_vendor_recv_scomm_thread(void *arg)
{
    int port_index = (int)(uintptr_t)arg;
    scomm_vnd_st *scomm = &scomm_vnd[port_index];
    struct skw_h4_stream stream = { 0 };
    int ret;

    atomic_store(&scomm->recv_comm_thread_running, true);
    scomm->read_retry = 0;
    ALOGD("%s [%d] start", __func__, port_index);

    while(atomic_load(&scomm->thread_running))
    {
        struct pollfd pfd[2] = {
            { .fd = scomm->signal_fd[1],
              .events = POLLIN | POLLHUP | POLLERR | POLLRDHUP },
            { .fd = scomm->fd,
              .events = POLLIN | POLLHUP | POLLERR | POLLRDHUP },
        };

        do
        {
            ret = poll(pfd, 2, 500);
        } while(ret == -1 && errno == EINTR &&
                atomic_load(&scomm->thread_running));

        if (ret < 0)
        {
            if (atomic_load(&scomm->thread_running))
            {
                ALOGE("%s poll failed: %s", __func__, strerror(errno));
                scomm_vendor_fail_transport((uint8_t)port_index);
            }
            break;
        }
        if(pfd[0].revents && !atomic_load(&scomm->thread_running))
            break;

        if(pfd[1].revents & POLLIN)
        {
            size_t available = sizeof(stream.data) - stream.length;
            ssize_t bytes_read;

            if (available == 0)
            {
                ALOGE("%s controller frame exceeds %zu bytes", __func__,
                      sizeof(stream.data));
                scomm_vendor_fail_transport((uint8_t)port_index);
                break;
            }

            atomic_store(&scomm->is_busying, true);
            bytes_read = read(scomm->fd, stream.data + stream.length, available);
            atomic_store(&scomm->is_busying, false);

            if(bytes_read < 0 &&
               (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK))
                continue;
            if(bytes_read <= 0)
            {
                ALOGE("%s controller channel closed: %s", __func__,
                      bytes_read == 0 ? "eof" : strerror(errno));
                scomm_vendor_fail_transport((uint8_t)port_index);
                break;
            }

            stream.length += (size_t)bytes_read;
            while (stream.length > 0)
            {
                struct skw_h4_frame frame;
                enum skw_h4_status status = skw_h4_stream_next(&stream, &frame);
                size_t limit;

                switch (frame.type)
                {
                    case SKW_H4_EVENT_PKT:
                        limit = SKW_H4_EVENT_MAX_FRAME;
                        break;
                    case SKW_H4_ACL_PKT:
                        limit = SKW_H4_KERNEL_MAX_FRAME;
                        break;
                    case SKW_H4_SCO_PKT:
                        limit = SKW_H4_SCO_MAX_FRAME;
                        break;
                    case SKW_H4_ISO_PKT:
                        limit = SKW_H4_ISO_MAX_FRAME;
                        break;
                    case SKW_H4_LOG_PKT:
                        limit = SKW_H4_STREAM_CAPACITY;
                        break;
                    default:
                        limit = 0;
                        break;
                }

                if (status == SKW_H4_INVALID || limit == 0 ||
                    (frame.frame_size != 0 && frame.frame_size > limit))
                {
                    ALOGE("%s invalid controller frame type 0x%02x, size %zu",
                          __func__, frame.type, frame.frame_size);
                    scomm_vendor_fail_transport((uint8_t)port_index);
                    break;
                }
                if (status == SKW_H4_INCOMPLETE)
                    break;

                if(frame.type == SKW_H4_LOG_PKT)
                {
                    skwlog_write(stream.data, (unsigned int)frame.frame_size);
                }
                else
                {
                    skw_btsnoop_capture(stream.data, TRUE);
                    if (scomm_vendor_send_to_host(0, stream.data,
                                                  frame.frame_size) < 0)
                    {
                        if (atomic_load(&scomm->thread_running))
                            scomm_vendor_fail_transport((uint8_t)port_index);
                        break;
                    }
                }
                (void)skw_h4_stream_consume(&stream, frame.frame_size);
            }
            if (!atomic_load(&scomm->thread_running))
                break;
        }

        if (pfd[1].revents & (POLLERR | POLLHUP | POLLRDHUP | POLLNVAL))
        {
            ALOGE("%s controller poll failure, fd %d, revents 0x%x",
                  __func__, scomm->fd, pfd[1].revents);
            scomm_vendor_fail_transport((uint8_t)port_index);
            break;
        }
    }

    atomic_store(&scomm->is_busying, false);

    ALOGD("%s [%d] exit", __func__, port_index);
    return NULL;
}


/*******************************************************************************
**
** Function        scomm_vendor_socket_open
**
** Description     USB/SDIO Open
**
** Returns         None
**
*******************************************************************************/
int scomm_vendor_socket_open(uint8_t port_index)
{
    int ret;
    int attr_initialized = FALSE;
    pthread_attr_t thread_attr;
    scomm_vnd_st *scomm = &scomm_vnd[port_index];
    struct epoll_event event;

    if(socketpair(AF_UNIX, SOCK_STREAM, 0, scomm->uart_fd) < 0)
    {
        ALOGE("%s, errno : %s", __func__, strerror(errno));
        return -1;
    }
    if(socketpair(AF_UNIX, SOCK_STREAM, 0, scomm->signal_fd) < 0)
    {
        ALOGE("%s, errno : %s", __func__, strerror(errno));
        goto fail;
    }
    for (int i = 0; i < 2; i++)
    {
        if (set_nonblocking_cloexec(scomm->uart_fd[i]) < 0 ||
            set_nonblocking_cloexec(scomm->signal_fd[i]) < 0)
        {
            ALOGE("%s unable to configure socketpair: %s", __func__,
                  strerror(errno));
            goto fail;
        }
    }

    scomm->epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (scomm->epoll_fd == -1)
    {
        ALOGE("%s unable to create epoll instance: %s", __func__, strerror(errno));
        goto fail;
    }

    atomic_store(&scomm->thread_running, true);
    atomic_store(&scomm->recv_comm_thread_running, false);
    atomic_store(&scomm->driver_state, false);
    scomm->thread_socket_started = false;
    scomm->thread_uart_started = false;

    ret = pthread_attr_init(&thread_attr);
    if (ret != 0)
    {
        ALOGE("pthread_attr_init: %s", strerror(ret));
        goto fail;
    }
    attr_initialized = TRUE;
    ret = pthread_attr_setdetachstate(&thread_attr, PTHREAD_CREATE_JOINABLE);
    if (ret != 0)
    {
        ALOGE("pthread_attr_setdetachstate: %s", strerror(ret));
        goto fail;
    }

    if(port_index == 0)
    {
        memset(&host_stream, 0, sizeof(host_stream));
        skw_socket_object.fd = scomm->uart_fd[1];
        skw_socket_object.context = (void *)(uintptr_t)port_index;
        skw_socket_object.read_ready = scomm_vendor_recv_rawdata;
        skw_socket_object.write_ready = NULL;

        memset(&event, 0, sizeof(event));
        event.events |= EPOLLIN | EPOLLHUP | EPOLLRDHUP | EPOLLERR;
        event.data.ptr = (void *)&skw_socket_object;
        if (epoll_ctl(scomm->epoll_fd, EPOLL_CTL_ADD,
                      scomm->uart_fd[1], &event) == -1)
        {
            ALOGE("%s unable to register fd %d to epoll set: %s", __func__,
                  scomm->uart_fd[1], strerror(errno));
            goto fail;
        }

        event.data.ptr = NULL;
        if (epoll_ctl(scomm->epoll_fd, EPOLL_CTL_ADD,
                      scomm->signal_fd[1], &event) == -1)
        {
            ALOGE("%s unable to register signal fd %d to epoll set: %s",
                  __func__, scomm->signal_fd[1], strerror(errno));
            goto fail;
        }

        ret = pthread_create(&scomm->thread_socket_id, &thread_attr,
                             scomm_vendor_recv_socket_thread,
                             (void *)(uintptr_t)port_index);
        if (ret != 0)
        {
            ALOGE("pthread_create socket: %s", strerror(ret));
            goto fail;
        }
        scomm->thread_socket_started = true;
    }

    ret = pthread_create(&scomm->thread_uart_id, &thread_attr,
                         scomm_vendor_recv_scomm_thread,
                         (void *)(uintptr_t)port_index);
    if (ret != 0)
    {
        ALOGE("pthread_create controller: %s", strerror(ret));
        goto fail;
    }
    scomm->thread_uart_started = true;
    pthread_attr_destroy(&thread_attr);
    attr_initialized = FALSE;

    for (int attempts = 0;
         attempts < 5000 && atomic_load(&scomm->thread_running) &&
         !atomic_load(&scomm->recv_comm_thread_running);
         attempts++)
    {
        usleep(100);
    }
    if (!atomic_load(&scomm->recv_comm_thread_running))
    {
        ALOGE("%s controller thread did not start", __func__);
        goto fail;
    }

    atomic_store(&scomm->driver_state, true);
    ret = scomm->uart_fd[0];

    ALOGD("%s uart_fd:%d", __func__, ret);
    return ret;

fail:
    if (attr_initialized)
        pthread_attr_destroy(&thread_attr);
    atomic_store(&scomm->driver_state, false);
    atomic_store(&scomm->thread_running, false);
    wake_port(scomm);
    if (scomm->uart_fd[1] >= 0)
        (void)shutdown(scomm->uart_fd[1], SHUT_RDWR);
    if (scomm->thread_uart_started)
    {
        ret = pthread_join(scomm->thread_uart_id, NULL);
        if (ret != 0)
            ALOGE("pthread_join controller: %s", strerror(ret));
        scomm->thread_uart_started = false;
    }
    if (scomm->thread_socket_started)
    {
        ret = pthread_join(scomm->thread_socket_id, NULL);
        if (ret != 0)
            ALOGE("pthread_join socket: %s", strerror(ret));
        scomm->thread_socket_started = false;
    }
    close_owned_fd(&scomm->epoll_fd);
    close_owned_fd(&scomm->uart_fd[0]);
    close_owned_fd(&scomm->uart_fd[1]);
    close_owned_fd(&scomm->signal_fd[0]);
    close_owned_fd(&scomm->signal_fd[1]);
    return -1;
}


/*******************************************************************************
**
** Function        scomm_vendor_socket_close
**
** Description     socket close
**
** Returns         None
**
*******************************************************************************/
static void scomm_vendor_socket_close(uint8_t port_index)
{
    scomm_vnd_st *scomm = &scomm_vnd[port_index];

    close_owned_fd(&scomm->epoll_fd);
    close_owned_fd(&scomm->uart_fd[0]);
    close_owned_fd(&scomm->uart_fd[1]);
    close_owned_fd(&scomm->signal_fd[0]);
    close_owned_fd(&scomm->signal_fd[1]);
}


void scomm_vendor_write_bt_state()
{
#ifdef SKW_LEGACY_FW_CFG
    //if(skwbt_transtype & SKWBT_TRANS_TYPE_USB)
    if(chip_version == SKW_CHIPID_6160)
    {
        char buffer[10] = {0x01, 0x80, 0xFE, 0x01, 0x00};
        scomm_vnd_st *scomm = &scomm_vnd[0];
        (void)write_transport(scomm, scomm->fd,
                              (const uint8_t *)buffer, 5, false);
        usleep(15000);
    }
#endif
}

/*******************************************************************************
**
** Function        scomm_vendor_port_close
**
** Description     Conduct vendor-specific close works
**
** Returns         None
**
*******************************************************************************/
void scomm_vendor_port_close(uint8_t port_index)
{
    int result;
    scomm_vnd_st *scomm = &scomm_vnd[port_index];
    ALOGD("%s [%d] start, fd:%d", __func__, port_index, scomm->fd);

    atomic_store(&scomm->driver_state, false);
    atomic_store(&scomm->thread_running, false);
    wake_port(scomm);
    if (scomm->uart_fd[1] >= 0)
        (void)shutdown(scomm->uart_fd[1], SHUT_RDWR);
    if (scomm->fd >= 0)
        (void)ioctl(scomm->fd, 0);

    if(scomm->thread_uart_started)
    {
        result = pthread_join(scomm->thread_uart_id, NULL);
        if (result != 0)
            ALOGE("pthread_join controller: %s", strerror(result));
        scomm->thread_uart_started = false;
    }
    if(scomm->thread_socket_started)
    {
        result = pthread_join(scomm->thread_socket_id, NULL);
        if (result != 0)
            ALOGE("pthread_join socket: %s", strerror(result));
        scomm->thread_socket_started = false;
    }

    close_owned_fd(&scomm->fd);
    scomm_vendor_socket_close(port_index);
    atomic_store(&scomm->recv_comm_thread_running, false);
    ALOGD("%s [%d] finish", __func__, port_index);
}

/*******************************************************************************
**
** Function        scomm_vendor_close
**
** Description     Conduct vendor-specific close works
**
** Returns         None
**
*******************************************************************************/
void scomm_vendor_close()
{
    int idx = 0;

    for(idx = 0; idx < BT_COM_PORT_SIZE; idx++)
    {
        atomic_store(&scomm_vnd[idx].driver_state, false);
        atomic_store(&scomm_vnd[idx].thread_running, false);
        wake_port(&scomm_vnd[idx]);
        if (scomm_vnd[idx].uart_fd[1] >= 0)
            (void)shutdown(scomm_vnd[idx].uart_fd[1], SHUT_RDWR);
    }
    for(idx = 0; idx < BT_COM_PORT_SIZE; idx++)
    {
        scomm_vendor_port_close(idx);
    }
    if(btpw_fp >= 0)
    {
        close(btpw_fp);
        btpw_fp = -1;
    }
}

#ifdef SKW_LEGACY_FW_CFG
/*******************************************************************************
**
** Function         scomm_vendor_init_err
**
** Description      init err
**
** Returns          None
**
*******************************************************************************/
void scomm_vendor_init_err(HC_BT_HDR   *p_buf)
{
    hw_cfg_cb.state = HW_CFG_INIT;
    bt_vendor_cbacks->dealloc(p_buf);
    fclose(hw_cfg_cb.nv_fp);
    hw_cfg_cb.nv_fp = NULL;

}

/*******************************************************************************
**
** Function         scomm_vendor_config_callback
**
** Description      Callback function for controller configuration
**
** Returns          None
**
*******************************************************************************/
void scomm_vendor_config_callback(void *p_mem)
{
    uint8_t     status = 0;
    uint16_t    opcode = 0;
    HC_BT_HDR   *p_buf = NULL;
    HC_BT_HDR   *p_evt_buf = NULL;

    ALOGE("=== CALLBACK START: initial state=%d ===", hw_cfg_cb.state);
    ALOGE("=== CALLBACK START: hw_cfg_cb address=%p ===", &hw_cfg_cb);

    if(p_mem != NULL)
    {
        p_evt_buf = (HC_BT_HDR *) p_mem;
        status = *((uint8_t *)(p_evt_buf + 1) + HCI_EVT_CMD_CMPL_STATUS_OFFSET);
        uint8_t *p = (uint8_t *)(p_evt_buf + 1) + HCI_EVT_CMD_CMPL_OPCODE_OFFSET;
        STREAM_TO_UINT16(opcode, p);
    }


    ALOGE("=== CALLBACK: state=%d, status=%d, opcode=0x%04X ===", hw_cfg_cb.state, status, opcode);
    ALOGD("%s status:%d ,opcode:%04X", __func__, status, opcode);
    if((status == 0) && bt_vendor_cbacks)
    {
        p_buf = (HC_BT_HDR *)bt_vendor_cbacks->alloc(BT_HC_HDR_SIZE + HCI_CMD_MAX_LEN);
    }

    if(p_buf)
    {
        p_buf->event = MSG_STACK_TO_HC_HCI_CMD;
        p_buf->offset = 0;
        p_buf->len = 0;
        p_buf->layer_specific = 0;

        ALOGD("hw_cfg_cb.state = %d", hw_cfg_cb.state);

        ALOGE("=== SWITCH: state=%d, about to enter switch ===", hw_cfg_cb.state);
        switch (hw_cfg_cb.state)
        {
            case HW_CFG_START:
            {
                ALOGE("=== ENTERING HW_CFG_START case ===");
                ALOGE("=== HW_CFG_START: About to allocate buffer ===");
                uint8_t *ptr = (uint8_t *) (p_buf + 1);
                ALOGE("=== HW_CFG_START: Setting up HCI_READ_LOCAL_VERSION_INFO command ===");
                UINT16_TO_STREAM(ptr, HCI_READ_LOCAL_VERSION_INFO);
                UINT8_TO_STREAM(ptr, 0);

                p_buf->len = 3;//packet len
                ALOGE("=== HW_CFG_START: About to call xmit_cb with opcode 0x%04X ===", HCI_READ_LOCAL_VERSION_INFO);
                ALOGE("=== HW_CFG_START: setting state to HW_CFG_READ_HCI_VERSION (3) BEFORE xmit_cb ===");
                hw_cfg_cb.state = HW_CFG_READ_HCI_VERSION;
                ALOGE("=== HW_CFG_START: state set to %d ===", hw_cfg_cb.state);
                bt_vendor_cbacks->xmit_cb(HCI_READ_LOCAL_VERSION_INFO, p_buf, scomm_vendor_config_callback);
                ALOGE("=== HW_CFG_START: About to break ===");
                ALOGE("=== HW_CFG_START: Final state before break = %d ===", hw_cfg_cb.state);
                break;
            }
            case HW_CFG_READ_HCI_VERSION:
            {
                ALOGE("=== ENTERING HW_CFG_READ_HCI_VERSION case ===");
                char file_name[128] = {0};
                uint8_t skip_header = 0;
                uint8_t *p = (uint8_t *)(p_evt_buf + 1) + 7;
                STREAM_TO_UINT16(chip_version, p);

                ALOGD("chip_version:0x%04X", chip_version);

                switch(chip_version)
                {
                    case SKW_CHIPID_6316://0x6316
                    {
                        skip_header = 1;
                        sprintf(file_name, "%s/sv6316.nvbin", SKWBT_NV_FILE_PATH);
                        break;
                    }
                    case SKW_CHIPID_6160_LITE:
                    {
                        skip_header = 1;
                        sprintf(file_name, "%s/sv6160lite.nvbin", SKWBT_NV_FILE_PATH);
                        break;
                    }
                    default:
                    {
                        sprintf(file_name, "%s/sv6160.nvbin", SKWBT_NV_FILE_PATH);
                        chip_version = SKW_CHIPID_6160;
                        break;
                    }
                }

                hw_cfg_cb.nv_fp = fopen(file_name, "rb");
                ALOGE("=== Trying to open NV file: %s ===", file_name);
                if(!hw_cfg_cb.nv_fp)
                {
                    ALOGE("%s unable to open nv file:%s: %s", __func__, SKWBT_NV_FILE_PATH, strerror(errno));
                    bt_vendor_cbacks->fwcfg_cb(BT_VND_OP_RESULT_FAIL);
                    hw_cfg_cb.state = HW_CFG_INIT;
                    return;
                }
                ALOGE("=== NV file opened successfully ===");
                hw_cfg_cb.file_offset = 0;
                hw_cfg_cb.state = HW_CFG_NV_SEND;
                if(skip_header)//skip header
                {
                    char buffer[6];
                    fread(buffer, 1, 4, hw_cfg_cb.nv_fp);
                }

                // FIX: Allocate new buffer and send HCI_CMD_SKW_BT_NVDS command
                HC_BT_HDR *p_buf_new = (HC_BT_HDR *)bt_vendor_cbacks->alloc(BT_HC_HDR_SIZE + HCI_CMD_MAX_LEN);
                if(p_buf_new)
                {
                    p_buf_new->event = MSG_STACK_TO_HC_HCI_CMD;
                    p_buf_new->offset = 0;
                    p_buf_new->len = 0;
                    p_buf_new->layer_specific = 0;

                    ALOGE("=== ENTER HW_CFG_READ_HCI_VERSION, about to send NVDS ===");
                    // Send the first NV command to trigger state transition
                    bt_vendor_cbacks->xmit_cb(HCI_CMD_SKW_BT_NVDS, p_buf_new, scomm_vendor_config_callback);
                    ALOGE("=== AFTER xmit_cb, will return now ===");
                    return;
                }
                ALOGE("=== FAILED to allocate buffer for NVDS ===");
                break;
            }
            case HW_CFG_NV_SEND:
            {
                ALOGE("=== ENTERING HW_CFG_NV_SEND case ===");
                ALOGE("=== HW_CFG_NV_SEND: chip_version=0x%04X ===", chip_version);
                uint8_t len = 0, res = 0;
                uint8_t *ptr = (uint8_t *) (p_buf + 1);//skip header
                UINT16_TO_STREAM(ptr, HCI_CMD_SKW_BT_NVDS);

                if((chip_version == SKW_CHIPID_6316) || (chip_version == SKW_CHIPID_6160_LITE))//0x6316
                {
                    ALOGE("=== HW_CFG_NV_SEND: Using 6316/6160_LITE path ===");
                    uint8_t tmp_buffer[10] = {0};
                    uint8_t *param_buf = ptr + 3;
                    uint8_t nv_tag = 0;
                    int  nv_param_len = 0;
                    int  total_len = 0;
                    char file_end = 0;
                    int  file_ptr;
                    while(1)
                    {
                        file_ptr = ftell(hw_cfg_cb.nv_fp);
                        len = fread(tmp_buffer, 1, 3, hw_cfg_cb.nv_fp);
                        if((len < 3) || feof(hw_cfg_cb.nv_fp))
                        {
                            file_end = 1;
                            break;
                        }
                        memcpy(param_buf + total_len, tmp_buffer, 3);
                        nv_param_len = tmp_buffer[2];
                        nv_tag = tmp_buffer[0];
                        ALOGD("tag:%d, nv_param_len:%d, file_ptr:%d", tmp_buffer[0], nv_param_len, file_ptr);

                        if((nv_param_len + total_len + 3) > 252)//252 + 3
                        {
                            fseek(hw_cfg_cb.nv_fp, file_ptr, SEEK_SET);
                            break;
                        }
                        total_len += 3;
                        if(nv_param_len > 0)
                        {
                            len = fread(param_buf + total_len, 1, nv_param_len, hw_cfg_cb.nv_fp);
                            if(len < nv_param_len)
                            {
                                ALOGE("%s, len:%d, nv_param_len:%d", __func__, len, nv_param_len);
                                scomm_vendor_init_err(p_buf);
                                break;
                            }
                            if(nv_tag == NV_TAG_BD_ADDR)
                            {
                                skw_addr_get(param_buf + total_len + 3);
                            }
                            else if(nv_tag == NV_TAG_DSP_LOG_SETTING)
                            {
                                *(param_buf + total_len) = btcp_log_en ? 0 : 1;
                            }
                            total_len += len;
                        }
                    }
                    if(total_len > 0)
                    {
                        ptr[0] = (total_len + 2);//payload len
                        ptr[1] = hw_cfg_cb.file_offset;
                        ptr[2] = total_len;//para len
                        p_buf->len = total_len + 2 + 3;//packet len
                        res = bt_vendor_cbacks->xmit_cb(HCI_CMD_SKW_BT_NVDS, p_buf, scomm_vendor_config_callback);
                        hw_cfg_cb.file_offset ++;
                        if(res == FALSE)//send error
                        {
                            scomm_vendor_init_err(p_buf);
                            break;
                        }
                    }
                    if(file_end)
                    {
                        hw_cfg_cb.state = HW_CFG_WRITE_OS_TYPE;
                        fclose(hw_cfg_cb.nv_fp);
                        hw_cfg_cb.nv_fp = NULL;
                    }
                }
                else
                {
                    ALOGE("=== HW_CFG_NV_SEND: Using 6160 path ===");
                    len = fread(ptr + 3, 1, NV_FILE_RD_BLOCK_SIZE, hw_cfg_cb.nv_fp);
                    ALOGE("=== HW_CFG_NV_SEND: Read %d bytes from NV file ===", len);

                    // Check if we're at the end of the file
                    if((len < NV_FILE_RD_BLOCK_SIZE) || (len == 0) || feof(hw_cfg_cb.nv_fp))//end of file
                    {
                        ALOGE("=== HW_CFG_NV_SEND: End of file reached, transitioning to HW_CFG_WRITE_BD_ADDR ===");
                        hw_cfg_cb.state = HW_CFG_WRITE_BD_ADDR;
                        fclose(hw_cfg_cb.nv_fp);
                        hw_cfg_cb.nv_fp = NULL;
                        break;
                    }

                    ptr[0] = (len + 2);//payload len
                    ptr[1] = hw_cfg_cb.file_offset;
                    ptr[2] = len;//para len
                    p_buf->len = len + 2 + 3;//packet len
                    if(0 == hw_cfg_cb.file_offset)
                    {
                        //*(ptr + 3 + 3) = 'A';
                        //byte7
                        skw_addr_get(ptr + 3 + 7);
                    }
                    else if(1 == hw_cfg_cb.file_offset)
                    {
                        *(ptr + 3 + 62) |= 0x80;
                        *(ptr + 3 + 53) = btcp_log_en ? 0 : 1;
                    }

                    res = bt_vendor_cbacks->xmit_cb(HCI_CMD_SKW_BT_NVDS, p_buf, scomm_vendor_config_callback);

                    ALOGD("len:%d, file_offset:%d, plen:%d,%d res:%d", len, hw_cfg_cb.file_offset, p_buf->len, ptr[0], res);

                    hw_cfg_cb.file_offset ++;

                    if(res == FALSE)//send error
                    {
                        scomm_vendor_init_err(p_buf);
                    }

                    // FIX: Return after sending NVDS command to prevent infinite loop
                    ALOGE("=== HW_CFG_NV_SEND: Sent NVDS command, returning to wait for response ===");
                    return;
                }
                break;
            }
            case HW_CFG_WRITE_OS_TYPE:
            {
                if(chip_version != SKW_CHIPID_6160)
                {
                    uint8_t *ptr = (uint8_t *) (p_buf + 1);
                    UINT16_TO_STREAM(ptr, HCI_CMD_WRITE_OS_TYPE);
                    UINT8_TO_STREAM(ptr, 1);
                    UINT8_TO_STREAM(ptr, 1);

                    p_buf->len = 3 + 1;//packet len
                    bt_vendor_cbacks->xmit_cb(HCI_CMD_WRITE_OS_TYPE, p_buf, scomm_vendor_config_callback);
                    hw_cfg_cb.state = HW_CFG_WRITE_BD_ADDR;
                    break;
                }
            }
            __attribute__((fallthrough));
            case HW_CFG_WRITE_BD_ADDR:
            {
                uint8_t *ptr = (uint8_t *) (p_buf + 1);
                UINT16_TO_STREAM(ptr, HCI_CMD_WRITE_BD_ADDR);
                UINT8_TO_STREAM(ptr, 6);

                p_buf->len = 3 + 6;//packet len
                if(skw_addr_from_ap(ptr))
                {
                    bt_vendor_cbacks->xmit_cb(HCI_CMD_WRITE_BD_ADDR, p_buf, scomm_vendor_config_callback);
#if BLE_ADV_WAKEUP_ENABLE
                    hw_cfg_cb.state = HW_CFG_WRITE_WAKEUP_ADV_DATA;
#else
                    hw_cfg_cb.state = HW_CFG_NV_SEND_CMPL;
#endif
                    break;
                }
            }
            __attribute__((fallthrough));
#if BLE_ADV_WAKEUP_ENABLE
            case HW_CFG_WRITE_WAKEUP_ADV_DATA:
            {
                uint8_t adv_data_len = wakeup_ADV_Info.data_len;
                if(adv_data_len > 0)
                {
                    uint8_t *ptr = (uint8_t *) (p_buf + 1);
                    uint8_t i, adv_len;
                    uint8_t pld_len = adv_data_len + 4;//add the length of gpio & level & grp nums & total len
                    Wakeup_ADV_Grp_St *adv_grp;
                    UINT16_TO_STREAM(ptr, HCI_CMD_WRITE_WAKEUP_ADV_DATA);
                    UINT8_TO_STREAM(ptr, pld_len);
                    UINT8_TO_STREAM(ptr, wakeup_ADV_Info.gpio_no);
                    UINT8_TO_STREAM(ptr, wakeup_ADV_Info.level);
                    UINT8_TO_STREAM(ptr, wakeup_ADV_Info.grp_nums);
                    UINT8_TO_STREAM(ptr, adv_data_len);
                    for(i = 0; i < wakeup_ADV_Info.grp_nums; i++)
                    {
                        adv_grp = &wakeup_ADV_Info.adv_group[i];
                        UINT8_TO_STREAM(ptr, adv_grp->grp_len);
                        UINT8_TO_STREAM(ptr, adv_grp->addr_offset);
                        adv_len = (adv_grp->grp_len - 2) >> 1;

                        SKWBT_LOG("grp len:%d, adv_len:%d", adv_grp->grp_len, adv_len);

                        memcpy(ptr, adv_grp->data, adv_len);
                        ptr += adv_len;
                        memcpy(ptr, adv_grp->mask, adv_len);
                        ptr += adv_len;
                    }

                    p_buf->len = 3 + pld_len;//packet len
                    bt_vendor_cbacks->xmit_cb(HCI_CMD_WRITE_WAKEUP_ADV_DATA, p_buf, scomm_vendor_config_callback);
                    hw_cfg_cb.state = HW_CFG_NV_SEND_CMPL;
                    break;
                }
            }
            __attribute__((fallthrough));
#endif
            case HW_CFG_NV_SEND_CMPL:
            {
                bt_vendor_cbacks->fwcfg_cb(BT_VND_OP_RESULT_SUCCESS);
                bt_vendor_cbacks->dealloc(p_buf);//free buffer
                hw_cfg_cb.state = HW_CFG_INIT;
                break;
            }
            default:
            {
                ALOGE("=== UNEXPECTED STATE: state=%d, opcode=0x%04X ===", hw_cfg_cb.state, opcode);
                break;
            }
        }
    }


    /* Free the RX event buffer */
    if ((bt_vendor_cbacks) && (p_evt_buf != NULL))
    {
        bt_vendor_cbacks->dealloc(p_evt_buf);
    }


}

/*******************************************************************************
**
** Function        scomm_vendor_config_start
**
** Description     Kick off controller initialization process
**
** Returns         None
**
*******************************************************************************/
void scomm_vendor_config_start()
{
    ALOGE("=== CONFIG_START called, current state=%d ===", hw_cfg_cb.state);

    // Only initialize if not already in progress
    if (hw_cfg_cb.state == HW_CFG_INIT)
    {
        ALOGE("=== CONFIG_START: Initializing structure ===");
        memset(&hw_cfg_cb, 0, sizeof(bt_hw_cfg_cb_st));
        hw_cfg_cb.state = HW_CFG_INIT;
    }

    HC_BT_HDR  *p_buf = NULL;
    uint8_t     *p;

    // Only proceed if we're in INIT state
    if (hw_cfg_cb.state != HW_CFG_INIT)
    {
        ALOGE("=== CONFIG_START: Already in progress, state=%d ===", hw_cfg_cb.state);
        return;
    }

    ALOGE("=== CONFIG_START: Proceeding with configuration ===");
    if (bt_vendor_cbacks)
    {
        p_buf = (HC_BT_HDR *) bt_vendor_cbacks->alloc(BT_HC_HDR_SIZE + HCI_CMD_PREAMBLE_SIZE);
        if (p_buf)
        {
            p_buf->event = MSG_STACK_TO_HC_HCI_CMD;
            p_buf->offset = 0;
            p_buf->layer_specific = 0;
            p_buf->len = HCI_CMD_PREAMBLE_SIZE;

            p = (uint8_t *) (p_buf + 1);
            UINT16_TO_STREAM(p, HCI_RESET);
            *p = 0; /* parameter length */

            hw_cfg_cb.state = HW_CFG_START;
            ALOGE("=== CONFIG_START: Set state to HW_CFG_START (%d) ===", hw_cfg_cb.state);

            bt_vendor_cbacks->xmit_cb(HCI_RESET, p_buf, scomm_vendor_config_callback);
        }
        else
        {
            ALOGE("%s buffer alloc fail", __func__);
        }
    }
    else
    {
        ALOGE("%s call back func is null", __func__);
    }
}

/*******************************************************************************
**
** Function        scomm_vendor_write_wakeup_adv_data_callback
**
** Description     send wakeup adv data callback
**
** Returns         None
**
*******************************************************************************/
void scomm_vendor_write_wakeup_adv_data_callback(void *p_mem)
{
    uint8_t     status = 0;
    uint16_t    opcode = 0;
    HC_BT_HDR   *p_evt_buf = NULL;
    if(p_mem != NULL)
    {
        uint8_t *p;
        p_evt_buf = (HC_BT_HDR *) p_mem;
        status = *((uint8_t *)(p_evt_buf + 1) + HCI_EVT_CMD_CMPL_STATUS_OFFSET);
        p = (uint8_t *)(p_evt_buf + 1) + HCI_EVT_CMD_CMPL_OPCODE_OFFSET;
        STREAM_TO_UINT16(opcode, p);

        ALOGD("%s status:%d ,opcode:%04X", __func__, status, opcode);

        if(bt_vendor_cbacks)
        {
            bt_vendor_cbacks->dealloc(p_evt_buf);
        }
    }
    else
    {
        ALOGE("%s pram is null", __func__);
    }
}

/*******************************************************************************
**
** Function        scomm_vendor_write_wakeup_adv_enable
**
** Description     send wakeup adv enable
**
** Returns         None
**
*******************************************************************************/
void scomm_vendor_write_wakeup_adv_enable()
{
    HC_BT_HDR   *p_buf = (HC_BT_HDR *)bt_vendor_cbacks->alloc(HCI_CMD_MAX_LEN);
    uint8_t     *p;

    if(p_buf)
    {
        uint8_t param_len = 1;
        p_buf->event = MSG_STACK_TO_HC_HCI_CMD;
        p_buf->offset = 0;
        p_buf->len = 0;
        p_buf->layer_specific = 0;

        p = (uint8_t *) (p_buf + 1);
        UINT16_TO_STREAM(p, HCI_CMD_WRITE_WAKEUP_ADV_ENABLE);
        UINT8_TO_STREAM(p, param_len);
        UINT8_TO_STREAM(p, 0x01);

        p_buf->len = 3 + param_len;//packet len

        bt_vendor_cbacks->xmit_cb(HCI_CMD_WRITE_WAKEUP_ADV_ENABLE, p_buf, scomm_vendor_write_wakeup_adv_data_callback);
    }
    else
    {
        ALOGE("%s buffer alloc fail", __func__);
    }


}


/*
    data_str = "xxxx;...."
*/
char *scomm_vendor_config_get_uint8(char *data_str, uint8_t *value)
{
    char *split0 = strchr(data_str, ';');
    uint8_t len = 0;
    char buffer[8] = {0};
    if((split0 == NULL) || (split0 == data_str))
    {
        return NULL;
    }
    len = split0 - data_str;
    if(len > 4)//invalid
    {
        SKWBT_LOG("%s, invalid str , %s", __func__, data_str);
        return NULL;
    }
    memcpy(buffer, data_str, len);
    *value = atoi(buffer);
    return split0 + 1;//skip ;
}

void scomm_vendor_parse_wakeup_adv_conf(char *data_str)
{
    //WakeupADVData=GPIO_No(decimal);Level(decimal);addr offset(decimal);ADVData(Hex);Mask(Hex)
    int str_len = strlen(data_str);
    char *base_ptr = data_str;
    char *split0, *split1;
    uint8_t adv_grp_nums = 0, adv_len = 0, mask_len;
    uint8_t gpio_no = 0, level = 0, addr_offset;
    uint8_t i = 0, j = 0, k;
    Wakeup_ADV_Grp_St *adv_grp;
    int total_len = 0;

    wakeup_ADV_Info.data_len = 0;
    if(str_len > 512)
    {
        SKWBT_LOG("%s, invalid config str, %s", __func__, data_str);
        return ;
    }
    if((base_ptr = scomm_vendor_config_get_uint8(base_ptr, &gpio_no)) == NULL)
    {
        return ;
    }
    if((base_ptr = scomm_vendor_config_get_uint8(base_ptr, &level)) == NULL)
    {
        return ;
    }
    for(k = 0; k < BLE_ADV_WAKEUP_GRP_NUMS; k++)
    {
        //addr offset(decimal);ADVData(Hex);Mask(Hex)
        if((base_ptr = scomm_vendor_config_get_uint8(base_ptr, &addr_offset)) == NULL)
        {
            break;
        }
        if((addr_offset == 1) || (addr_offset > 26))
        {
            SKWBT_LOG("%s, invalid addr_offset , %s", __func__, data_str);
            return ;
        }
        adv_grp = &wakeup_ADV_Info.adv_group[k];
        split0 = strchr(base_ptr, ';');
        if(split0 == NULL)
        {
            SKWBT_LOG("%s, invalid config , %s", __func__, data_str);
            return ;
        }
        split1 = strchr(split0 + 1, ';');

        adv_len = split0 - base_ptr;
        adv_grp->addr_offset = addr_offset;
        adv_grp->grp_len = adv_len + 2;//add addr_offset & self length

        split0 ++;//skip ;
        if(split1 == NULL)
        {
            mask_len = data_str + str_len - split0;
        }
        else
        {
            mask_len = split1 - split0;
        }
        if(mask_len != adv_len)
        {
            SKWBT_LOG("%s, mask_len != adv_len , %s", __func__, data_str);
            return ;
        }
        SKWBT_LOG("grp len:%d, adv_len:%d", adv_grp->grp_len, adv_len);
        for(i = 0, j = 0; i < adv_len; j ++, i += 2)
        {
            adv_grp->data[j] = (char2hex(base_ptr[i]) << 4) | char2hex(base_ptr[i + 1]);
            adv_grp->mask[j] = (char2hex(split0[i]) << 4) | char2hex(split0[i + 1]);
        }
        total_len += adv_grp->grp_len;
        adv_grp_nums ++;
        if(split1 == NULL)
        {
            break;
        }
        base_ptr = split1 + 1;
    }
    wakeup_ADV_Info.data_len = total_len;//not contain gpio & level
    wakeup_ADV_Info.grp_nums = adv_grp_nums;
    wakeup_ADV_Info.gpio_no = gpio_no;
    wakeup_ADV_Info.level = level;

    SKWBT_LOG("ADV str len:%d, gpio:%d, level:%d, adv_grp_nums:%d, total_len:%d, Data:%s", str_len, gpio_no, level, adv_grp_nums, total_len, data_str);
}
#endif
