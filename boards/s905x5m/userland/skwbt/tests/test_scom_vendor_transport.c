#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "include/linux_compat.h"
#include "include/bt_vendor_skw.h"

#define CHECK(condition)                                                      \
    do {                                                                      \
        if (!(condition)) {                                                   \
            fprintf(stderr, "FAIL %s:%d: %s\n", __func__, __LINE__,          \
                    #condition);                                              \
            return -1;                                                        \
        }                                                                     \
    } while (0)

bt_vendor_callbacks_t *bt_vendor_cbacks;
char btcp_log_en;
char skwbt_transtype;
char skwbtuartonly = TRUE;
char skwbtNoSleep;
char skwdriverlog_en;
int btboot_fp = -1;
int btpw_fp = -1;

void skw_addr_get(unsigned char *buffer) { (void)buffer; }
char skw_addr_from_ap(unsigned char *buffer) { (void)buffer; return FALSE; }
void skw_btsnoop_capture(const uint8_t *packet, char received)
{
    (void)packet;
    (void)received;
}
void skwlog_write(unsigned char *buffer, unsigned int length)
{
    (void)buffer;
    (void)length;
}

#include "../src/scom_vendor.c"

struct fake_transport {
    int bridge_fd;
    int device_peer;
};

static int poll_read(int fd, void *buffer, size_t length, int timeout_ms)
{
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    int ready;

    do {
        ready = poll(&pfd, 1, timeout_ms);
    } while (ready < 0 && errno == EINTR);
    if (ready <= 0 || !(pfd.revents & POLLIN))
        return -1;
    return (int)read(fd, buffer, length);
}

static int read_stream_exact(int fd, uint8_t *buffer, size_t length,
                             int timeout_ms)
{
    size_t received = 0;

    while (received < length) {
        int count = poll_read(fd, buffer + received, length - received,
                              timeout_ms);
        if (count <= 0)
            return -1;
        received += (size_t)count;
    }
    return 0;
}

static int wait_for_eof(int fd, int timeout_ms)
{
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    int elapsed = 0;

    while (elapsed < timeout_ms) {
        int ready = poll(&pfd, 1, 10);
        if (ready > 0 && (pfd.revents & (POLLIN | POLLHUP | POLLRDHUP))) {
            uint8_t byte;
            ssize_t count = read(fd, &byte, sizeof(byte));
            if (count == 0)
                return 0;
            if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK)
                return -1;
        }
        elapsed += 10;
    }
    return -1;
}

static int wait_until_stopped(scomm_vnd_st *scomm, int timeout_ms)
{
    int elapsed = 0;

    while (elapsed < timeout_ms) {
        if (!atomic_load(&scomm->thread_running))
            return 0;
        usleep(1000);
        elapsed++;
    }
    return -1;
}

static int open_fake_transport(struct fake_transport *transport)
{
    int devices[2];

    if (socketpair(AF_UNIX, SOCK_SEQPACKET, 0, devices) < 0)
        return -1;
    if (set_nonblocking_cloexec(devices[0]) < 0) {
        close(devices[0]);
        close(devices[1]);
        return -1;
    }
    scomm_vnd[0].fd = devices[0];
    transport->device_peer = devices[1];
    transport->bridge_fd = scomm_vendor_socket_open(0);
    if (transport->bridge_fd < 0) {
        close(devices[1]);
        scomm_vendor_port_close(0);
        return -1;
    }
    return 0;
}

static void close_fake_transport(struct fake_transport *transport)
{
    scomm_vendor_port_close(0);
    if (transport->device_peer >= 0)
        close(transport->device_peer);
    transport->bridge_fd = -1;
    transport->device_peer = -1;
}

static int expect_device_record(int fd, const uint8_t *expected, size_t length)
{
    uint8_t buffer[SKW_H4_STREAM_CAPACITY];
    int count = poll_read(fd, buffer, sizeof(buffer), 1000);

    CHECK(count == (int)length);
    CHECK(memcmp(buffer, expected, length) == 0);
    return 0;
}

