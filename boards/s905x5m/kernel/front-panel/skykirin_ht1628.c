// SPDX-License-Identifier: GPL-2.0-only
/*
 * BM201 front-panel driver for the Skykirin HT1628-compatible controller.
 *
 * The GPIO assignment, 7-grid/10-segment mode and display RAM layout are
 * derived from the board vendor's Android 5.15 driver.  This implementation
 * uses current kernel APIs and intentionally does not reproduce its private
 * character-device ABI.
 */

#include <linux/bits.h>
#include <linux/delay.h>
#include <linux/device.h>
#include <linux/errno.h>
#include <linux/gpio/consumer.h>
#include <linux/kernel.h>
#include <linux/map_to_7segment.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/of.h>
#include <linux/platform_device.h>
#include <linux/pm.h>
#include <linux/slab.h>
#include <linux/string.h>

#define HT1628_NUM_DIGITS	4
#define HT1628_RAM_BYTES	16
#define HT1628_SYMBOL_ADDR	0xc8
#define HT1628_DELAY_US		10

#define HT1628_CMD_MODE_7X10	0x03
#define HT1628_CMD_DATA_AUTO	0x40
#define HT1628_CMD_DATA_FIXED	0x44
#define HT1628_CMD_DISPLAY	0x80
#define HT1628_DISPLAY_ON	BIT(3)

static const u8 ht1628_digit_addr[HT1628_NUM_DIGITS] = {
	0xc0, 0xc2, 0xc4, 0xc6,
};

static SEG7_DEFAULT_MAP(ht1628_seg7_map);

struct ht1628_panel {
	struct gpio_desc *cs;
	struct gpio_desc *clock;
	struct gpio_desc *data;
	/* Protects cached state and serializes controller transactions. */
	struct mutex lock;
	char text[HT1628_NUM_DIGITS];
	u8 digits[HT1628_NUM_DIGITS];
	u8 symbols;
	u8 brightness;
	bool enabled;
};

static void ht1628_send_byte(struct ht1628_panel *panel, u8 value)
{
	unsigned int bit;

	for (bit = 0; bit < 8; bit++) {
		udelay(HT1628_DELAY_US);
		gpiod_set_value_cansleep(panel->clock, 0);
		gpiod_set_value_cansleep(panel->data, value & BIT(0));
		value >>= 1;
		udelay(HT1628_DELAY_US);
		gpiod_set_value_cansleep(panel->clock, 1);
	}
	udelay(HT1628_DELAY_US);
}

static void ht1628_transaction(struct ht1628_panel *panel, u8 command,
			       const u8 *data, size_t len)
{
	size_t i;

	/* A high-to-low strobe starts one command and the final high ends it. */
	gpiod_set_value_cansleep(panel->cs, 1);
	udelay(HT1628_DELAY_US);
	gpiod_set_value_cansleep(panel->cs, 0);
	ht1628_send_byte(panel, command);
	for (i = 0; i < len; i++)
		ht1628_send_byte(panel, data[i]);
	gpiod_set_value_cansleep(panel->cs, 1);
}

static void ht1628_write_control(struct ht1628_panel *panel, bool enabled)
{
	u8 command = HT1628_CMD_DISPLAY | panel->brightness;

	if (enabled)
		command |= HT1628_DISPLAY_ON;
	ht1628_transaction(panel, command, NULL, 0);
}

static void ht1628_write_digits(struct ht1628_panel *panel)
{
	unsigned int i;

	for (i = 0; i < HT1628_NUM_DIGITS; i++)
		ht1628_transaction(panel, ht1628_digit_addr[i],
				    &panel->digits[i], 1);
}

static void ht1628_write_symbols(struct ht1628_panel *panel)
{
	ht1628_transaction(panel, HT1628_SYMBOL_ADDR, &panel->symbols, 1);
}

