#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define main skw_vhci_bridge_program_main
#include "skw_vhci_bridge.c"
#undef main

#define CHECK(condition)                                                     \
    do {                                                                     \
        if (!(condition)) {                                                  \
            fprintf(stderr, "FAIL %s:%d: %s\n", __func__, __LINE__,         \
                    #condition);                                             \
            return -1;                                                       \
        }                                                                    \
    } while (0)

enum forwarding_direction {
    FORWARD_CHIP_TO_KERNEL,
    FORWARD_KERNEL_TO_CHIP,
};

struct forwarding_thread {
    enum forwarding_direction direction;
    int done[2];
    pthread_t thread;
};

static void reset_forwarding_state(void)
{
    reset_shutdown_state();
    vhci_fd = -1;
    controller_acl_mtu = 1021;
    controller_sco_mtu = 255;
    for (int ch = 0; ch < CH_MAX; ch++)
        vendor_fds[ch] = -1;
}

static void *run_forwarding_thread(void *arg)
{
    struct forwarding_thread *forwarder = arg;

    if (forwarder->direction == FORWARD_CHIP_TO_KERNEL)
        chip_to_kernel(NULL);
    else
        kernel_to_chip();

    uint8_t done = 1;
    (void)write(forwarder->done[1], &done, sizeof(done));
    return NULL;
}

static int start_forwarding_thread(struct forwarding_thread *forwarder,
                                   enum forwarding_direction direction)
{
    forwarder->direction = direction;
    if (pipe(forwarder->done) < 0)
        return -1;

    int result = pthread_create(&forwarder->thread, NULL,
                                run_forwarding_thread, forwarder);
    if (result != 0) {
        close(forwarder->done[0]);
        close(forwarder->done[1]);
        errno = result;
        return -1;
    }
    return 0;
}

static int finish_forwarding_thread(struct forwarding_thread *forwarder,
                                    int timeout_ms)
{
    struct pollfd pfd = { .fd = forwarder->done[0], .events = POLLIN };
    int ready;

    do {
        ready = poll(&pfd, 1, timeout_ms);
    } while (ready < 0 && errno == EINTR);

    int completed = ready > 0 && (pfd.revents & POLLIN);
    if (!completed) {
        request_shutdown(0);

        do {
            ready = poll(&pfd, 1, 1000);
        } while (ready < 0 && errno == EINTR);
        if (ready <= 0 || !(pfd.revents & POLLIN))
            pthread_cancel(forwarder->thread);
    }

    int result = pthread_join(forwarder->thread, NULL);
    close(forwarder->done[0]);
    close(forwarder->done[1]);
    return completed && result == 0 ? 0 : -1;
}

static const bt_vendor_callbacks_t *retain_bridge_callbacks(void)
{
    return &bridge_callbacks;
}

__attribute__((noinline)) static void churn_stack(void)
{
    volatile uint8_t bytes[4096];

    for (size_t i = 0; i < sizeof(bytes); i++)
        bytes[i] = (uint8_t)i;
}

struct fake_controller {
    int fd;
    uint16_t opcodes[4];
    size_t command_count;
    uint8_t read_address[BD_ADDR_LEN];
    uint8_t expected_write_address[BD_ADDR_LEN];
    uint16_t acl_mtu;
    uint8_t sco_mtu;
    int status_error_at;
    int opcode_mismatch_at;
    int fragmented;
    int result;
};

static int test_read_all(int fd, uint8_t *buf, size_t len)
{
    size_t done = 0;

    while (done < len) {
        ssize_t n = read(fd, buf + done, len - done);
        if (n <= 0)
            return -1;
        done += (size_t)n;
    }
    return 0;
}

static int fake_write_response(struct fake_controller *controller,
                               const uint8_t *response, size_t len)
{
    if (!controller->fragmented)
        return write_all(controller->fd, response, len) == (ssize_t)len ? 0 : -1;

    for (size_t i = 0; i < len; i++) {
        if (write_all(controller->fd, response + i, 1) != 1)
            return -1;
        usleep(1000);
    }
    return 0;
}

static void *fake_controller_thread(void *arg)
{
    struct fake_controller *controller = arg;
    controller->result = -1;

    for (size_t i = 0; i < controller->command_count; i++) {
        uint8_t header[4];
        uint8_t params[255];
        uint8_t response[3 + 4 + 7];

        if (test_read_all(controller->fd, header, sizeof(header)) < 0)
            return NULL;
        if (header[0] != HCI_COMMAND_PKT)
            return NULL;

        uint16_t opcode = (uint16_t)header[1] |
                          ((uint16_t)header[2] << 8);
        if (opcode != controller->opcodes[i])
            return NULL;
        if (header[3] && test_read_all(controller->fd, params, header[3]) < 0)
            return NULL;

        if (opcode == HCI_WRITE_BD_ADDR &&
            (header[3] != BD_ADDR_LEN ||
             memcmp(params, controller->expected_write_address,
                    BD_ADDR_LEN) != 0))
            return NULL;

        size_t return_len = 0;
        if (opcode == HCI_READ_BD_ADDR)
            return_len = BD_ADDR_LEN;
        else if (opcode == HCI_READ_BUFFER_SIZE)
            return_len = 7;
        uint16_t response_opcode = opcode;
        if ((int)i == controller->opcode_mismatch_at)
            response_opcode ^= 1;

        response[0] = HCI_EVENT_PKT;
        response[1] = HCI_EVENT_COMMAND_COMPLETE;
        response[2] = (uint8_t)(4 + return_len);
        response[3] = 1;
        response[4] = (uint8_t)(response_opcode & 0xff);
        response[5] = (uint8_t)(response_opcode >> 8);
        response[6] = (int)i == controller->status_error_at ? 0x0c : 0;
        if (opcode == HCI_READ_BD_ADDR)
            memcpy(response + 7, controller->read_address, return_len);
        else if (opcode == HCI_READ_BUFFER_SIZE) {
            response[7] = (uint8_t)(controller->acl_mtu & 0xff);
            response[8] = (uint8_t)(controller->acl_mtu >> 8);
            response[9] = controller->sco_mtu;
            response[10] = 9;
            response[11] = 0;
            response[12] = 4;
            response[13] = 0;
        }

        if (fake_write_response(controller, response, 7 + return_len) < 0)
            return NULL;
    }

    controller->result = 0;
    return NULL;
}

static int start_fake_controller(struct fake_controller *controller,
                                 int sockets[2], pthread_t *thread)
{
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) < 0)
        return -1;
    controller->fd = sockets[1];
    controller->result = -1;
    if (pthread_create(thread, NULL, fake_controller_thread, controller) != 0) {
        close(sockets[0]);
        close(sockets[1]);
        return -1;
    }
    return 0;
}

