/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

#ifndef __SKW_COMMON_H__
#define __SKW_COMMON_H__

#define SKW_UNUSED(x) (void)(x)
//#define SKW_UNUSED(x) (x = x)

#ifndef TRUE
#define TRUE 1
#endif

#ifndef FALSE
#define FALSE 0
#endif


#ifndef UINT8_TO_STREAM
#define UINT8_TO_STREAM(p, u8)   {*(p)++ = (uint8_t)(u8);}
#endif


#ifndef UINT16_TO_STREAM
#define UINT16_TO_STREAM(p, u16) {*(p)++ = (uint8_t)(u16); *(p)++ = (uint8_t)((u16) >> 8);}
#endif

#ifndef STREAM_TO_UINT16
#define STREAM_TO_UINT16(u16, p) {u16 = ((uint16_t)(*(p)) + (((uint16_t)(*((p) + 1))) << 8)); (p) += 2;}
#endif


#define RW_NO_INTR(func)  do {} while (((func) == -1) && (errno == EINTR))


extern char skwdriverlog_en;
#define SKWBT_LOG(fmt, args...)  do{if(skwdriverlog_en){ALOGD("[SKWBT]:" fmt, ## args);}}while(0)

#define SKW_LOG_DEFAULT_SIZE (300 * 1024 * 1024)//300M


#endif
