/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

#define LOG_TAG "skw_btsnoop"

#include "skw_btsnoop.h"
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>
#include "skw_log.h"
#include "skw_common.h"



char skw_btsnoop_path[1024] = {'\0'};
static pthread_mutex_t btsnoop_log_lock;

char btsnoop_save_log                     = FALSE;
static int hci_btsnoop_fd                 = -1;
static const uint64_t BTSNOOP_EPOCH_DELTA = 0x00dcddb30f2f8000ULL;
unsigned int btsnoop_cnts = 0;
unsigned int btsnoop_rev_length = 0;
extern char skwlog_slice;
extern char btsnoop_log_en;

static uint64_t skw_btsnoop_timestamp(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);

    uint64_t timestamp = (tv.tv_sec * 1000LL * 1000LL) + tv.tv_usec + BTSNOOP_EPOCH_DELTA;
    return timestamp;
}

void skw_btsnoop_open()
{
    char last_log_path[PATH_MAX];
    uint64_t timestamp;
    uint32_t usec;
    char new_file = TRUE;
    btsnoop_rev_length = 0;


    if((hci_btsnoop_fd != -1) || (!btsnoop_log_en))
    {
        ALOGE("%s btsnoop log file is already open. log_en:%d", __func__, btsnoop_log_en);
        return;
    }

    if(btsnoop_save_log)
    {
        struct stat buf;
        int fd = -1;
        if(stat(skw_btsnoop_path, &buf) == 0)
        {
            fd = open(skw_btsnoop_path, O_RDONLY);
        }
        if(fd > 0)
        {
            fstat(fd, &buf);
            int file_zie = (int)buf.st_size;
            close(fd);
            ALOGD("%s btsnoop log file size:%d", __func__, file_zie);
            if(skwlog_slice)
            {
                if(file_zie > SKW_LOG_DEFAULT_SIZE)
                {
                    snprintf(last_log_path, PATH_MAX, "%s.last", skw_btsnoop_path);
                    remove(last_log_path);
                    if (!rename(skw_btsnoop_path, last_log_path) && (errno != ENOENT))
                    {
                        ALOGE("%s unable to rename '%s' to btsnoop_hci: %s", __func__, skw_btsnoop_path, strerror(errno));
                        return ;
                    }
                    skwlog_reopen(TRUE);
                }
                else
                {
                    btsnoop_rev_length = file_zie;
                    if(file_zie <= 16)
                    {
                        new_file = TRUE;
                    }
                    else
                    {
                        new_file = FALSE;
                    }
                    skwlog_reopen(new_file);
                }
            }
            else
            {
                if(file_zie > 16)
                {
                    time_t current_time = time(NULL);
                    struct tm *time_created = localtime(&current_time);
                    char config_time_created[sizeof("YYYY-MM-DD-HHMMSS")];
                    strftime(config_time_created, sizeof("YYYY-MM-DD-HHMMSS"), "%Y-%m-%d-%H%M%S", time_created);
                    timestamp = skw_btsnoop_timestamp() - BTSNOOP_EPOCH_DELTA;
                    usec = (uint32_t)(timestamp % 1000000LL);
                    snprintf(last_log_path, PATH_MAX, "%s.%s_%d-%02d", skw_btsnoop_path, config_time_created, usec, btsnoop_cnts++);
                    if (!rename(skw_btsnoop_path, last_log_path) && (errno != ENOENT))
                    {
                        ALOGE("%s unable to rename '%s' to '%s': %s", __func__, skw_btsnoop_path, last_log_path, strerror(errno));
                    }

                }
            }

        }
        else if(skwlog_slice)
        {
            ALOGD("%s btsnoop log file not exist", __func__);
            skwlog_reopen(TRUE);
        }

    }
    else
    {
        snprintf(last_log_path, PATH_MAX, "%s.last", skw_btsnoop_path);
        if (!rename(skw_btsnoop_path, last_log_path) && errno != ENOENT)
        {
            ALOGE("%s unable to rename '%s' to '%s': %s", __func__, skw_btsnoop_path, last_log_path, strerror(errno));
        }
    }

    hci_btsnoop_fd = open(skw_btsnoop_path, O_WRONLY | O_CREAT | O_APPEND, S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP | S_IROTH);

    if (hci_btsnoop_fd < 0)
    {
        ALOGE("%s unable to open '%s': %s", __func__, skw_btsnoop_path, strerror(errno));
        return;
    }

    ALOGD("%s open '%s', fd:%d, is new:%d", __func__, skw_btsnoop_path, hci_btsnoop_fd, new_file);
    //lseek(hci_btsnoop_fd, 0, SEEK_END);
    if(new_file)
    {
        write(hci_btsnoop_fd, "btsnoop\0\0\0\0\1\0\0\x3\xea", 16);

        ALOGD("%s write header", __func__);
    }
}