static int finish_fake_controller(struct fake_controller *controller,
                                  int sockets[2], pthread_t thread)
{
    int result = pthread_join(thread, NULL);
    close(sockets[0]);
    close(sockets[1]);
    return result == 0 && controller->result == 0 ? 0 : -1;
}

static int test_parse_bdaddr(void)
{
    uint8_t actual[BD_ADDR_LEN];
    const uint8_t expected[] = { 0xd8, 0x36, 0x01, 0x47, 0xad, 0x02 };

    CHECK(parse_bdaddr_text("02:ad:47:01:36:d8\n", actual) == 0);
    CHECK(memcmp(actual, expected, sizeof(expected)) == 0);
    CHECK(parse_bdaddr_text("02:AD:47:01:36:D8\r\n", actual) == 0);
    CHECK(parse_bdaddr_text("2:AD:47:01:36:D8", actual) < 0);
    CHECK(parse_bdaddr_text("02-AD-47-01-36-D8", actual) < 0);
    CHECK(parse_bdaddr_text("02:AD:47:01:36:D8 junk", actual) < 0);
    CHECK(parse_bdaddr_text("00:00:00:00:00:00", actual) < 0);
    CHECK(parse_bdaddr_text("FF:FF:FF:FF:FF:FF", actual) < 0);
    return 0;
}

