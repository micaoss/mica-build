# Sourced by the acceptance programs in the guest: the product's init, and the commands of it they use.
INIT="$(sed -n 's/^INIT=//p' /usr/lib/mica/product.conf)"
case "$INIT" in systemd | openrc) ;; *) echo "error: /usr/lib/mica/product.conf says INIT=$INIT" >/dev/console; exit 1 ;; esac

# bus <method> [<signature> <argument>...]: a call on micad's interface, busctl's argument form. Under OpenRC the
# call is dbus-send's, every argument a string.
bus() {
    if [ "$INIT" = systemd ]; then
        busctl --system call com.mica.micad /com/mica/micad com.mica.micad1 "$@"
        return
    fi
    method=$1
    shift
    [ "$#" -eq 0 ] || shift
    for arg in "$@"; do set -- "$@" "string:$arg"; shift; done
    dbus-send --system --print-reply --dest=com.mica.micad /com/mica/micad "com.mica.micad1.$method" "$@"
}

# service_active <name>: the service runs; a systemd unit is <name>.service.
service_active() {
    if [ "$INIT" = systemd ]; then systemctl is-active --quiet "$1.service"; else rc-service "$1" status >/dev/null 2>&1; fi
}

# log_tail <lines> [<unit>...]: the boot's log, of the named units under systemd.
log_tail() {
    lines=$1
    shift
    if [ "$INIT" = systemd ]; then
        for unit in "$@"; do set -- "$@" -u "$unit"; shift; done
        journalctl --no-pager -b "$@" -n "$lines"
    else
        logread | tail -n "$lines"
    fi
}

# power_off [now]: the ordered poweroff, or with `now` the immediate one a failure takes.
power_off() {
    if [ "$INIT" = systemd ]; then
        if [ "${1:-}" = now ]; then systemctl poweroff --force; else systemctl --no-block poweroff; fi
    else
        openrc-shutdown --poweroff now
    fi
}
