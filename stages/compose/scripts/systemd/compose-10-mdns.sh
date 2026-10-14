#!/bin/sh
# The multicast-DNS decision: the global fail-safe and the explicit statement of what eth* already resolves to.
# See src/rootfs/build.ts for why both.
#
# Called from stages/compose/compose-install.sh through init-steps.sh.
set -eu
install -D -m 0644 /mica-compose/resolved-mdns.conf /etc/systemd/resolved.conf.d/10-mica-mdns.conf
install -D -m 0644 /mica-compose/network-mdns.conf /etc/systemd/network/80-dhcp.network.d/10-mica-mdns.conf