static int test_fragmented_command_complete(void)
{
    int sockets[2];
    pthread_t thread;
    uint8_t response[BD_ADDR_LEN];
    size_t response_len = 0;
    struct fake_controller controller = {
        .opcodes = { HCI_READ_BD_ADDR },
        .command_count = 1,
        .read_address = { 0xd8, 0x36, 0x01, 0x47, 0xad, 0x02 },
        .status_error_at = -1,
        .opcode_mismatch_at = -1,
        .fragmented = 1,
    };

    CHECK(start_fake_controller(&controller, sockets, &thread) == 0);
    CHECK(controller_command(sockets[0], sockets[0], HCI_READ_BD_ADDR,
                             NULL, 0, response, sizeof(response),
                             &response_len, 500) == 0);
    CHECK(response_len == BD_ADDR_LEN);
    CHECK(memcmp(response, controller.read_address, BD_ADDR_LEN) == 0);
    CHECK(finish_fake_controller(&controller, sockets, thread) == 0);
    return 0;
}

static int test_response_errors(void)
{
    int sockets[2];
    pthread_t thread;
    struct fake_controller controller = {
        .opcodes = { HCI_RESET },
        .command_count = 1,
        .status_error_at = 0,
        .opcode_mismatch_at = -1,
    };

    CHECK(start_fake_controller(&controller, sockets, &thread) == 0);
    CHECK(controller_command(sockets[0], sockets[0], HCI_RESET,
                             NULL, 0, NULL, 0, NULL, 500) < 0);
    CHECK(finish_fake_controller(&controller, sockets, thread) == 0);

    controller.status_error_at = -1;
    controller.opcode_mismatch_at = 0;
    CHECK(start_fake_controller(&controller, sockets, &thread) == 0);
    CHECK(controller_command(sockets[0], sockets[0], HCI_RESET,
                             NULL, 0, NULL, 0, NULL, 500) < 0);
    CHECK(finish_fake_controller(&controller, sockets, thread) == 0);
    return 0;
}

static int test_response_timeout(void)
{
    int sockets[2];

    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    CHECK(controller_command(sockets[0], sockets[0], HCI_RESET,
                             NULL, 0, NULL, 0, NULL, 20) < 0);
    CHECK(errno == ETIMEDOUT);
    close(sockets[0]);
    close(sockets[1]);
    return 0;
}

static int run_address_configuration(const uint8_t actual[BD_ADDR_LEN],
                                     int expected_result)
{
    int sockets[2];
    pthread_t thread;
    const uint8_t desired[] = { 0xd8, 0x36, 0x01, 0x47, 0xad, 0x02 };
    struct fake_controller controller = {
        .opcodes = { HCI_WRITE_BD_ADDR, HCI_RESET, HCI_READ_BD_ADDR },
        .command_count = 3,
        .status_error_at = -1,
        .opcode_mismatch_at = -1,
        .fragmented = 1,
    };

    memcpy(controller.read_address, actual, BD_ADDR_LEN);
    memcpy(controller.expected_write_address, desired, BD_ADDR_LEN);
    CHECK(start_fake_controller(&controller, sockets, &thread) == 0);

    int result = configure_controller_address_with_timeout(
        sockets[0], sockets[0], desired, 500);
    CHECK((result == 0) == (expected_result == 0));
    CHECK(finish_fake_controller(&controller, sockets, thread) == 0);
    return 0;
}

static int test_address_configuration(void)
{
    const uint8_t desired[] = { 0xd8, 0x36, 0x01, 0x47, 0xad, 0x02 };
    const uint8_t wrong[] = { 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc };

    CHECK(run_address_configuration(desired, 0) == 0);
    CHECK(run_address_configuration(wrong, -1) == 0);
    return 0;
}

static int run_buffer_size_query(uint16_t acl_mtu, uint8_t sco_mtu,
                                 int expected_result)
{
    int sockets[2];
    pthread_t thread;
    struct fake_controller controller = {
        .opcodes = { HCI_READ_BUFFER_SIZE },
        .command_count = 1,
        .acl_mtu = acl_mtu,
        .sco_mtu = sco_mtu,
        .status_error_at = -1,
        .opcode_mismatch_at = -1,
        .fragmented = 1,
    };

    CHECK(start_fake_controller(&controller, sockets, &thread) == 0);
    int result = read_controller_buffer_sizes_with_timeout(
        sockets[0], sockets[0], 500);
    CHECK((result == 0) == (expected_result == 0));
    CHECK(finish_fake_controller(&controller, sockets, thread) == 0);
    return 0;
}