static void ht1628_restore(struct ht1628_panel *panel)
{
	u8 clear[HT1628_RAM_BYTES] = { 0 };

	ht1628_transaction(panel, HT1628_CMD_MODE_7X10, NULL, 0);
	ht1628_transaction(panel, HT1628_CMD_DATA_AUTO, NULL, 0);
	ht1628_transaction(panel, ht1628_digit_addr[0], clear, sizeof(clear));
	ht1628_transaction(panel, HT1628_CMD_DATA_FIXED, NULL, 0);
	ht1628_write_digits(panel);
	ht1628_write_symbols(panel);
	ht1628_write_control(panel, panel->enabled);
}

static ssize_t text_show(struct device *dev, struct device_attribute *attr,
			 char *buf)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	char text[HT1628_NUM_DIGITS];

	mutex_lock(&panel->lock);
	memcpy(text, panel->text, sizeof(text));
	mutex_unlock(&panel->lock);

	return sysfs_emit(buf, "%c%c%c%c\n", text[0], text[1], text[2],
			  text[3]);
}

static ssize_t text_store(struct device *dev, struct device_attribute *attr,
			  const char *buf, size_t count)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	char text[HT1628_NUM_DIGITS] = { ' ', ' ', ' ', ' ' };
	u8 digits[HT1628_NUM_DIGITS] = { 0 };
	size_t len = count;
	unsigned int i;
	int mapped;

	if (len && buf[len - 1] == '\n')
		len--;
	if (len > HT1628_NUM_DIGITS)
		return -E2BIG;

	for (i = 0; i < len; i++) {
		if (buf[i] < 0x20 || buf[i] > 0x7e)
			return -EINVAL;
		mapped = map_to_seg7(&ht1628_seg7_map, buf[i]);
		if (mapped < 0)
			return mapped;
		digits[i] = mapped;
		text[i] = buf[i];
	}

	mutex_lock(&panel->lock);
	memcpy(panel->text, text, sizeof(text));
	memcpy(panel->digits, digits, sizeof(digits));
	ht1628_write_digits(panel);
	mutex_unlock(&panel->lock);

	return count;
}
static DEVICE_ATTR_RW(text);

static ssize_t symbols_show(struct device *dev, struct device_attribute *attr,
			    char *buf)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	u8 symbols;

	mutex_lock(&panel->lock);
	symbols = panel->symbols;
	mutex_unlock(&panel->lock);

	return sysfs_emit(buf, "0x%02x\n", symbols);
}

static ssize_t symbols_store(struct device *dev, struct device_attribute *attr,
			     const char *buf, size_t count)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	u8 symbols;
	int ret;

	ret = kstrtou8(buf, 0, &symbols);
	if (ret)
		return ret;

	mutex_lock(&panel->lock);
	panel->symbols = symbols;
	ht1628_write_symbols(panel);
	mutex_unlock(&panel->lock);

	return count;
}
static DEVICE_ATTR_RW(symbols);

static ssize_t brightness_show(struct device *dev,
			       struct device_attribute *attr, char *buf)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	u8 brightness;

	mutex_lock(&panel->lock);
	brightness = panel->brightness;
	mutex_unlock(&panel->lock);

	return sysfs_emit(buf, "%u\n", brightness);
}

static ssize_t brightness_store(struct device *dev,
				struct device_attribute *attr,
				const char *buf, size_t count)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	u8 brightness;
	int ret;

	ret = kstrtou8(buf, 0, &brightness);
	if (ret)
		return ret;
	if (brightness > 7)
		return -ERANGE;

	mutex_lock(&panel->lock);
	panel->brightness = brightness;
	ht1628_write_control(panel, panel->enabled);
	mutex_unlock(&panel->lock);

	return count;
}
static DEVICE_ATTR_RW(brightness);

static ssize_t enabled_show(struct device *dev, struct device_attribute *attr,
			    char *buf)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	bool enabled;

	mutex_lock(&panel->lock);
	enabled = panel->enabled;
	mutex_unlock(&panel->lock);

	return sysfs_emit(buf, "%u\n", enabled);
}

