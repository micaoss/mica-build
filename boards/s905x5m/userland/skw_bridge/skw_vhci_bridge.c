/*
 * Seekwave Bluetooth vHCI bridge.
 *
 * The chip speaks HCI over SDIO character devices opened by libskwbt; the
 * kernel Bluetooth stack speaks HCI over /dev/vhci. This process is the pipe
 * between them and nothing more.
 *
 * That restraint is the whole design. HCI is asynchronous: the controller
 * raises events on its own (Connect Request, inquiry results), a command may
 * be answered by Command Status now and a completion event later, and several
 * commands can be outstanding at once. Matching replies to commands is the
 * kernel's job, and it is the only party with the state to do it correctly.
 * A bridge that tries to help -- pairing each command with whatever it happens
 * to read next, or answering on the controller's behalf -- corrupts that
 * stream. The previous implementation did both, which is why Read Class of
 * Device timed out, the kernel logged "unexpected event for opcode", and
 * pairing never completed.
 *
 * So: once the adapter is registered, forward bytes in both directions
 * unchanged. Before registration, perform the one piece of controller setup
 * that this board needs: write and verify its stable address. Doing that before
 * /dev/vhci is opened ensures the kernel's first Read BD_ADDR sees the real
 * value instead of caching the firmware default.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <fcntl.h>
#include <poll.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>
#include "include/linux_compat.h"
#include "include/skw_h4.h"

#define HCI_COMMAND_PKT 0x01
#define HCI_ACLDATA_PKT 0x02
#define HCI_SCODATA_PKT 0x03
#define HCI_EVENT_PKT   0x04
#define HCI_VENDOR_PKT  0xff

#define HCI_EVENT_COMMAND_COMPLETE 0x0e

#define HCI_RESET                0x0c03
#define HCI_READ_BD_ADDR         0x1009
#define HCI_READ_BUFFER_SIZE     0x1005
#define HCI_WRITE_BD_ADDR        0xfc82

#define BD_ADDR_LEN              6
#define HCI_MAX_EVENT_SIZE       258
#define CONTROLLER_CMD_TIMEOUT_MS 2000
#define VENDOR_OPEN_ATTEMPTS     15
#define VENDOR_OPEN_RETRY_MS     1000

#ifndef SKWBT_BDADDR_FILE
#define SKWBT_BDADDR_FILE "/etc/bluetooth/bdaddr"
#endif

/* Channels handed back by BT_VND_OP_USERIAL_OPEN. The command and event
 * channels are separate here, which is why reading only fds[0] left the
 * kernel's RX counters at zero however much traffic the chip produced. */
#define CH_CMD  0
#define CH_EVT  1

static int vhci_fd = -1;
static int vendor_fds[CH_MAX];
static bt_vendor_interface_t *vendor_interface;
static void *lib_handle;
static int vendor_initialized;
static int vendor_channels_open;
static atomic_int running = 1;
static atomic_int runtime_failed = 0;
static int signal_fds[2] = { -1, -1 };
static size_t controller_acl_mtu;
static size_t controller_sco_mtu;

/* The vendor interface requires these callbacks even when FW_CFG is unused. */
static void *bridge_alloc(int size) { return malloc(size); }
static void bridge_dealloc(void *p_buf) { free(p_buf); }

static uint8_t bridge_xmit_cb(uint16_t opcode, void *p_buf, tINT_CMD_CPLT_CBACK p_cback)
{
    (void)opcode;
    (void)p_buf;
    (void)p_cback;
    return 0;
}

static void bridge_epilog_cb(uint8_t status) { (void)status; }
static void bridge_a2dp_offload_cb(int op, int codec, int rate)
{
    (void)op; (void)codec; (void)rate;
}

static void bridge_fwcfg_cb(uint8_t status) { (void)status; }

static const bt_vendor_callbacks_t bridge_callbacks = {
    .size = sizeof(bt_vendor_callbacks_t),
    .alloc = bridge_alloc,
    .dealloc = bridge_dealloc,
    .xmit_cb = bridge_xmit_cb,
    .epilog_cb = bridge_epilog_cb,
    .fwcfg_cb = bridge_fwcfg_cb,
    .a2dp_offload_cb = bridge_a2dp_offload_cb,
};

static void reset_shutdown_state(void)
{
    atomic_store(&runtime_failed, 0);
    atomic_store(&running, 1);
}