static int test_controller_buffer_sizes(void)
{
    CHECK(run_buffer_size_query(1021, 255, 0) == 0);
    CHECK(controller_acl_mtu == 1021);
    CHECK(controller_sco_mtu == 255);
    CHECK(run_buffer_size_query(0, 255, -1) == 0);
    CHECK(run_buffer_size_query(1024, 255, -1) == 0);
    return 0;
}

static int test_h4_limits(void)
{
    uint8_t command[SKW_H4_COMMAND_MAX_FRAME] = { SKW_H4_COMMAND_PKT };
    uint8_t acl[SKW_H4_KERNEL_MAX_FRAME + 1] = { SKW_H4_ACL_PKT };
    uint8_t event[SKW_H4_EVENT_MAX_FRAME + 1] = { SKW_H4_EVENT_PKT };
    uint8_t sco[SKW_H4_SCO_MAX_FRAME] = { SKW_H4_SCO_PKT };
    uint8_t iso[SKW_H4_ISO_MAX_FRAME + 1] = { SKW_H4_ISO_PKT };
    uint8_t log[SKW_H4_STREAM_CAPACITY] = { SKW_H4_LOG_PKT };
    const uint8_t oversized_log[] = { SKW_H4_LOG_PKT, 0x00, 0xfd, 0x0f };
    struct skw_h4_stream stream = { 0 };
    struct skw_h4_frame frame;

    command[3] = 255;
    CHECK(validate_host_frame(command, sizeof(command)) == 1);
    CHECK(validate_host_frame(command, sizeof(command) - 1) == 0);

    controller_acl_mtu = 1023;
    acl[3] = 0xff;
    acl[4] = 0x03;
    CHECK(validate_host_frame(acl, SKW_H4_KERNEL_MAX_FRAME) == 1);
    acl[3] = 0x00;
    acl[4] = 0x04;
    CHECK(validate_host_frame(acl, sizeof(acl)) == 0);

    event[2] = 255;
    CHECK(skw_h4_decode(event, SKW_H4_EVENT_MAX_FRAME, &frame) ==
          SKW_H4_COMPLETE);
    CHECK(frame_within_limit(&frame, SKW_H4_EVENT_MAX_FRAME));
    CHECK(skw_h4_decode(event, sizeof(event), &frame) == SKW_H4_COMPLETE);
    CHECK(frame.frame_size != sizeof(event));

    controller_sco_mtu = 255;
    sco[3] = 255;
    CHECK(validate_host_frame(sco, sizeof(sco)) == 1);

    iso[3] = 251;
    CHECK(validate_host_frame(iso, SKW_H4_ISO_MAX_FRAME) == 1);
    iso[3] = 252;
    CHECK(validate_host_frame(iso, sizeof(iso)) == 0);
    iso[3] = 0;
    iso[4] = 0x40;
    CHECK(skw_h4_decode(iso, 5, &frame) == SKW_H4_COMPLETE);
    CHECK(validate_host_frame(iso, 5) == 0);
    iso[4] = 0xc0;
    CHECK(skw_h4_decode(iso, 5, &frame) == SKW_H4_INVALID);

    log[2] = 0xfc;
    log[3] = 0x0f;
    CHECK(skw_h4_decode(log, sizeof(log), &frame) == SKW_H4_COMPLETE);
    CHECK(frame.frame_size == sizeof(log));
    CHECK(skw_h4_decode(oversized_log, sizeof(oversized_log), &frame) ==
          SKW_H4_INVALID);

    CHECK(skw_h4_decode((const uint8_t *)"\x06", 1, &frame) ==
          SKW_H4_INVALID);
    CHECK(skw_h4_stream_append(&stream, event, 1) == 0);
    CHECK(skw_h4_stream_next(&stream, &frame) == SKW_H4_INCOMPLETE);
    CHECK(skw_h4_stream_append(&stream, event + 1,
                               SKW_H4_EVENT_MAX_FRAME - 1) == 0);
    CHECK(skw_h4_stream_next(&stream, &frame) == SKW_H4_COMPLETE);
    CHECK(skw_h4_stream_consume(&stream, frame.frame_size) == 0);
    CHECK(stream.length == 0);
    stream.length = sizeof(stream.data) + 1;
    CHECK(skw_h4_stream_append(&stream, event, 1) < 0);

    controller_acl_mtu = 1021;
    return 0;
}