static int test_host_fragmentation_and_coalescing(void)
{
    const uint8_t command[] = { SKW_H4_COMMAND_PKT, 0x03, 0x0c, 0x00 };
    const uint8_t acl[] = { SKW_H4_ACL_PKT, 0x01, 0x20, 0x00, 0x00 };
    const uint8_t sco[] = { SKW_H4_SCO_PKT, 0x01, 0x00, 0x00 };
    const uint8_t iso[] = { SKW_H4_ISO_PKT, 0x01, 0x00, 0x00, 0x00 };
    uint8_t combined[sizeof(acl) + sizeof(sco) + sizeof(iso)];
    struct fake_transport transport = { -1, -1 };

    skwbt_transtype = SKWBT_TRANS_TYPE_H4;
    CHECK(open_fake_transport(&transport) == 0);

    for (size_t i = 0; i < sizeof(command); i++)
        CHECK(write(transport.bridge_fd, command + i, 1) == 1);
    CHECK(expect_device_record(transport.device_peer, command,
                               sizeof(command)) == 0);

    memcpy(combined, acl, sizeof(acl));
    memcpy(combined + sizeof(acl), sco, sizeof(sco));
    memcpy(combined + sizeof(acl) + sizeof(sco), iso, sizeof(iso));
    CHECK(write(transport.bridge_fd, combined, sizeof(combined)) ==
          (ssize_t)sizeof(combined));
    CHECK(expect_device_record(transport.device_peer, acl, sizeof(acl)) == 0);
    CHECK(expect_device_record(transport.device_peer, sco, sizeof(sco)) == 0);
    CHECK(expect_device_record(transport.device_peer, iso, sizeof(iso)) == 0);

    close_fake_transport(&transport);
    return 0;
}

static int test_host_maximum_and_rejection(void)
{
    uint8_t maximum[SKW_H4_KERNEL_MAX_FRAME] = { SKW_H4_ACL_PKT };
    const uint8_t oversized_header[] = {
        SKW_H4_ACL_PKT, 0x01, 0x20, 0x00, 0x04
    };
    struct fake_transport transport = { -1, -1 };

    maximum[3] = 0xff;
    maximum[4] = 0x03;
    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.bridge_fd, maximum, sizeof(maximum)) ==
          (ssize_t)sizeof(maximum));
    CHECK(expect_device_record(transport.device_peer, maximum,
                               sizeof(maximum)) == 0);
    close_fake_transport(&transport);

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.bridge_fd, oversized_header,
                sizeof(oversized_header)) == (ssize_t)sizeof(oversized_header));
    CHECK(wait_for_eof(transport.bridge_fd, 1000) == 0);
    close_fake_transport(&transport);

    CHECK(open_fake_transport(&transport) == 0);
    const uint8_t invalid = 0x06;
    CHECK(write(transport.bridge_fd, &invalid, sizeof(invalid)) == 1);
    CHECK(wait_for_eof(transport.bridge_fd, 1000) == 0);
    close_fake_transport(&transport);
    return 0;
}

