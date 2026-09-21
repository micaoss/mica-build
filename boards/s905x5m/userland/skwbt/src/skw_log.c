/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

#include <time.h>
#include <stdio.h>
#include <pthread.h>
#include <fcntl.h>
#include <math.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <utils/Log.h>
#include <errno.h>
#include <sys/stat.h>
#include "skw_log.h"
#include "skw_common.h"


static pthread_mutex_t skwlog_lock;

static int skwlog_fp = -1;
unsigned int skwlog_rev_length = 0;
unsigned int skwlog_cnts = 0;

extern char skw_btsnoop_path[];
extern char btcp_log_en;
extern char skwlog_slice;
extern char btsnoop_save_log;


void skwlog_open(char new_file)
{
    char log_path[PATH_MAX];
    char basepath[PATH_MAX] = {0};
    char lastpath[PATH_MAX] = {0};
    int  i;
    if(!btcp_log_en)
    {
        return ;
    }

    int size = strlen(skw_btsnoop_path);
    for( i = size - 1; i > 0; i--)//get log dir
    {
        char ch = skw_btsnoop_path[i];
        if((ch == '/') || (ch == '\\'))
        {
            memcpy(basepath, skw_btsnoop_path, i);
            //ALOGD("cp:%d", i);
            break;
        }
    }
    snprintf(log_path, PATH_MAX, "%s/skwlog.log", basepath);

    struct stat buf;
    int fd = -1;
    if(stat(log_path, &buf) == 0)
    {
        fd = open(log_path, O_RDONLY);
    }
    if(fd > 0)
    {
        fstat(fd, &buf);
        int file_zie = (int)buf.st_size;
        close(fd);
        ALOGD("%s cp log file size:%d", __func__, file_zie);
        if(skwlog_slice)
        {
            if(new_file)
            {
                snprintf(lastpath, PATH_MAX, "%s/skwlog-last.log", basepath);
                remove(lastpath);
                if (!rename(log_path, lastpath) && (errno != ENOENT))
                {
                    ALOGE("%s unable to rename '%s' to '%s': %s", __func__, log_path, lastpath, strerror(errno));
                }
            }
            else
            {
                skwlog_rev_length = file_zie;
            }
        }
        else
        {
            if(file_zie > (16 + 12))
            {
                time_t current_time = time(NULL);
                struct tm *time_created = localtime(&current_time);
                char config_time_created[sizeof("YYYY-MM-DD-HHMMSS")];
                strftime(config_time_created, sizeof("YYYY-MM-DD-HHMMSS"), "%Y-%m-%d-%H%M%S", time_created);

                snprintf(lastpath, PATH_MAX, "%s/skwlog-%s_%03d-%02d.log", basepath, config_time_created, rand() % 1000, skwlog_cnts);

                if (!rename(log_path, lastpath) && (errno != ENOENT))
                {
                    ALOGE("%s unable to rename '%s' to '%s': %s", __func__, log_path, lastpath, strerror(errno));
                }

            }
        }
        if(0 == file_zie)
        {
            new_file = TRUE;
        }
    }
    else
    {
        new_file = TRUE;
    }

    //ALOGD("basepath:%d, %s,%s",size, basepath, skw_btsnoop_path);

    ALOGD("skwlog:%s, %s", log_path, lastpath);

    skwlog_fp = open(log_path, O_WRONLY | O_CREAT | O_APPEND, S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP | S_IROTH);

    ALOGD("%s open '%s', fd:%d, is new:%d", __func__, log_path, skwlog_fp, new_file);
    //lseek(skwlog_fp, 0, SEEK_END);
    if(skwlog_fp > 0)
    {
        if(new_file)
        {
            write(skwlog_fp, "skwcplog\0\1\0\2\0\0\x3\xEA", 16);
        }
        //skwlog_print_current_time();
    }
    skwlog_cnts ++;
}

void skwlog_reopen(char new_file)
{
    pthread_mutex_lock(&skwlog_lock);
    skwlog_rev_length = 0;
    if (skwlog_fp != -1)
    {
        close(skwlog_fp);
    }
    skwlog_open(new_file);
    pthread_mutex_unlock(&skwlog_lock);
    if(skwlog_fp > 0)
    {
        skwlog_print_current_time();
    }
}


void skwlog_print_current_time()
{
    time_t current_time = time(NULL);
    struct tm *time_created = localtime(&current_time);

    //
    unsigned char buffer[16] = {0x07, 0xFF, 0x08, 0x00, 0x01, 0xD0, 0x55, 0x55};
    buffer[8] = time_created->tm_sec;//[0,59]
    buffer[9] = time_created->tm_min;//[0,59]
    buffer[10] = time_created->tm_hour;//[0,23]
    buffer[11] = time_created->tm_mday;//[1,31]

    skwlog_write(buffer, 12);
}

void skwlog_init()
{
    pthread_mutex_init(&skwlog_lock, NULL);
    skwlog_fp = -1;
    skwlog_rev_length = 0;
    skwlog_cnts = 0;
    if(btcp_log_en && ((!btsnoop_save_log) || (!skwlog_slice)))
    {
        skwlog_open(TRUE);
        if(skwlog_fp > 0)
        {
            skwlog_print_current_time();
        }
    }
    ALOGD("skwlog_init,en:%d, slice:%d, fd:%d", btcp_log_en, skwlog_slice, skwlog_fp);
}


void skwlog_write(unsigned char *buffer, unsigned int length)
{
    if(skwlog_fp > 0)
    {
        pthread_mutex_lock(&skwlog_lock);

        write(skwlog_fp, buffer, length);
        skwlog_rev_length += length;

        if(skwlog_rev_length >= SKW_LOG_DEFAULT_SIZE)
        {
            skwlog_rev_length = 0;
            close(skwlog_fp);
            skwlog_fp = -1;
            skwlog_open(TRUE);
        }
        pthread_mutex_unlock(&skwlog_lock);
    }
}

void skwlog_close()
{
    pthread_mutex_destroy(&skwlog_lock);
    if (skwlog_fp != -1)
    {
        close(skwlog_fp);
    }
    skwlog_fp = -1;
    skwlog_rev_length = 0;
    skwlog_cnts = 0;
}