static void request_shutdown(int fatal)
{
    if (fatal)
        atomic_store(&runtime_failed, 1);
    atomic_store(&running, 0);
}

static int bridge_should_run(void)
{
    return atomic_load(&running);
}

static void on_signal(int sig)
{
    int saved_errno = errno;
    uint8_t stop = 1;

    (void)sig;
    if (signal_fds[1] >= 0)
        (void)write(signal_fds[1], &stop, sizeof(stop));
    errno = saved_errno;
}

static int consume_signal_request(void)
{
    uint8_t buf[32];
    int requested = 0;

    if (signal_fds[0] < 0)
        return 0;

    for (;;) {
        ssize_t n = read(signal_fds[0], buf, sizeof(buf));
        if (n > 0) {
            requested = 1;
            continue;
        }
        if (n < 0 && errno == EINTR)
            continue;
        break;
    }

    if (requested)
        request_shutdown(0);
    return requested;
}

static int setup_signal_handling(void)
{
    struct sigaction action = { 0 };
    struct sigaction ignore = { 0 };

    if (pipe2(signal_fds, O_CLOEXEC | O_NONBLOCK) < 0)
        return -1;

    sigemptyset(&action.sa_mask);
    action.sa_handler = on_signal;
    sigemptyset(&ignore.sa_mask);
    ignore.sa_handler = SIG_IGN;

    if (sigaction(SIGINT, &action, NULL) < 0 ||
        sigaction(SIGTERM, &action, NULL) < 0 ||
        sigaction(SIGPIPE, &ignore, NULL) < 0) {
        close(signal_fds[0]);
        close(signal_fds[1]);
        signal_fds[0] = -1;
        signal_fds[1] = -1;
        return -1;
    }
    return 0;
}

static void cleanup_signal_handling(void)
{
    struct sigaction ignore = { 0 };

    sigemptyset(&ignore.sa_mask);
    ignore.sa_handler = SIG_IGN;
    (void)sigaction(SIGINT, &ignore, NULL);
    (void)sigaction(SIGTERM, &ignore, NULL);

    if (signal_fds[0] >= 0)
        close(signal_fds[0]);
    if (signal_fds[1] >= 0)
        close(signal_fds[1]);
    signal_fds[0] = -1;
    signal_fds[1] = -1;
}

static int wait_writable(int fd)
{
    for (;;) {
        struct pollfd pfds[2] = {
            { .fd = fd, .events = POLLOUT },
            { .fd = signal_fds[0], .events = POLLIN },
        };
        int ready = poll(pfds, 2, 500);

        if (ready < 0) {
            if (errno == EINTR) {
                consume_signal_request();
                if (!bridge_should_run())
                    return -1;
                continue;
            }
            return -1;
        }
        if (pfds[1].revents)
            consume_signal_request();
        if (!bridge_should_run())
            return -1;
        if (pfds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) {
            errno = EPIPE;
            return -1;
        }
        if (pfds[0].revents & POLLOUT)
            return 0;
    }
}

static ssize_t write_all(int fd, const uint8_t *buf, size_t len)
{
    size_t done = 0;

    while (done < len) {
        ssize_t n = write(fd, buf + done, len - done);
        if (n > 0) {
            done += (size_t)n;
            continue;
        }
        if (n < 0 && errno == EINTR) {
            consume_signal_request();
            if (!bridge_should_run())
                return -1;
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (wait_writable(fd) == 0)
                continue;
            return -1;
        }
        if (n == 0)
            errno = EIO;
        return -1;
    }
    return (ssize_t)done;
}

static int write_vhci_frame(int fd, const uint8_t *buf, size_t len)
{
    for (;;) {
        ssize_t written = write(fd, buf, len);

        if (written == (ssize_t)len)
            return 0;
        if (written < 0 && errno == EINTR) {
            consume_signal_request();
            if (!bridge_should_run())
                return -1;
            continue;
        }
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (wait_writable(fd) == 0)
                continue;
            return -1;
        }
        if (written >= 0)
            errno = EIO;
        return -1;
    }
}

static int hex_nibble(char ch)
{
    if (ch >= '0' && ch <= '9')
        return ch - '0';
    if (ch >= 'a' && ch <= 'f')
        return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F')
        return ch - 'A' + 10;
    return -1;
}