static int recv_record(int fd, uint8_t *buffer, size_t capacity,
                       int timeout_ms)
{
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    int ready;

    do {
        ready = poll(&pfd, 1, timeout_ms);
    } while (ready < 0 && errno == EINTR);
    if (ready <= 0 || !(pfd.revents & POLLIN))
        return -1;
    return (int)recv(fd, buffer, capacity, 0);
}

static int test_controller_stream_framing(void)
{
    const uint8_t event_one[] = { SKW_H4_EVENT_PKT, 0x0e, 0x00 };
    const uint8_t event_two[] = { SKW_H4_EVENT_PKT, 0x0f, 0x01, 0x00 };
    const uint8_t acl[] = {
        SKW_H4_ACL_PKT, 0x01, 0x20, 0x03, 0x00, 0xaa, 0xbb, 0xcc
    };
    const uint8_t log_and_event[] = {
        SKW_H4_LOG_PKT, 0x00, 0x02, 0x00, 0xde, 0xad,
        SKW_H4_EVENT_PKT, 0x10, 0x01, 0x01
    };
    uint8_t combined[sizeof(event_two) + sizeof(acl)];
    uint8_t received[64];
    int vendor_sockets[2];
    int kernel_sockets[2];
    struct forwarding_thread forwarder;

    reset_forwarding_state();
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, vendor_sockets) == 0);
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET, 0, kernel_sockets) == 0);
    vendor_fds[CH_EVT] = vendor_sockets[0];
    vhci_fd = kernel_sockets[0];
    CHECK(start_forwarding_thread(&forwarder, FORWARD_CHIP_TO_KERNEL) == 0);

    for (size_t i = 0; i < sizeof(event_one); i++)
        CHECK(write(vendor_sockets[1], event_one + i, 1) == 1);
    CHECK(recv_record(kernel_sockets[1], received, sizeof(received), 1000) ==
          (int)sizeof(event_one));
    CHECK(memcmp(received, event_one, sizeof(event_one)) == 0);

    memcpy(combined, event_two, sizeof(event_two));
    memcpy(combined + sizeof(event_two), acl, sizeof(acl));
    CHECK(write(vendor_sockets[1], combined, sizeof(combined)) ==
          (ssize_t)sizeof(combined));
    CHECK(recv_record(kernel_sockets[1], received, sizeof(received), 1000) ==
          (int)sizeof(event_two));
    CHECK(memcmp(received, event_two, sizeof(event_two)) == 0);
    CHECK(recv_record(kernel_sockets[1], received, sizeof(received), 1000) ==
          (int)sizeof(acl));
    CHECK(memcmp(received, acl, sizeof(acl)) == 0);

    CHECK(write(vendor_sockets[1], log_and_event, sizeof(log_and_event)) ==
          (ssize_t)sizeof(log_and_event));
    CHECK(recv_record(kernel_sockets[1], received, sizeof(received), 1000) == 4);
    CHECK(memcmp(received, log_and_event + 6, 4) == 0);

    request_shutdown(0);
    CHECK(finish_forwarding_thread(&forwarder, 1000) == 0);
    close(vendor_sockets[0]);
    close(vendor_sockets[1]);
    close(kernel_sockets[0]);
    close(kernel_sockets[1]);
    vendor_fds[CH_EVT] = -1;
    vhci_fd = -1;
    return 0;
}

static int test_callback_lifetime(void)
{
    const bt_vendor_callbacks_t *callbacks = retain_bridge_callbacks();

    churn_stack();
    CHECK(callbacks == &bridge_callbacks);
    CHECK(callbacks->size == sizeof(*callbacks));
    CHECK(callbacks->xmit_cb(0, NULL, NULL) == 0);
    callbacks->epilog_cb(BT_VND_OP_RESULT_SUCCESS);
    callbacks->fwcfg_cb(BT_VND_OP_RESULT_SUCCESS);
    callbacks->a2dp_offload_cb(0, 0, 0);

    void *allocation = callbacks->alloc(16);
    CHECK(allocation != NULL);
    callbacks->dealloc(allocation);
    return 0;
}

