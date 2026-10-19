// SPDX-License-Identifier: GPL-2.0+
/* Run the actual RK3576 clock callback and DesignWare probe/start with fake MMIO. */
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stddef.h>
#include <dt-bindings/clock/rockchip,rk3576-cru.h>

#define __iomem
#define __maybe_unused __attribute__((unused))
#define CONFIG_CLK 1
#define CONFIG_DM_RESET 0
#define CONFIG_IS_ENABLED(option) CONFIG_##option
#define BIT(n) (1UL << (n))
#define clamp(value, low, high) ((value) < (low) ? (low) : ((value) > (high) ? (high) : (value)))
#define UCLASS_WDT 1
#define DM_FLAG_PRE_RELOC 1
#define U_BOOT_DRIVER(name) struct driver name

typedef unsigned long ulong;
typedef uint64_t u64;
struct reset_ctl_bulk { int unused; };
struct udevice { void *priv; void *base; };
struct clk { struct udevice *dev; unsigned long id; };
struct rk3576_cru { uint32_t clkgate_con[80]; };
struct rk3576_clk_priv { struct rk3576_cru *cru; };
struct udevice_id { const char *compatible; };
struct wdt_ops {
    int (*start)(struct udevice *, u64, ulong);
    int (*reset)(struct udevice *);
    int (*stop)(struct udevice *);
};
struct driver {
    const char *name;
    int id;
    const struct udevice_id *of_match;
    size_t priv_auto;
    int (*probe)(struct udevice *);
    const struct wdt_ops *ops;
    int flags;
};
static struct rk3576_cru cru;
static struct rk3576_clk_priv clock_priv = { &cru };
static struct udevice clock_device = { &clock_priv, NULL };
static unsigned long clock_id = TCLK_WDT0;
static inline void *dev_get_priv(struct udevice *dev) { return dev->priv; }
static inline void *dev_remap_addr(struct udevice *dev) { return dev->base; }
static inline void rk_clrreg(uint32_t *reg, uint32_t bits) { *reg &= ~bits; }
static inline uint32_t readl(const void *reg) { return *(const uint32_t *)reg; }
static inline void writel(uint32_t value, void *reg) { *(uint32_t *)reg = value; }
static inline int fls(unsigned int value) { return value ? 32 - __builtin_clz(value) : 0; }
static inline void *dev_ofnode(struct udevice *dev) { return dev; }
static inline const void *ofnode_read_prop(void *node, const char *name, int *length)
{ (void)node; (void)name; *length = 0; return NULL; }
static inline int reset_assert_bulk(struct reset_ctl_bulk *r) { (void)r; return 0; }
static inline int reset_deassert_bulk(struct reset_ctl_bulk *r) { (void)r; return 0; }
static inline int reset_get_bulk(struct udevice *d, struct reset_ctl_bulk *r)
{ (void)d; (void)r; return 0; }
#include "clock-enable.h"
static int clk_get_by_index(struct udevice *dev, int index, struct clk *clk)
{ (void)dev; assert(index == 0); clk->dev = &clock_device; clk->id = clock_id; return 0; }
/* Non-CCF clk_enable returns ENOSYS when its provider has no enable callback. */
static int clk_enable(struct clk *clk) { return rk3576_enable ? rk3576_enable(clk) : -ENOSYS; }
static unsigned long clk_get_rate(struct clk *clk)
{ assert(clk->id == TCLK_WDT0); return 24000000; }
#include "watchdog-driver.h"

int main(void)
{
    uint32_t registers[64] = {0};
    struct designware_wdt_priv priv = {0};
    struct udevice watchdog = { &priv, registers };
    cru.clkgate_con[16] = 0xffff;
    int ret = designware_wdt_probe(&watchdog);
    fprintf(stderr, "RK3576 watchdog probe returned %d\n", ret);
    assert(ret == 0);
    assert(cru.clkgate_con[16] == (0xffff & ~(BIT(7) | BIT(8))));
    assert(priv.clk_khz == 24000);
    assert(designware_wdt_start(&watchdog, 120000, 0) == 0);
    assert(registers[DW_WDT_CR / 4] == 1);
    assert(registers[DW_WDT_TORR / 4] == 0xff);
    assert(registers[DW_WDT_CRR / 4] == 0x76);
    struct clk bus = { &clock_device, PCLK_WDT0 };
    cru.clkgate_con[16] = 0xffff;
    assert(clk_enable(&bus) == 0);
    assert(cru.clkgate_con[16] == (0xffff & ~BIT(7)));
    clock_id = PCLK_SPI0;
    assert(designware_wdt_probe(&watchdog) == -ENOSYS);
    puts("RK3576_WATCHDOG_DRIVER_PASS: probe, both clock gates, arm, feed and unknown clock refusal");
    return 0;
}