static int parse_bdaddr_text(const char *text, uint8_t addr[BD_ADDR_LEN])
{
    uint8_t display[BD_ADDR_LEN];
    int all_zero = 1;
    int all_ff = 1;

    if (!text || strcspn(text, "\r\n") != 17)
        return -1;

    for (int i = 0; i < BD_ADDR_LEN; i++) {
        size_t pos = (size_t)i * 3;
        int high = hex_nibble(text[pos]);
        int low = hex_nibble(text[pos + 1]);

        if (high < 0 || low < 0)
            return -1;
        if (i < BD_ADDR_LEN - 1 && text[pos + 2] != ':')
            return -1;

        display[i] = (uint8_t)((high << 4) | low);
        all_zero &= display[i] == 0;
        all_ff &= display[i] == 0xff;
    }

    for (size_t pos = 17; text[pos] != '\0'; pos++)
        if (text[pos] != '\n' && text[pos] != '\r')
            return -1;

    if (all_zero || all_ff)
        return -1;

    for (int i = 0; i < BD_ADDR_LEN; i++)
        addr[i] = display[BD_ADDR_LEN - 1 - i];
    return 0;
}

static int read_bdaddr_file(const char *path, uint8_t addr[BD_ADDR_LEN])
{
    char text[64];
    FILE *fp = fopen(path, "r");

    if (!fp) {
        fprintf(stderr, "vhci: open %s: %s\n", path, strerror(errno));
        return -1;
    }
    if (!fgets(text, sizeof(text), fp)) {
        fprintf(stderr, "vhci: read %s: %s\n", path,
                ferror(fp) ? strerror(errno) : "empty file");
        fclose(fp);
        return -1;
    }
    if (fgetc(fp) != EOF) {
        fprintf(stderr, "vhci: address in %s has trailing data\n", path);
        fclose(fp);
        return -1;
    }
    fclose(fp);

    if (parse_bdaddr_text(text, addr) < 0) {
        fprintf(stderr, "vhci: invalid Bluetooth address in %s\n", path);
        return -1;
    }
    return 0;
}

static int64_t monotonic_ms(void)
{
    struct timespec ts;

    if (clock_gettime(CLOCK_MONOTONIC, &ts) < 0)
        return -1;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int read_exact_until(int fd, uint8_t *buf, size_t len, int64_t deadline)
{
    size_t done = 0;

    while (done < len) {
        int64_t now = monotonic_ms();
        if (now < 0)
            return -1;

        int remaining = deadline > now ? (int)(deadline - now) : 0;
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int ready = poll(&pfd, 1, remaining);

        if (ready < 0) {
            if (errno == EINTR) {
                consume_signal_request();
                if (!bridge_should_run())
                    return -1;
                continue;
            }
            return -1;
        }
        if (ready == 0) {
            errno = ETIMEDOUT;
            return -1;
        }
        if (!(pfd.revents & POLLIN) &&
            (pfd.revents & (POLLERR | POLLHUP | POLLNVAL))) {
            errno = EIO;
            return -1;
        }

        ssize_t n = read(fd, buf + done, len - done);
        if (n > 0) {
            done += (size_t)n;
            continue;
        }
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) {
            consume_signal_request();
            if (!bridge_should_run())
                return -1;
            continue;
        }
        if (n == 0)
            errno = EPIPE;
        return -1;
    }
    return 0;
}

static int read_h4_event(int fd, uint8_t *event, size_t capacity,
                         size_t *event_len, int timeout_ms)
{
    int64_t now = monotonic_ms();
    if (now < 0)
        return -1;
    int64_t deadline = now + timeout_ms;

    if (capacity < 3) {
        errno = EMSGSIZE;
        return -1;
    }
    if (read_exact_until(fd, event, 1, deadline) < 0)
        return -1;
    if (event[0] != HCI_EVENT_PKT) {
        errno = EPROTO;
        return -1;
    }
    if (read_exact_until(fd, event + 1, 2, deadline) < 0)
        return -1;

    size_t total = (size_t)event[2] + 3;
    if (total > capacity) {
        errno = EMSGSIZE;
        return -1;
    }
    if (read_exact_until(fd, event + 3, total - 3, deadline) < 0)
        return -1;

    *event_len = total;
    return 0;
}

