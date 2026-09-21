#!/usr/bin/env bash
# Offline contract tests for hwinit/hwinit-gadget, the script
# that builds the CDC ACM debug console gadget in configfs.
#
# WHAT THIS MODELS, AND WHY THE MODEL IS THE TEST. configfs does not store a
# symlink and resolve it on use. `configfs_symlink()` resolves the target
# STRING at creation time with `kern_path()` -- fs/configfs/symlink.c
# `get_target()` -- and `kern_path()` resolves a relative path against the
# CALLING PROCESS's working directory, not against the directory the link is
# created in. A temporary directory cannot reproduce that: on any ordinary
# filesystem `../../functions/acm.usb0` from `configs/c.1/` resolves correctly
# no matter where the process stands, which is exactly why the defect survived
# review. So case 1 asserts the PROPERTY configfs applies -- the target string
# must name the function directory when resolved from the process's own cwd --
# rather than asserting that a link exists, which the broken script also
# satisfied.
#
# The defect this closes, measured on hardware 2026-09-08 (RFCT-355): the
# service runs from `/` (Type=oneshot, no WorkingDirectory=), the relative
# target resolved as `/functions/acm.usb0`, symlink(2) returned ENOENT,
# `2>/dev/null || true` swallowed it, and the empty configuration was handed to
# the UDC:
#
#   Config c/1 of cx3576_serial needs at least one function.
#   udc 23000000.usb: failed to start cx3576_serial: -22
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT=$HERE/../package/hwinit/hwinit-gadget
CONF_SRC=$HERE/../package/init/gadget.conf
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

[ -r "$SCRIPT" ] || { echo "no $SCRIPT to test" >&2; exit 1; }
[ -r "$CONF_SRC" ] || { echo "no $CONF_SRC to read the gadget name from" >&2; exit 1; }

NAME=$(sed -n '/^name=/{s/^name=//;p;q;}' "$CONF_SRC")
[ -n "$NAME" ] || { echo "$CONF_SRC declares no name=" >&2; exit 1; }

fail() { echo "FAIL $*" >&2; exit 1; }

# One case: a fresh fake configfs and the board's own gadget.conf.
new_case() {
    CASE=$WORK/$1
    CONFIGFS=$CASE/config
    UDCDIR=$CASE/udc
    G=$CONFIGFS/usb_gadget/$NAME
    mkdir -p "$CONFIGFS/usb_gadget" "$UDCDIR"
    cp "$CONF_SRC" "$CASE/gadget.conf"
}

# Run it the way mica-gadget.service does: cwd `/`, which is what makes a
# relative configfs target resolve somewhere else entirely.
run_gadget() {
    ( cd / && MICA_GADGET_CONF=$CASE/gadget.conf \
        MICA_GADGET_CONFIGFS=$CONFIGFS \
        MICA_GADGET_UDC_DIR=$UDCDIR \
        sh "$SCRIPT" ) 2>"$CASE/stderr"
}

# --- 1. the function is linked, and its target survives the caller's cwd -----

new_case linked
printf 'dummy_udc\n' >"$UDCDIR/dummy_udc"
run_gadget

link=$G/configs/c.1/acm.usb0
[ -L "$link" ] || fail "no function symlink at configs/c.1/acm.usb0"

target=$(readlink "$link")
case "$target" in
/*) ;;
*) fail "function symlink target '$target' is relative; configfs resolves it against the caller's cwd, not against $G/configs/c.1" ;;
esac

# The property itself, and not merely "it starts with a slash": resolve the
# stored string the way get_target() will, from a cwd that is not the gadget
# directory, and require it to land on the function.
( cd / && [ -d "$target" ] ) \
    || fail "function symlink target '$target' does not resolve to a directory from cwd=/, which is the cwd mica-gadget.service runs with"
[ "$(cd / && cd "$target" && pwd -P)" = "$(cd "$G/functions/acm.usb0" && pwd -P)" ] \
    || fail "function symlink target '$target' resolves somewhere other than $G/functions/acm.usb0"

# --- 2. with a function linked, the UDC is bound ----------------------------

# The gadget directory in a real configfs carries a UDC attribute; the fake one
# gets it here so the bind path is reachable at all.
: >"$G/UDC"
run_gadget
[ "$(cat "$G/UDC")" = dummy_udc ] \
    || fail "UDC was not bound although the configuration has a function: '$(cat "$G/UDC")'"

# --- 3. a configuration with no function is NOT handed to the UDC -----------
#
# The failure is forced the way the kernel forces it and not by editing the
# script: configs/c.1 is a regular file, so `ln -s` into it fails with ENOTDIR
# for root as well as for anyone else. This is the state the hardware was in.

new_case unlinked
printf 'dummy_udc\n' >"$UDCDIR/dummy_udc"
mkdir -p "$G/strings/0x409" # so the one-time string block is skipped
: >"$G/configs" # `configs` is a file: nothing can be created under it
: >"$G/UDC"
run_gadget

[ ! -e "$G/configs/c.1/acm.usb0" ] || fail "case 3 did not actually prevent the link"
[ -z "$(cat "$G/UDC")" ] \
    || fail "a configuration with no function was bound to '$(cat "$G/UDC")'; the UDC answers that with EINVAL and the console blames the UDC"
grep -q 'has no function linked' "$CASE/stderr" \
    || fail "binding was refused without saying why; stderr was: $(cat "$CASE/stderr")"

echo "PASS gadget-configfs-test: 3 cases"