static int test_host_per_type_maxima(void)
{
    uint8_t command[SKW_H4_COMMAND_MAX_FRAME] = { SKW_H4_COMMAND_PKT };
    uint8_t acl[SKW_H4_KERNEL_MAX_FRAME] = { SKW_H4_ACL_PKT };
    uint8_t sco[SKW_H4_SCO_MAX_FRAME] = { SKW_H4_SCO_PKT };
    uint8_t iso[SKW_H4_ISO_MAX_FRAME] = { SKW_H4_ISO_PKT };
    const uint8_t oversized_iso[] = {
        SKW_H4_ISO_PKT, 0x01, 0x00, 0xfc, 0x00
    };
    struct fake_transport transport = { -1, -1 };

    command[3] = 0xff;
    acl[3] = 0xff;
    acl[4] = 0x03;
    sco[3] = 0xff;
    iso[3] = 0xfb;

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.bridge_fd, command, sizeof(command)) ==
          (ssize_t)sizeof(command));
    CHECK(expect_device_record(transport.device_peer, command,
                               sizeof(command)) == 0);
    CHECK(write(transport.bridge_fd, acl, sizeof(acl)) ==
          (ssize_t)sizeof(acl));
    CHECK(expect_device_record(transport.device_peer, acl, sizeof(acl)) == 0);
    CHECK(write(transport.bridge_fd, sco, sizeof(sco)) ==
          (ssize_t)sizeof(sco));
    CHECK(expect_device_record(transport.device_peer, sco, sizeof(sco)) == 0);
    CHECK(write(transport.bridge_fd, iso, sizeof(iso)) ==
          (ssize_t)sizeof(iso));
    CHECK(expect_device_record(transport.device_peer, iso, sizeof(iso)) == 0);
    close_fake_transport(&transport);

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.bridge_fd, oversized_iso,
                sizeof(oversized_iso)) == (ssize_t)sizeof(oversized_iso));
    CHECK(wait_for_eof(transport.bridge_fd, 1000) == 0);
    close_fake_transport(&transport);
    return 0;
}

static int test_controller_framing_and_log_filter(void)
{
    const uint8_t event[] = { SKW_H4_EVENT_PKT, 0x0e, 0x00 };
    const uint8_t acl[] = { SKW_H4_ACL_PKT, 0x01, 0x20, 0x00, 0x00 };
    const uint8_t sco[] = { SKW_H4_SCO_PKT, 0x01, 0x00, 0x00 };
    const uint8_t iso[] = { SKW_H4_ISO_PKT, 0x01, 0x00, 0x00, 0x00 };
    const uint8_t log[] = { SKW_H4_LOG_PKT, 0x00, 0x02, 0x00, 0xaa, 0xbb };
    uint8_t input[sizeof(log) + sizeof(event) + sizeof(acl) +
                  sizeof(sco) + sizeof(iso)];
    uint8_t expected[sizeof(event) + sizeof(acl) + sizeof(sco) + sizeof(iso)];
    uint8_t actual[sizeof(expected)];
    struct fake_transport transport = { -1, -1 };
    size_t offset = 0;

    memcpy(input + offset, log, sizeof(log));
    offset += sizeof(log);
    memcpy(input + offset, event, sizeof(event));
    offset += sizeof(event);
    memcpy(input + offset, acl, sizeof(acl));
    offset += sizeof(acl);
    memcpy(input + offset, sco, sizeof(sco));
    offset += sizeof(sco);
    memcpy(input + offset, iso, sizeof(iso));

    offset = 0;
    memcpy(expected + offset, event, sizeof(event));
    offset += sizeof(event);
    memcpy(expected + offset, acl, sizeof(acl));
    offset += sizeof(acl);
    memcpy(expected + offset, sco, sizeof(sco));
    offset += sizeof(sco);
    memcpy(expected + offset, iso, sizeof(iso));

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.device_peer, input, sizeof(input)) ==
          (ssize_t)sizeof(input));
    CHECK(read_stream_exact(transport.bridge_fd, actual, sizeof(actual), 1000) == 0);
    CHECK(memcmp(actual, expected, sizeof(expected)) == 0);

    for (size_t i = 0; i < sizeof(input); i++)
        CHECK(write(transport.device_peer, input + i, 1) == 1);
    CHECK(read_stream_exact(transport.bridge_fd, actual, sizeof(actual), 1000) == 0);
    CHECK(memcmp(actual, expected, sizeof(expected)) == 0);
    close_fake_transport(&transport);
    return 0;
}