static int controller_command(int tx_fd, int rx_fd, uint16_t opcode,
                              const uint8_t *params, size_t params_len,
                              uint8_t *return_params, size_t return_capacity,
                              size_t *return_len, int timeout_ms)
{
    uint8_t command[1 + 3 + 255];
    uint8_t event[HCI_MAX_EVENT_SIZE];
    size_t event_len;

    if (params_len > 255) {
        errno = EMSGSIZE;
        return -1;
    }

    command[0] = HCI_COMMAND_PKT;
    command[1] = (uint8_t)(opcode & 0xff);
    command[2] = (uint8_t)(opcode >> 8);
    command[3] = (uint8_t)params_len;
    if (params_len)
        memcpy(command + 4, params, params_len);

    if (write_all(tx_fd, command, params_len + 4) < 0) {
        fprintf(stderr, "vhci: write command 0x%04x: %s\n", opcode,
                strerror(errno));
        return -1;
    }
    if (read_h4_event(rx_fd, event, sizeof(event), &event_len, timeout_ms) < 0) {
        fprintf(stderr, "vhci: read response for 0x%04x: %s\n", opcode,
                strerror(errno));
        return -1;
    }
    if (event_len < 7 || event[1] != HCI_EVENT_COMMAND_COMPLETE ||
        event[2] < 4) {
        fprintf(stderr, "vhci: malformed response for 0x%04x\n", opcode);
        errno = EPROTO;
        return -1;
    }

    uint16_t response_opcode = (uint16_t)event[4] |
                               ((uint16_t)event[5] << 8);
    if (response_opcode != opcode) {
        fprintf(stderr, "vhci: response opcode 0x%04x while waiting for 0x%04x\n",
                response_opcode, opcode);
        errno = EPROTO;
        return -1;
    }
    if (event[6] != 0) {
        fprintf(stderr, "vhci: command 0x%04x failed with status 0x%02x\n",
                opcode, event[6]);
        errno = EIO;
        return -1;
    }

    size_t result_len = (size_t)event[2] - 4;
    if (result_len > return_capacity) {
        errno = EMSGSIZE;
        return -1;
    }
    if (result_len && return_params)
        memcpy(return_params, event + 7, result_len);
    if (return_len)
        *return_len = result_len;
    return 0;
}

static int configure_controller_address_with_timeout(
    int tx_fd, int rx_fd, const uint8_t addr[BD_ADDR_LEN], int timeout_ms)
{
    uint8_t actual[BD_ADDR_LEN] = { 0 };
    size_t actual_len = 0;

    if (controller_command(tx_fd, rx_fd, HCI_WRITE_BD_ADDR,
                           addr, BD_ADDR_LEN, NULL, 0, NULL,
                           timeout_ms) < 0 ||
        controller_command(tx_fd, rx_fd, HCI_RESET,
                           NULL, 0, NULL, 0, NULL,
                           timeout_ms) < 0 ||
        controller_command(tx_fd, rx_fd, HCI_READ_BD_ADDR,
                           NULL, 0, actual, sizeof(actual), &actual_len,
                           timeout_ms) < 0)
        return -1;

    if (actual_len != BD_ADDR_LEN || memcmp(actual, addr, BD_ADDR_LEN) != 0) {
        fprintf(stderr,
                "vhci: controller address verification failed: "
                "expected %02X:%02X:%02X:%02X:%02X:%02X, "
                "got %02X:%02X:%02X:%02X:%02X:%02X\n",
                addr[5], addr[4], addr[3], addr[2], addr[1], addr[0],
                actual[5], actual[4], actual[3], actual[2], actual[1], actual[0]);
        errno = EIO;
        return -1;
    }

    printf("[SKW] controller address verified: "
           "%02X:%02X:%02X:%02X:%02X:%02X\n",
           addr[5], addr[4], addr[3], addr[2], addr[1], addr[0]);
    return 0;
}

static int configure_controller_address(int tx_fd, int rx_fd,
                                        const uint8_t addr[BD_ADDR_LEN])
{
    return configure_controller_address_with_timeout(
        tx_fd, rx_fd, addr, CONTROLLER_CMD_TIMEOUT_MS);
}

