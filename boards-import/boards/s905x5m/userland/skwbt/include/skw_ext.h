/******************************************************************************
 *
 *  Copyright (C) 2020-2021 SeekWave Technology
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 ******************************************************************************/
#ifndef __SKW_EXT_H__
#define __SKW_EXT_H__

#define BLE_ADV_WAKEUP_ENABLE 0



#define BLE_ADV_WAKEUP_GRP_NUMS 3

typedef struct
{
    uint8_t grp_len;
    uint8_t addr_offset;
    uint8_t data[32];
    uint8_t mask[32];
} Wakeup_ADV_Grp_St;

typedef struct
{
    uint8_t gpio_no;
    uint8_t level;
    uint8_t data_len;//total len
    uint8_t grp_nums;
    Wakeup_ADV_Grp_St adv_group[BLE_ADV_WAKEUP_GRP_NUMS];
} Wakeup_ADV_Info_St;


void skw_ext_inotify_thread_init(void);

void skw_ext_inotify_thread_exit(void);



#endif