static int test_controller_per_type_maxima(void)
{
    uint8_t event[SKW_H4_EVENT_MAX_FRAME] = { SKW_H4_EVENT_PKT };
    uint8_t acl[SKW_H4_KERNEL_MAX_FRAME] = { SKW_H4_ACL_PKT };
    uint8_t sco[SKW_H4_SCO_MAX_FRAME] = { SKW_H4_SCO_PKT };
    uint8_t iso[SKW_H4_ISO_MAX_FRAME] = { SKW_H4_ISO_PKT };
    uint8_t log[SKW_H4_STREAM_CAPACITY] = { SKW_H4_LOG_PKT };
    uint8_t input[sizeof(event) + sizeof(acl) + sizeof(sco) + sizeof(iso)];
    uint8_t actual[sizeof(input)];
    struct fake_transport transport = { -1, -1 };
    size_t offset = 0;

    event[2] = 0xff;
    acl[3] = 0xff;
    acl[4] = 0x03;
    sco[3] = 0xff;
    iso[3] = 0xfb;
    log[2] = 0xfc;
    log[3] = 0x0f;

    memcpy(input + offset, event, sizeof(event));
    offset += sizeof(event);
    memcpy(input + offset, acl, sizeof(acl));
    offset += sizeof(acl);
    memcpy(input + offset, sco, sizeof(sco));
    offset += sizeof(sco);
    memcpy(input + offset, iso, sizeof(iso));

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.device_peer, input, sizeof(input)) ==
          (ssize_t)sizeof(input));
    CHECK(read_stream_exact(transport.bridge_fd, actual, sizeof(actual), 1000) == 0);
    CHECK(memcmp(actual, input, sizeof(input)) == 0);

    CHECK(write(transport.device_peer, log, sizeof(log)) ==
          (ssize_t)sizeof(log));
    CHECK(write(transport.device_peer, event, sizeof(event)) ==
          (ssize_t)sizeof(event));
    CHECK(read_stream_exact(transport.bridge_fd, actual, sizeof(event), 1000) == 0);
    CHECK(memcmp(actual, event, sizeof(event)) == 0);
    close_fake_transport(&transport);
    return 0;
}

static int test_controller_oversize_rejection(void)
{
    const uint8_t oversized_header[] = {
        SKW_H4_ACL_PKT, 0x01, 0x20, 0x00, 0x04
    };
    const uint8_t oversized_iso[] = {
        SKW_H4_ISO_PKT, 0x01, 0x00, 0xfc, 0x00
    };
    struct fake_transport transport = { -1, -1 };

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.device_peer, oversized_header,
                sizeof(oversized_header)) == (ssize_t)sizeof(oversized_header));
    CHECK(wait_for_eof(transport.bridge_fd, 1000) == 0);
    close_fake_transport(&transport);

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.device_peer, oversized_iso,
                sizeof(oversized_iso)) == (ssize_t)sizeof(oversized_iso));
    CHECK(wait_for_eof(transport.bridge_fd, 1000) == 0);
    close_fake_transport(&transport);
    return 0;
}

struct drain_reader {
    int fd;
    size_t expected;
    size_t received;
};

static void *drain_socket(void *arg)
{
    struct drain_reader *reader = arg;
    uint8_t buffer[1024];

    while (reader->received < reader->expected) {
        ssize_t count = read(reader->fd, buffer, sizeof(buffer));
        if (count > 0) {
            reader->received += (size_t)count;
            continue;
        }
        if (count < 0 && errno == EINTR)
            continue;
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd pfd = { .fd = reader->fd, .events = POLLIN };
            (void)poll(&pfd, 1, 1000);
            continue;
        }
        break;
    }
    return NULL;
}