static int read_controller_buffer_sizes_with_timeout(int tx_fd, int rx_fd,
                                                     int timeout_ms)
{
    uint8_t sizes[7] = { 0 };
    size_t sizes_len = 0;

    if (controller_command(tx_fd, rx_fd, HCI_READ_BUFFER_SIZE,
                           NULL, 0, sizes, sizeof(sizes), &sizes_len,
                           timeout_ms) < 0)
        return -1;
    if (sizes_len < sizeof(sizes)) {
        fprintf(stderr, "vhci: malformed Read Buffer Size response\n");
        errno = EPROTO;
        return -1;
    }

    size_t acl_mtu = (size_t)sizes[0] | ((size_t)sizes[1] << 8);
    size_t sco_mtu = sizes[2];
    if (acl_mtu == 0 || acl_mtu > SKW_H4_KERNEL_MAX_FRAME - 5 ||
        sco_mtu > SKW_H4_SCO_MAX_FRAME - 4) {
        fprintf(stderr, "vhci: unsupported controller buffers: ACL %zu, SCO %zu\n",
                acl_mtu, sco_mtu);
        errno = EMSGSIZE;
        return -1;
    }

    controller_acl_mtu = acl_mtu;
    controller_sco_mtu = sco_mtu;
    printf("[SKW] controller buffers: ACL %zu, SCO %zu\n",
           controller_acl_mtu, controller_sco_mtu);
    return 0;
}

static int read_controller_buffer_sizes(int tx_fd, int rx_fd)
{
    return read_controller_buffer_sizes_with_timeout(
        tx_fd, rx_fd, CONTROLLER_CMD_TIMEOUT_MS);
}

static size_t controller_frame_limit(uint8_t type)
{
    switch (type) {
    case SKW_H4_EVENT_PKT:
        return SKW_H4_EVENT_MAX_FRAME;
    case SKW_H4_ACL_PKT:
        return controller_acl_mtu ? controller_acl_mtu + 5 : 0;
    case SKW_H4_SCO_PKT:
        return controller_sco_mtu ? controller_sco_mtu + 4 : 0;
    case SKW_H4_ISO_PKT:
        return SKW_H4_ISO_MAX_FRAME;
    case SKW_H4_LOG_PKT:
        return SKW_H4_STREAM_CAPACITY;
    default:
        return 0;
    }
}

static size_t host_frame_limit(uint8_t type)
{
    switch (type) {
    case SKW_H4_COMMAND_PKT:
        return SKW_H4_COMMAND_MAX_FRAME;
    case SKW_H4_ACL_PKT:
        return controller_acl_mtu ? controller_acl_mtu + 5 : 0;
    case SKW_H4_SCO_PKT:
        return controller_sco_mtu ? controller_sco_mtu + 4 : 0;
    case SKW_H4_ISO_PKT:
        return SKW_H4_ISO_MAX_FRAME;
    default:
        return 0;
    }
}

static int frame_within_limit(const struct skw_h4_frame *frame, size_t limit)
{
    return limit > 0 && frame->frame_size <= limit &&
           frame->frame_size <= SKW_H4_KERNEL_MAX_FRAME;
}

static int validate_host_frame(const uint8_t *buffer, size_t length)
{
    struct skw_h4_frame frame;
    enum skw_h4_status status = skw_h4_decode(buffer, length, &frame);

    if (status == SKW_H4_COMPLETE && frame.type == SKW_H4_ISO_PKT &&
        (buffer[4] & 0xc0U))
        return 0;
    return status == SKW_H4_COMPLETE && frame.frame_size == length &&
           frame_within_limit(&frame, host_frame_limit(frame.type));
}

