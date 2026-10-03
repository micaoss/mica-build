# SKW Bluetooth vendor library for Linux.

CC ?= aarch64-linux-gnu-gcc
AR ?= aarch64-linux-gnu-ar
STRIP ?= aarch64-linux-gnu-strip
HOSTCC ?= cc

PROJECT_NAME := libskwbt
SRC_DIR := src
INCLUDE_DIR := include
BUILD_DIR := build

SOURCES := $(SRC_DIR)/bt_vendor_skw.c \
	$(SRC_DIR)/scom_vendor.c \
	$(SRC_DIR)/skw_log.c \
	$(SRC_DIR)/skw_btsnoop.c
OBJECTS := $(SOURCES:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)

CFLAGS := -Wall -Wextra -fPIC -O2 -g \
	-DLINUX_BUILD -D_GNU_SOURCE \
	-include $(INCLUDE_DIR)/linux_compat.h \
	-I$(INCLUDE_DIR)
LDFLAGS := -shared -Wl,-soname,$(PROJECT_NAME).so.1

SHARED_LIB := $(BUILD_DIR)/$(PROJECT_NAME).so
STATIC_LIB := $(BUILD_DIR)/$(PROJECT_NAME).a
TRANSPORT_TEST := $(BUILD_DIR)/test_scom_vendor_transport
VENDOR_API_TEST := $(BUILD_DIR)/test_bt_vendor_api

.PHONY: all clean unit-test

all: $(SHARED_LIB) $(STATIC_LIB)

unit-test: $(TRANSPORT_TEST) $(VENDOR_API_TEST)
	$(TRANSPORT_TEST)
	$(VENDOR_API_TEST)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(TRANSPORT_TEST): tests/test_scom_vendor_transport.c src/scom_vendor.c \
		include/scom_vendor.h include/skw_h4.h | $(BUILD_DIR)
	$(HOSTCC) -std=gnu11 -Wall -Wextra -Werror -D_GNU_SOURCE \
		-I. -I$(INCLUDE_DIR) tests/test_scom_vendor_transport.c \
		-lpthread -o $@

$(VENDOR_API_TEST): tests/test_bt_vendor_api.c src/bt_vendor_skw.c \
		include/linux_compat.h include/bt_vendor_skw.h | $(BUILD_DIR)
	$(HOSTCC) -std=gnu11 -Wall -Wextra -Werror -D_GNU_SOURCE \
		-I. -I$(INCLUDE_DIR) tests/test_bt_vendor_api.c -o $@

$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(SHARED_LIB): $(OBJECTS)
	$(CC) $(LDFLAGS) -o $@ $^

$(STATIC_LIB): $(OBJECTS)
	$(AR) rcs $@ $^

clean:
	rm -rf $(BUILD_DIR)