static int test_partial_and_permanent_writes(void)
{
    enum { PAYLOAD_SIZE = 128 * 1024 };
    static uint8_t payload[PAYLOAD_SIZE];
    int sockets[2];
    int send_buffer = 1024;
    pthread_t reader_thread;
    struct drain_reader reader = { 0 };

    memset(payload, 0xa5, PAYLOAD_SIZE);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    CHECK(set_nonblocking_cloexec(sockets[0]) == 0);
    CHECK(set_nonblocking_cloexec(sockets[1]) == 0);
    CHECK(setsockopt(sockets[0], SOL_SOCKET, SO_SNDBUF, &send_buffer,
                     sizeof(send_buffer)) == 0);
    reader.fd = sockets[1];
    reader.expected = PAYLOAD_SIZE;
    CHECK(pthread_create(&reader_thread, NULL, drain_socket, &reader) == 0);
    atomic_store(&scomm_vnd[0].thread_running, true);
    CHECK(write_transport(&scomm_vnd[0], sockets[0], payload,
                          PAYLOAD_SIZE, true) == 0);
    CHECK(pthread_join(reader_thread, NULL) == 0);
    CHECK(reader.received == PAYLOAD_SIZE);

    close(sockets[1]);
    CHECK(write_transport(&scomm_vnd[0], sockets[0], payload, 1, true) < 0);
    atomic_store(&scomm_vnd[0].thread_running, false);
    close(sockets[0]);
    return 0;
}

static int test_device_hup_propagates_eof(void)
{
    struct fake_transport transport = { -1, -1 };

    CHECK(open_fake_transport(&transport) == 0);
    close(transport.device_peer);
    transport.device_peer = -1;
    CHECK(wait_for_eof(transport.bridge_fd, 1000) == 0);
    CHECK(wait_until_stopped(&scomm_vnd[0], 1000) == 0);
    close_fake_transport(&transport);
    return 0;
}

static int test_bridge_eof_stops_transport(void)
{
    struct fake_transport transport = { -1, -1 };

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(shutdown(transport.bridge_fd, SHUT_RDWR) == 0);
    CHECK(wait_until_stopped(&scomm_vnd[0], 1000) == 0);
    close_fake_transport(&transport);
    return 0;
}

static int test_truncated_host_frame_fails_on_eof(void)
{
    const uint8_t truncated[] = {
        SKW_H4_COMMAND_PKT, 0x03, 0x0c, 0x04, 0x01
    };
    struct fake_transport transport = { -1, -1 };

    CHECK(open_fake_transport(&transport) == 0);
    CHECK(write(transport.bridge_fd, truncated, sizeof(truncated)) ==
          (ssize_t)sizeof(truncated));
    CHECK(shutdown(transport.bridge_fd, SHUT_WR) == 0);
    CHECK(wait_until_stopped(&scomm_vnd[0], 1000) == 0);
    close_fake_transport(&transport);
    return 0;
}

static int test_sdio_routing(void)
{
    skwbt_transtype = SKWBT_TRANS_TYPE_H4 | SKWBT_TRANS_TYPE_SDIO;
    CHECK(host_frame_port(SKW_H4_COMMAND_PKT) == BT_COM_PORT_CMDEVT);
    CHECK(host_frame_port(SKW_H4_ACL_PKT) == BT_COM_PORT_ACL);
    CHECK(host_frame_port(SKW_H4_SCO_PKT) == BT_COM_PORT_AUDIO);
    CHECK(host_frame_port(SKW_H4_ISO_PKT) == BT_COM_PORT_ISO);
    skwbt_transtype = SKWBT_TRANS_TYPE_H4;
    return 0;
}

int main(void)
{
    signal(SIGPIPE, SIG_IGN);
    scomm_vendor_init();
    CHECK(test_host_fragmentation_and_coalescing() == 0);
    CHECK(test_host_maximum_and_rejection() == 0);
    CHECK(test_host_per_type_maxima() == 0);
    CHECK(test_controller_framing_and_log_filter() == 0);
    CHECK(test_controller_per_type_maxima() == 0);
    CHECK(test_controller_oversize_rejection() == 0);
    CHECK(test_device_hup_propagates_eof() == 0);
    CHECK(test_bridge_eof_stops_transport() == 0);
    CHECK(test_truncated_host_frame_fails_on_eof() == 0);
    CHECK(test_partial_and_permanent_writes() == 0);
    CHECK(test_sdio_routing() == 0);
    puts("scom_vendor transport tests passed");
    return 0;
}