/* Chip to kernel. Preserve one complete H4 frame per /dev/vhci write. */
static void *chip_to_kernel(void *arg)
{
    (void)arg;
    struct pollfd fds[CH_MAX];
    struct skw_h4_stream streams[CH_MAX] = { 0 };
    int nfds = 0;

    /*
     * USERIAL_OPEN hands back one entry per logical channel, but on this part
     * they are all the same descriptor -- the chip multiplexes commands,
     * events and audio over a single SDIO port. Poll each distinct fd once;
     * listing a duplicate would just wake us twice for the same data.
     */
    for (int ch = 0; ch < CH_MAX; ch++) {
        if (vendor_fds[ch] < 0)
            continue;

        int seen = 0;
        for (int i = 0; i < nfds; i++)
            if (fds[i].fd == vendor_fds[ch])
                seen = 1;
        if (seen)
            continue;

        fds[nfds].fd = vendor_fds[ch];
        fds[nfds].events = POLLIN;
        nfds++;
    }
    if (!nfds) {
        fprintf(stderr, "vhci: no vendor channels to read\n");
        request_shutdown(1);
        return NULL;
    }

    while (bridge_should_run()) {
        int ready = poll(fds, nfds, 500);
        if (ready < 0) {
            if (errno == EINTR) {
                consume_signal_request();
                continue;
            }
            fprintf(stderr, "vhci: poll on vendor channels: %s\n", strerror(errno));
            request_shutdown(1);
            break;
        }
        consume_signal_request();
        if (!bridge_should_run())
            break;

        for (int i = 0; i < nfds && ready > 0; i++) {
            short revents = fds[i].revents;
            if (!revents)
                continue;
            ready--;

            if (revents & POLLNVAL) {
                fprintf(stderr, "vhci: invalid vendor channel fd %d\n",
                        fds[i].fd);
                request_shutdown(1);
                break;
            }

            if (revents & POLLIN) {
                size_t available = sizeof(streams[i].data) - streams[i].length;
                if (available == 0) {
                    fprintf(stderr, "vhci: vendor frame exceeds %zu bytes\n",
                            sizeof(streams[i].data));
                    request_shutdown(1);
                    break;
                }

                ssize_t n = read(fds[i].fd,
                                 streams[i].data + streams[i].length,
                                 available);
                if (n <= 0) {
                    if (n < 0 && (errno == EINTR || errno == EAGAIN))
                        continue;
                    fprintf(stderr, "vhci: vendor channel closed: %s\n",
                            n < 0 ? strerror(errno) : "eof");
                    request_shutdown(1);
                    break;
                }
                streams[i].length += (size_t)n;

                while (streams[i].length > 0) {
                    struct skw_h4_frame frame;
                    enum skw_h4_status status =
                        skw_h4_stream_next(&streams[i], &frame);
                    size_t limit = controller_frame_limit(frame.type);

                    int size_valid = frame.type == SKW_H4_LOG_PKT
                        ? frame.frame_size <= limit
                        : frame_within_limit(&frame, limit);
                    if (status == SKW_H4_INVALID || limit == 0 ||
                        (frame.frame_size != 0 && !size_valid)) {
                        fprintf(stderr,
                                "vhci: invalid controller frame type 0x%02x, size %zu\n",
                                frame.type, frame.frame_size);
                        request_shutdown(1);
                        break;
                    }
                    if (status == SKW_H4_INCOMPLETE)
                        break;
                    if (frame.type != SKW_H4_LOG_PKT &&
                        write_vhci_frame(vhci_fd, streams[i].data,
                                         frame.frame_size) < 0) {
                        if (bridge_should_run()) {
                            fprintf(stderr, "vhci: write to kernel failed: %s\n",
                                    strerror(errno));
                            request_shutdown(1);
                        }
                        break;
                    }
                    if (frame.type == SKW_H4_LOG_PKT)
                        fprintf(stderr, "vhci: dropped %zu-byte SKWLOG frame\n",
                                frame.frame_size);
                    (void)skw_h4_stream_consume(&streams[i], frame.frame_size);
                }
                if (!bridge_should_run())
                    break;
            }

            if (revents & (POLLERR | POLLHUP)) {
                fprintf(stderr, "vhci: vendor channel fd %d closed (revents 0x%x)\n",
                        fds[i].fd, (unsigned int)revents);
                request_shutdown(1);
                break;
            }
        }
    }

    return NULL;
}

