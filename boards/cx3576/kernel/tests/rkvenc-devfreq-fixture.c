/* Controlled services for the extracted, unmodified vendor function bodies. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define ENOENT 2
#define EPROBE_DEFER 517
#define IS_ERR(p) ((intptr_t)(p) < 0)
struct device_node { const char *compatible; bool opp; };
struct device { struct device_node *of_node; };
struct clk { int unused; };
struct rockchip_opp_info { int unused; };
struct rkvenc_dev {
    struct { struct clk *clk; } core_clk_info;
    struct rockchip_opp_info opp_info;
    void *mdev_info;
};
struct mpp_dev { struct device *dev; struct rkvenc_dev *enc; };
static struct { struct rockchip_opp_info *opp_info; } venc_mdevp;
static int rockchip_rkvenc_of_match[1];
static int opp_calls, remove_calls, monitor_calls, unregister_calls, errors, info;
static int opp_result, monitor_result;
#define to_rkvenc_dev(mpp) ((mpp)->enc)
#define dev_err(...) (++errors)
#define dev_info(...) (++info)
#define dev_dbg(...) ((void)0)
static bool of_device_is_compatible(struct device_node *node, const char *name)
{ return strcmp(node->compatible, name) == 0; }
static bool of_property_present(struct device_node *node, const char *name)
{ return strcmp(name, "operating-points-v2") == 0 && node->opp; }
static void rockchip_get_opp_data(void *match, struct rockchip_opp_info *opp) {}
static int rockchip_init_opp_table(struct device *dev, struct rockchip_opp_info *opp,
                                 char *clock, char *supply)
{
    ++opp_calls;
    /* The pinned rockchip_init_opp_info returns -ENOENT without a phandle. */
    return dev->of_node->opp ? opp_result : -ENOENT;
}
static void rockchip_uninit_opp_table(struct device *dev, struct rockchip_opp_info *opp)
{ ++remove_calls; }
static void *rockchip_system_monitor_register(struct device *dev, void *profile)
{ ++monitor_calls; return monitor_result ? (void *)(intptr_t)-ENOENT : (void *)1; }
static void rockchip_system_monitor_unregister(void *monitor) { ++unregister_calls; }

/* VENDOR_FUNCTIONS */

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #condition); ++failures; \
} } while (0)
int main(void)
{
    struct device_node node = {"rockchip,rkv-encoder-rk3576-core", false};
    struct device dev = {&node};
    struct clk clk;
    struct rkvenc_dev enc = {.core_clk_info.clk = &clk};
    struct mpp_dev mpp = {&dev, &enc};
    int failures = 0;
    /* Keep stubs available when compiling the pre-fix source under -Werror. */
    (void)of_device_is_compatible;
    (void)of_property_present;
    (void)info;
    CHECK(rkvenc_devfreq_init(&mpp) == 0);
    CHECK(opp_calls == 0 && errors == 0 && monitor_calls == 0);
    CHECK(rkvenc_devfreq_remove(&mpp) == 0 && remove_calls == 0);
    puts("checked RK3576 fixed-rate init and remove");

    opp_calls = remove_calls = errors = 0;
    node.opp = true;
    opp_result = -ENOENT;
    CHECK(rkvenc_devfreq_init(&mpp) == -ENOENT);
    CHECK(opp_calls == 1 && errors == 1);
    opp_result = -EPROBE_DEFER;
    CHECK(rkvenc_devfreq_init(&mpp) == -EPROBE_DEFER);
    CHECK(opp_calls == 2 && errors == 2);
    opp_result = 0;
    CHECK(rkvenc_devfreq_init(&mpp) == 0 && monitor_calls == 1);
    CHECK(rkvenc_devfreq_remove(&mpp) == 0);
    CHECK(remove_calls == 1 && unregister_calls == 1 && enc.mdev_info == NULL);
    monitor_result = 1;
    CHECK(rkvenc_devfreq_init(&mpp) == 0 && enc.mdev_info == NULL);
    CHECK(rkvenc_devfreq_remove(&mpp) == 0 && unregister_calls == 1);
    puts("checked declared OPP error, defer, success and monitor fallback");

    node.compatible = "rockchip,rkv-encoder-rk3588";
    node.opp = false;
    CHECK(rkvenc_devfreq_init(&mpp) == -ENOENT);
    enc.core_clk_info.clk = NULL;
    CHECK(rkvenc_devfreq_init(&mpp) == 0);
    puts("checked other SoC diagnostics and absent clock path");
    if (failures) return 1;
    puts("PASS: vendor encoder OPP lifecycle");
    return 0;
}