void skw_btsnoop_init()
{
    pthread_mutex_init(&btsnoop_log_lock, NULL);
    btsnoop_cnts = 0;
    //ALOGD("%s btsnoop log file path:%s", __func__,skw_btsnoop_path);
    skw_btsnoop_open();
}

void skw_btsnoop_close(void)
{
    pthread_mutex_destroy(&btsnoop_log_lock);
    if (hci_btsnoop_fd != -1)
    {
        close(hci_btsnoop_fd);
    }
    hci_btsnoop_fd = -1;
}

static void skw_btsnoop_write(const void *data, size_t length)
{
    if (hci_btsnoop_fd != -1)
    {
        write(hci_btsnoop_fd, data, length);
    }
}

void skw_btsnoop_capture(const uint8_t *packet, char is_received)
{
    int length_he = 0;
    int length    = 0;
    int flags     = 0;
    int drops     = 0;
    if((!btsnoop_log_en) || (hci_btsnoop_fd == -1))
    {
        return ;
    }

    pthread_mutex_lock(&btsnoop_log_lock);

    uint8_t type = packet[0];
    switch (type)
    {
        case HCI_COMMAND_PKT:
            length_he = packet[3] + 4;
            flags = 2;
            break;
        case HCI_ACLDATA_PKT:
        case HCI_ISO_PKT:
            length_he = (packet[4] << 8) + packet[3] + 5;
            flags = is_received;
            break;
        case HCI_SCODATA_PKT:
            length_he = packet[3] + 4;
            flags = is_received;
            break;
        case HCI_EVENT_PKT:
        case HCI_EVENT_SKWLOG:
            length_he = packet[2] + 3;
            flags = 3;
            break;
        default:
            pthread_mutex_unlock(&btsnoop_log_lock);
            return;
            //break;
    }

    btsnoop_rev_length += length_he;

    //SKWBT_LOG("btsnoop_capture type:%d, len:%d", type, length_he);

    uint64_t timestamp = skw_btsnoop_timestamp();
    uint32_t time_hi = timestamp >> 32;
    uint32_t time_lo = timestamp & 0xFFFFFFFF;

    length = htonl(length_he);
    flags = htonl(flags);
    drops = htonl(drops);
    time_hi = htonl(time_hi);
    time_lo = htonl(time_lo);

    skw_btsnoop_write(&length, 4);
    skw_btsnoop_write(&length, 4);
    skw_btsnoop_write(&flags, 4);
    skw_btsnoop_write(&drops, 4);
    skw_btsnoop_write(&time_hi, 4);
    skw_btsnoop_write(&time_lo, 4);

    skw_btsnoop_write(packet, length_he);

    if(btsnoop_rev_length >= SKW_LOG_DEFAULT_SIZE)
    {
        close(hci_btsnoop_fd);
        hci_btsnoop_fd = -1;
        skw_btsnoop_open();
        //skwlog_reopen(TRUE);
    }

    pthread_mutex_unlock(&btsnoop_log_lock);
}