/* Kernel to chip. Commands and outbound data, verbatim. */
static void kernel_to_chip(void)
{
    uint8_t buf[SKW_H4_KERNEL_MAX_FRAME];

    while (bridge_should_run()) {
        struct pollfd pfds[2] = {
            { .fd = vhci_fd, .events = POLLIN },
            { .fd = signal_fds[0], .events = POLLIN },
        };

        int ready = poll(pfds, 2, 500);
        if (ready < 0) {
            if (errno == EINTR) {
                consume_signal_request();
                continue;
            }
            fprintf(stderr, "vhci: poll on /dev/vhci: %s\n", strerror(errno));
            request_shutdown(1);
            return;
        }
        if (pfds[1].revents)
            consume_signal_request();
        if (!bridge_should_run())
            return;
        if (!ready)
            continue;

        short revents = pfds[0].revents;
        if (revents & POLLNVAL) {
            fprintf(stderr, "vhci: invalid /dev/vhci fd %d\n", vhci_fd);
            request_shutdown(1);
            return;
        }
        if (!(revents & POLLIN)) {
            if (revents & (POLLERR | POLLHUP)) {
                fprintf(stderr, "vhci: /dev/vhci closed (revents 0x%x)\n",
                        (unsigned int)revents);
                request_shutdown(1);
                return;
            }
            continue;
        }

        ssize_t n = read(vhci_fd, buf, sizeof(buf));
        if (n <= 0) {
            if (n < 0 && (errno == EINTR || errno == EAGAIN))
                continue;
            fprintf(stderr, "vhci: read from kernel failed: %s\n",
                    n < 0 ? strerror(errno) : "eof");
            request_shutdown(1);
            return;
        }

        /*
         * USERIAL_OPEN hands back one end of a socketpair, not the SDIO node:
         * libskwbt holds the other end and shuttles frames to /dev/BTCMD and
         * /dev/BTDATA itself. Its reader only accepts host-to-controller
         * packet types and asserts on anything else, so the control frames the
         * kernel sends over /dev/vhci -- HCI_VENDOR_PKT among them -- must not
         * be passed through. They are addressed to the vhci driver, not to the
         * controller.
         */
        if (buf[0] == HCI_VENDOR_PKT) {
            printf("[SKW] not forwarding packet type 0x%02x, %zd bytes:", buf[0], (ssize_t)n);
            for (ssize_t i = 0; i < n && i < 16; i++)
                printf(" %02x", buf[i]);
            printf("\n");
            if (revents & (POLLERR | POLLHUP))
                request_shutdown(1);
            continue;
        }

        if (!validate_host_frame(buf, (size_t)n)) {
            fprintf(stderr, "vhci: malformed host frame type 0x%02x, %zd bytes\n",
                    buf[0], n);
            request_shutdown(1);
            return;
        }

        if (vendor_fds[CH_CMD] < 0) {
            fprintf(stderr, "vhci: vendor channel not open\n");
            request_shutdown(1);
            return;
        }

        if (write_all(vendor_fds[CH_CMD], buf, (size_t)n) < 0) {
            if (!bridge_should_run())
                return;
            fprintf(stderr, "vhci: write to chip failed: %s\n", strerror(errno));
            request_shutdown(1);
            return;
        }

        if (revents & (POLLERR | POLLHUP)) {
            fprintf(stderr, "vhci: /dev/vhci closed (revents 0x%x)\n",
                    (unsigned int)revents);
            request_shutdown(1);
            return;
        }
    }
}

static int open_vendor_channels(void)
{
    for (int attempt = 1; attempt <= VENDOR_OPEN_ATTEMPTS; attempt++) {
        for (int ch = 0; ch < CH_MAX; ch++)
            vendor_fds[ch] = -1;

        if (vendor_interface->op(BT_VND_OP_USERIAL_OPEN, vendor_fds) > 0) {
            vendor_channels_open = 1;
            return 0;
        }

        /* A service restart can briefly leave /dev/BTBOOT exclusive after
         * the previous process exits. Close any partial attempt before
         * retrying so descriptors and vendor-library state cannot leak. */
        vendor_interface->op(BT_VND_OP_USERIAL_CLOSE, NULL);
        if (attempt == VENDOR_OPEN_ATTEMPTS || !bridge_should_run())
            break;

        fprintf(stderr,
                "vhci: vendor channels busy, retrying (%d/%d)\n",
                attempt, VENDOR_OPEN_ATTEMPTS);
        struct pollfd pfd = { .fd = signal_fds[0], .events = POLLIN };
        int delay_result = poll(&pfd, 1, VENDOR_OPEN_RETRY_MS);
        if (pfd.revents)
            consume_signal_request();
        if (!bridge_should_run() || (delay_result < 0 && errno != EINTR))
            break;
    }

    fprintf(stderr, "vhci: could not open vendor channels\n");
    return -1;
}