static ssize_t enabled_store(struct device *dev, struct device_attribute *attr,
			     const char *buf, size_t count)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);
	bool enabled;
	int ret;

	ret = kstrtobool(buf, &enabled);
	if (ret)
		return ret;

	mutex_lock(&panel->lock);
	panel->enabled = enabled;
	ht1628_write_control(panel, enabled);
	mutex_unlock(&panel->lock);

	return count;
}
static DEVICE_ATTR_RW(enabled);

static struct attribute *ht1628_attrs[] = {
	&dev_attr_text.attr,
	&dev_attr_symbols.attr,
	&dev_attr_brightness.attr,
	&dev_attr_enabled.attr,
	NULL,
};

static const struct attribute_group ht1628_attr_group = {
	.attrs = ht1628_attrs,
};

static int ht1628_probe(struct platform_device *pdev)
{
	struct device *dev = &pdev->dev;
	struct ht1628_panel *panel;
	int ret;

	panel = devm_kzalloc(dev, sizeof(*panel), GFP_KERNEL);
	if (!panel)
		return -ENOMEM;

	panel->cs = devm_gpiod_get(dev, "cs", GPIOD_OUT_HIGH);
	if (IS_ERR(panel->cs))
		return dev_err_probe(dev, PTR_ERR(panel->cs),
				     "failed to acquire chip-select GPIO\n");

	panel->clock = devm_gpiod_get(dev, "clock", GPIOD_OUT_HIGH);
	if (IS_ERR(panel->clock))
		return dev_err_probe(dev, PTR_ERR(panel->clock),
				     "failed to acquire clock GPIO\n");

	panel->data = devm_gpiod_get(dev, "data", GPIOD_OUT_HIGH);
	if (IS_ERR(panel->data))
		return dev_err_probe(dev, PTR_ERR(panel->data),
				     "failed to acquire data GPIO\n");

	mutex_init(&panel->lock);
	memset(panel->text, ' ', sizeof(panel->text));
	panel->brightness = 7;
	panel->enabled = true;
	platform_set_drvdata(pdev, panel);

	mutex_lock(&panel->lock);
	ht1628_restore(panel);
	mutex_unlock(&panel->lock);

	ret = devm_device_add_group(dev, &ht1628_attr_group);
	if (ret) {
		mutex_lock(&panel->lock);
		ht1628_write_control(panel, false);
		mutex_unlock(&panel->lock);
		return dev_err_probe(dev, ret, "failed to create sysfs controls\n");
	}

	dev_info(dev, "BM201 front panel ready\n");
	return 0;
}

static void ht1628_remove(struct platform_device *pdev)
{
	struct ht1628_panel *panel = platform_get_drvdata(pdev);

	mutex_lock(&panel->lock);
	ht1628_write_control(panel, false);
	mutex_unlock(&panel->lock);
}

static void ht1628_shutdown(struct platform_device *pdev)
{
	ht1628_remove(pdev);
}

static int ht1628_suspend(struct device *dev)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);

	mutex_lock(&panel->lock);
	ht1628_write_control(panel, false);
	mutex_unlock(&panel->lock);
	return 0;
}

static int ht1628_resume(struct device *dev)
{
	struct ht1628_panel *panel = dev_get_drvdata(dev);

	mutex_lock(&panel->lock);
	ht1628_restore(panel);
	mutex_unlock(&panel->lock);
	return 0;
}

static DEFINE_SIMPLE_DEV_PM_OPS(ht1628_pm_ops, ht1628_suspend, ht1628_resume);

static const struct of_device_id ht1628_of_match[] = {
	{ .compatible = "skykirin-ht1628" },
	{ }
};
MODULE_DEVICE_TABLE(of, ht1628_of_match);

static struct platform_driver ht1628_driver = {
	.probe = ht1628_probe,
	.remove_new = ht1628_remove,
	.shutdown = ht1628_shutdown,
	.driver = {
		.name = "skykirin-ht1628",
		.of_match_table = ht1628_of_match,
		.pm = pm_sleep_ptr(&ht1628_pm_ops),
	},
};
module_platform_driver(ht1628_driver);

MODULE_DESCRIPTION("BM201 Skykirin HT1628-compatible front-panel driver");
MODULE_LICENSE("GPL");