static int test_signal_requests_clean_shutdown(void)
{
    reset_forwarding_state();
    CHECK(setup_signal_handling() == 0);
    on_signal(SIGTERM);
    CHECK(atomic_load(&running) == 1);
    CHECK(consume_signal_request() == 1);
    CHECK(bridge_should_run() == 0);
    CHECK(atomic_load(&runtime_failed) == 0);
    cleanup_signal_handling();
    return 0;
}

static int test_vendor_hup_only(void)
{
    int vendor_pipe[2];
    struct forwarding_thread forwarder;

    reset_forwarding_state();
    CHECK(pipe(vendor_pipe) == 0);
    vhci_fd = open("/dev/null", O_WRONLY);
    CHECK(vhci_fd >= 0);
    vendor_fds[CH_CMD] = vendor_pipe[0];
    close(vendor_pipe[1]);

    CHECK(start_forwarding_thread(&forwarder, FORWARD_CHIP_TO_KERNEL) == 0);
    CHECK(finish_forwarding_thread(&forwarder, 1000) == 0);
    CHECK(atomic_load(&running) == 0);
    CHECK(atomic_load(&runtime_failed) == 1);

    close(vendor_pipe[0]);
    close(vhci_fd);
    vhci_fd = -1;
    vendor_fds[CH_CMD] = -1;
    return 0;
}

static int test_vendor_pollnval(void)
{
    struct forwarding_thread forwarder;

    reset_forwarding_state();
    vhci_fd = open("/dev/null", O_WRONLY);
    CHECK(vhci_fd >= 0);
    vendor_fds[CH_CMD] = 123456;

    CHECK(start_forwarding_thread(&forwarder, FORWARD_CHIP_TO_KERNEL) == 0);
    CHECK(finish_forwarding_thread(&forwarder, 1000) == 0);
    CHECK(atomic_load(&runtime_failed) == 1);

    close(vhci_fd);
    vhci_fd = -1;
    vendor_fds[CH_CMD] = -1;
    return 0;
}

static int test_kernel_eof(void)
{
    int sockets[2];
    struct forwarding_thread forwarder;

    reset_forwarding_state();
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    vhci_fd = sockets[0];
    close(sockets[1]);

    CHECK(start_forwarding_thread(&forwarder, FORWARD_KERNEL_TO_CHIP) == 0);
    CHECK(finish_forwarding_thread(&forwarder, 1000) == 0);
    CHECK(atomic_load(&runtime_failed) == 1);

    close(sockets[0]);
    vhci_fd = -1;
    return 0;
}

static int test_kernel_to_chip_write_failure(void)
{
    const uint8_t command[] = { HCI_COMMAND_PKT, 0x03, 0x0c, 0x00 };
    int sockets[2];
    int read_only_pipe[2];
    struct forwarding_thread forwarder;

    reset_forwarding_state();
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    CHECK(pipe(read_only_pipe) == 0);
    vhci_fd = sockets[0];
    vendor_fds[CH_CMD] = read_only_pipe[0];
    CHECK(write(sockets[1], command, sizeof(command)) == (ssize_t)sizeof(command));

    CHECK(start_forwarding_thread(&forwarder, FORWARD_KERNEL_TO_CHIP) == 0);
    CHECK(finish_forwarding_thread(&forwarder, 1000) == 0);
    CHECK(atomic_load(&runtime_failed) == 1);

    close(sockets[0]);
    close(sockets[1]);
    close(read_only_pipe[0]);
    close(read_only_pipe[1]);
    vhci_fd = -1;
    vendor_fds[CH_CMD] = -1;
    return 0;
}

static int test_chip_to_kernel_write_failure(void)
{
    const uint8_t event[] = { HCI_EVENT_PKT, 0x0e, 0x00 };
    int sockets[2];
    int read_only_pipe[2];
    struct forwarding_thread forwarder;

    reset_forwarding_state();
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    CHECK(pipe(read_only_pipe) == 0);
    vendor_fds[CH_EVT] = sockets[0];
    vhci_fd = read_only_pipe[0];
    CHECK(write(sockets[1], event, sizeof(event)) == (ssize_t)sizeof(event));

    CHECK(start_forwarding_thread(&forwarder, FORWARD_CHIP_TO_KERNEL) == 0);
    CHECK(finish_forwarding_thread(&forwarder, 1000) == 0);
    CHECK(atomic_load(&runtime_failed) == 1);

    close(sockets[0]);
    close(sockets[1]);
    close(read_only_pipe[0]);
    close(read_only_pipe[1]);
    vhci_fd = -1;
    vendor_fds[CH_EVT] = -1;
    return 0;
}