static int init_vendor_library(void)
{
    uint8_t local_bdaddr[BD_ADDR_LEN];

    if (read_bdaddr_file(SKWBT_BDADDR_FILE, local_bdaddr) < 0)
        return -1;

    lib_handle = dlopen("/usr/lib/bluetooth/plugins/libskwbt.so", RTLD_LAZY);
    if (!lib_handle) {
        fprintf(stderr, "vhci: %s\n", dlerror());
        return -1;
    }

    vendor_interface = dlsym(lib_handle, "BLUETOOTH_VENDOR_LIB_INTERFACE");
    if (!vendor_interface) {
        fprintf(stderr, "vhci: %s\n", dlerror());
        return -1;
    }

    if (vendor_interface->init(&bridge_callbacks, local_bdaddr) != 0) {
        fprintf(stderr, "vhci: vendor init failed\n");
        return -1;
    }
    vendor_initialized = 1;

    int power_on = BT_VND_PWR_ON;
    vendor_interface->op(BT_VND_OP_POWER_CTRL, &power_on);

    if (open_vendor_channels() < 0)
        return -1;

    for (int ch = 0; ch < CH_MAX; ch++)
        if (vendor_fds[ch] >= 0)
            printf("[SKW] vendor channel %d -> fd %d\n", ch, vendor_fds[ch]);

    if (vendor_fds[CH_CMD] < 0 || vendor_fds[CH_EVT] < 0) {
        fprintf(stderr, "vhci: command or event channel missing\n");
        return -1;
    }
    if (configure_controller_address(vendor_fds[CH_CMD], vendor_fds[CH_EVT],
                                     local_bdaddr) < 0)
        return -1;
    if (read_controller_buffer_sizes(vendor_fds[CH_CMD],
                                     vendor_fds[CH_EVT]) < 0)
        return -1;

    return 0;
}

static void cleanup_vendor_library(void)
{
    if (vendor_interface && vendor_channels_open) {
        vendor_interface->op(BT_VND_OP_USERIAL_CLOSE, NULL);
        vendor_channels_open = 0;
    }
    if (vendor_interface && vendor_initialized) {
        vendor_interface->op(BT_VND_OP_EPILOG, NULL);
        vendor_interface->cleanup();
        vendor_initialized = 0;
    }
    vendor_interface = NULL;

    if (lib_handle) {
        dlclose(lib_handle);
        lib_handle = NULL;
    }
}

#ifndef SKW_BRIDGE_VERSION
#define SKW_BRIDGE_VERSION "0.1.0"
#endif

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("skw_vhci_bridge %s\n", SKW_BRIDGE_VERSION);
        return 0;
    }
    if (argc != 1) {
        fprintf(stderr, "usage: skw_vhci_bridge [--version]\n");
        return 2;
    }
    (void)setvbuf(stdout, NULL, _IOLBF, 0);
    printf("=== SKW vHCI Bridge ===\n");

    reset_shutdown_state();
    if (setup_signal_handling() < 0) {
        fprintf(stderr, "vhci: cannot install signal handling: %s\n",
                strerror(errno));
        return 1;
    }

    if (init_vendor_library() != 0) {
        cleanup_vendor_library();
        cleanup_signal_handling();
        return 1;
    }

    /*
     * Opening the node is the whole registration on this kernel: hci_vhci
     * creates the adapter in its open handler, and hci0 appears before a
     * single byte is written. Mainline expects an HCI_VENDOR_PKT with a device
     * type, and the four byte form some drivers take is rejected outright with
     * EINVAL here, so send neither.
     */
    vhci_fd = open("/dev/vhci", O_RDWR);
    if (vhci_fd < 0) {
        fprintf(stderr, "vhci: open /dev/vhci: %s\n", strerror(errno));
        cleanup_vendor_library();
        cleanup_signal_handling();
        return 1;
    }
    printf("[SKW] adapter registered by opening /dev/vhci\n");

    pthread_t rx;
    int thread_result = pthread_create(&rx, NULL, chip_to_kernel, NULL);
    if (thread_result != 0) {
        fprintf(stderr, "vhci: cannot start reader thread: %s\n",
                strerror(thread_result));
        close(vhci_fd);
        vhci_fd = -1;
        cleanup_vendor_library();
        cleanup_signal_handling();
        return 1;
    }

    printf("[SKW] bridging\n");
    kernel_to_chip();

    request_shutdown(0);
    thread_result = pthread_join(rx, NULL);
    if (thread_result != 0) {
        fprintf(stderr, "vhci: cannot join reader thread: %s\n",
                strerror(thread_result));
        atomic_store(&runtime_failed, 1);
    }

    if (vhci_fd >= 0)
        close(vhci_fd);
    cleanup_vendor_library();
    cleanup_signal_handling();

    printf("[SKW] stopped\n");
    return atomic_load(&runtime_failed) ? 1 : 0;
}
