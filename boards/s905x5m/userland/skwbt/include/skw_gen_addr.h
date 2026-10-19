/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/

#ifndef __SKW_GEN_ADDR_H__
#define __SKW_GEN_ADDR_H__

void skw_addr_gen_init();

void skw_addr_get(unsigned char *buffer);

char skw_addr_from_ap(unsigned char *bd_addr);


#endif
