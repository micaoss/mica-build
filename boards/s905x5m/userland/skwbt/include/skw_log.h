/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

#ifndef __SKW_LOG_H__
#define __SKW_LOG_H__

void skwlog_init();

void skwlog_reopen(char new_file);

void skwlog_print_current_time();

void skwlog_write(unsigned char *buffer, unsigned int length);

void skwlog_close();


#endif