static int test_signal_during_write_is_clean(void)
{
    const uint8_t event[] = { HCI_EVENT_PKT, 0x0e, 0x00 };
    uint8_t fill[4096] = { 0 };
    int sockets[2];
    int blocked_pipe[2];
    struct forwarding_thread forwarder;

    reset_forwarding_state();
    CHECK(setup_signal_handling() == 0);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    CHECK(pipe(blocked_pipe) == 0);
    CHECK(fcntl(blocked_pipe[1], F_SETFL,
                fcntl(blocked_pipe[1], F_GETFL) | O_NONBLOCK) == 0);
    while (write(blocked_pipe[1], fill, sizeof(fill)) > 0)
        ;
    CHECK(errno == EAGAIN || errno == EWOULDBLOCK);

    vendor_fds[CH_EVT] = sockets[0];
    vhci_fd = blocked_pipe[1];
    CHECK(write(sockets[1], event, sizeof(event)) == (ssize_t)sizeof(event));
    CHECK(start_forwarding_thread(&forwarder, FORWARD_CHIP_TO_KERNEL) == 0);
    usleep(10000);
    on_signal(SIGTERM);

    CHECK(finish_forwarding_thread(&forwarder, 1000) == 0);
    CHECK(atomic_load(&running) == 0);
    CHECK(atomic_load(&runtime_failed) == 0);

    close(sockets[0]);
    close(sockets[1]);
    close(blocked_pipe[0]);
    close(blocked_pipe[1]);
    vhci_fd = -1;
    vendor_fds[CH_EVT] = -1;
    cleanup_signal_handling();
    return 0;
}

static int test_peer_failure_stops_both_directions(void)
{
    int vhci_sockets[2];
    int vendor_sockets[2];
    struct forwarding_thread chip_forwarder;
    struct forwarding_thread kernel_forwarder;

    reset_forwarding_state();
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, vhci_sockets) == 0);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, vendor_sockets) == 0);
    vhci_fd = vhci_sockets[0];
    vendor_fds[CH_CMD] = vendor_sockets[0];

    CHECK(start_forwarding_thread(&chip_forwarder,
                                  FORWARD_CHIP_TO_KERNEL) == 0);
    CHECK(start_forwarding_thread(&kernel_forwarder,
                                  FORWARD_KERNEL_TO_CHIP) == 0);
    close(vendor_sockets[1]);

    CHECK(finish_forwarding_thread(&chip_forwarder, 1000) == 0);
    CHECK(finish_forwarding_thread(&kernel_forwarder, 1000) == 0);
    CHECK(atomic_load(&runtime_failed) == 1);

    close(vhci_sockets[0]);
    close(vhci_sockets[1]);
    close(vendor_sockets[0]);
    vhci_fd = -1;
    vendor_fds[CH_CMD] = -1;
    return 0;
}

int main(void)
{
    CHECK(test_parse_bdaddr() == 0);
    CHECK(test_fragmented_command_complete() == 0);
    CHECK(test_response_errors() == 0);
    CHECK(test_response_timeout() == 0);
    CHECK(test_address_configuration() == 0);
    CHECK(test_controller_buffer_sizes() == 0);
    CHECK(test_h4_limits() == 0);
    CHECK(test_controller_stream_framing() == 0);
    CHECK(test_callback_lifetime() == 0);
    CHECK(test_signal_requests_clean_shutdown() == 0);
    CHECK(test_vendor_hup_only() == 0);
    CHECK(test_vendor_pollnval() == 0);
    CHECK(test_kernel_eof() == 0);
    CHECK(test_kernel_to_chip_write_failure() == 0);
    CHECK(test_chip_to_kernel_write_failure() == 0);
    CHECK(test_signal_during_write_is_clean() == 0);
    CHECK(test_peer_failure_stops_both_directions() == 0);
    puts("skw_vhci_bridge tests passed");
    return 0;
}
