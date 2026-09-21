SKW_SRC_ROOT := $(shell pwd)
SKW_EXTRA_INC := $(SKW_SRC_ROOT)/include/linux/platform_data
SKW_EXTRA_SYMBOLS := $(M)/drivers/seekwaveplatform/Module.symvers

.PHONY: skw_wifi skw_bsp

all: skw_bsp skw_wifi
	echo "seekwave modules build compelete"

skw_wifi: skw_bsp
	$(MAKE) ARCH=$(ARCH) CROSS_COMPILE=$(CROSS_COMPILE) -C $(KERNEL_SRC) M=$(M)/drivers/skwifi modules \
		CONFIG_WLAN_VENDOR_SEEKWAVE=m CONFIG_SKW_VENDOR=m \
		skw_extra_flags="-I$(SKW_EXTRA_INC) -I$(M)/drivers/skwifi -I$(SKW_SRC_ROOT)/drivers/skwifi -include $(SKW_EXTRA_INC)/skw6160_config.h" \
		skw_extra_symbols=$(SKW_EXTRA_SYMBOLS)

skw_bsp:
	$(MAKE) ARCH=$(ARCH) CROSS_COMPILE=$(CROSS_COMPILE) -C $(KERNEL_SRC) M=$(M)/drivers/seekwaveplatform modules \
		CONFIG_SKW_SDIOHAL=m CONFIG_SEEKWAVE_BSP_DRIVERS=y CONFIG_SKW_BSP_UCOM=m CONFIG_SKW_BSP_BOOT=m \
		skw_extra_flags="-I$(SKW_EXTRA_INC)" \
		skw_extra_symbols=$(SKW_EXTRA_SYMBOLS)


modules_install:
	$(MAKE) INSTALL_MOD_STRIP=1 -C $(KERNEL_SRC) M=$(M)/drivers/seekwaveplatform modules_install
	$(MAKE) INSTALL_MOD_STRIP=1 -C $(KERNEL_SRC) M=$(M)/drivers/skwifi modules_install
	mkdir -p $(OUT_DIR)/../vendor_lib/modules/
	find $(OUT_DIR)/$(M)/ -name "*.ko" -exec cp {} $(OUT_DIR)/../vendor_lib/modules/ \;
