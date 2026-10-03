#ifndef SKW_H4_H
#define SKW_H4_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define SKW_H4_COMMAND_PKT 0x01
#define SKW_H4_ACL_PKT 0x02
#define SKW_H4_SCO_PKT 0x03
#define SKW_H4_EVENT_PKT 0x04
#define SKW_H4_ISO_PKT 0x05
#define SKW_H4_LOG_PKT 0x07

#define SKW_H4_KERNEL_MAX_FRAME 1028U
#define SKW_H4_EVENT_MAX_FRAME 258U
#define SKW_H4_COMMAND_MAX_FRAME 259U
#define SKW_H4_SCO_MAX_FRAME 259U
#define SKW_H4_ISO_MAX_FRAME 256U
#define SKW_H4_STREAM_CAPACITY 4096U

enum skw_h4_status {
    SKW_H4_INVALID = -1,
    SKW_H4_INCOMPLETE = 0,
    SKW_H4_COMPLETE = 1,
};

struct skw_h4_frame {
    uint8_t type;
    size_t header_size;
    size_t payload_size;
    size_t frame_size;
};

struct skw_h4_stream {
    uint8_t data[SKW_H4_STREAM_CAPACITY];
    size_t length;
};

static inline enum skw_h4_status skw_h4_decode(
    const uint8_t *data, size_t length, struct skw_h4_frame *frame)
{
    size_t header_size;
    size_t payload_size;

    memset(frame, 0, sizeof(*frame));
    if (length == 0)
        return SKW_H4_INCOMPLETE;

    frame->type = data[0];
    switch (frame->type) {
    case SKW_H4_COMMAND_PKT:
        header_size = 4;
        break;
    case SKW_H4_ACL_PKT:
        header_size = 5;
        break;
    case SKW_H4_SCO_PKT:
        header_size = 4;
        break;
    case SKW_H4_EVENT_PKT:
        header_size = 3;
        break;
    case SKW_H4_ISO_PKT:
        header_size = 5;
        break;
    case SKW_H4_LOG_PKT:
        header_size = 4;
        break;
    default:
        return SKW_H4_INVALID;
    }

    frame->header_size = header_size;
    if (length < header_size)
        return SKW_H4_INCOMPLETE;

    switch (frame->type) {
    case SKW_H4_COMMAND_PKT:
    case SKW_H4_SCO_PKT:
        payload_size = data[3];
        break;
    case SKW_H4_EVENT_PKT:
        payload_size = data[2];
        break;
    case SKW_H4_ACL_PKT:
        payload_size = (size_t)data[3] | ((size_t)data[4] << 8);
        break;
    case SKW_H4_ISO_PKT: {
        uint16_t encoded = (uint16_t)data[3] | ((uint16_t)data[4] << 8);

        if ((encoded >> 14) == 3)
            return SKW_H4_INVALID;
        payload_size = encoded & 0x3fffU;
        break;
    }
    case SKW_H4_LOG_PKT:
        payload_size = (size_t)data[2] | ((size_t)data[3] << 8);
        break;
    default:
        return SKW_H4_INVALID;
    }

    frame->payload_size = payload_size;
    frame->frame_size = header_size + payload_size;
    if (frame->frame_size > SKW_H4_STREAM_CAPACITY)
        return SKW_H4_INVALID;
    if (length < frame->frame_size)
        return SKW_H4_INCOMPLETE;
    return SKW_H4_COMPLETE;
}

static inline int skw_h4_stream_append(struct skw_h4_stream *stream,
                                       const uint8_t *data, size_t length)
{
    if (stream->length > sizeof(stream->data))
        return -1;
    if (length > sizeof(stream->data) - stream->length)
        return -1;
    memcpy(stream->data + stream->length, data, length);
    stream->length += length;
    return 0;
}

static inline enum skw_h4_status skw_h4_stream_next(
    const struct skw_h4_stream *stream, struct skw_h4_frame *frame)
{
    return skw_h4_decode(stream->data, stream->length, frame);
}

static inline int skw_h4_stream_consume(struct skw_h4_stream *stream,
                                        size_t length)
{
    if (length > stream->length)
        return -1;
    stream->length -= length;
    memmove(stream->data, stream->data + length, stream->length);
    return 0;
}

#endif
