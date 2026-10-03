#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#define BIT(x) (1U << (x))
#define AML_UART_RX_EMPTY BIT(20)
#define AML_UART_TX_FULL BIT(21)
#define AML_UART_TX_EMPTY BIT(22)
#define AML_UART_ERR (BIT(16) | BIT(17) | BIT(18))
struct meson_uart { uint32_t status; };
struct meson_serial_plat { struct meson_uart *reg; };
struct udevice { struct meson_serial_plat *plat; };
static unsigned int rx_errors;
static void *dev_get_plat(struct udevice *dev) { return dev->plat; }
static uint32_t readl(uint32_t *p) { return *p; }
static void meson_serial_rx_error(struct udevice *dev)
{ (void)dev; rx_errors++; }
#include "vendor-serial-function.c"

int main(void)
{
    struct meson_uart uart;
    struct meson_serial_plat plat = { &uart };
    struct udevice dev = { &plat };
    const struct { const char *name; uint32_t status; bool input; int expected; } cases[] = {
        { "transmitter empty", AML_UART_RX_EMPTY | AML_UART_TX_EMPTY, false, 0 },
        { "transmitter partially full", AML_UART_RX_EMPTY, false, 1 },
        { "transmitter full", AML_UART_RX_EMPTY | AML_UART_TX_FULL, false, 1 },
        { "receiver empty", AML_UART_RX_EMPTY | AML_UART_TX_EMPTY, true, 0 },
        { "receiver has data", AML_UART_TX_EMPTY, true, 1 },
        { "receiver error", AML_UART_TX_EMPTY | BIT(16), true, 0 },
    };
    int failed = 0;
    for (unsigned int i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        uart.status = cases[i].status;
        int actual = meson_serial_pending(&dev, cases[i].input);
        printf("%s: expected=%d actual=%d\n", cases[i].name, cases[i].expected, actual);
        failed += actual != cases[i].expected;
    }
    failed += rx_errors != 1;
    return failed != 0;
}
