#!/bin/bash
# Two uplinks and the reachability check (mica-core docs/plan/uplink-failover.md, docs/mica-core.md 3.3 and 3.4),
# over a copy of the runtime image a product already booted, with two NICs on two ISPs (uplink-lab.sh): each ISP
# a real DHCP server and a forwarding resolver, and an upstream the guest's check reaches through it. The guest asks
# for an ISP's upstream to be cut or restored on its console; its link stays up. Each boot runs the runtime suite
# with one step's actions.sh on the offline media (runtime.sh), `booted`, `fail`, `bus` and `INIT` in scope. In order:
#   failover  the write path's rules over the bus; both DHCP uplinks checked against the upstream (eth1 with its own `dns` server); eth0's upstream cut: micad's route via eth1
#             (protocol 109, metric 10), traffic and DNS through eth1, UplinkChanged and MICA_UPLINK; a lease renewal
#             (and under networkd a reconfigure) and a network apply during the failover, the route back each time;
#             eth0's upstream restored: the route gone after successesToUp, DNS back; both cut: no route of micad's,
#             the kernel's own order
#   static    eth1 static with its own `dns`, its gateway at metric 20 and the natural uplink, eth0 a lease; eth1's
#             upstream cut: micad's route via eth0; eth0's cut: nothing moves; on OpenRC the DNS order at each
# The stored default targets and route_metric_reserved are checked through the network API too (apid-api phase 04b).
# The runtime image itself is left as it was.
#
#   bash tests/suites/lifecycle-uefi/uplinks.sh <runtime evidence> <board>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
board=${2:?board required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test ! -e "$evidence/offline"
out="$evidence/uplinks"
rm -rf "$out"
mkdir -p "$out"
# The steps change DATA; the runtime image goes back as it was when they end.
cp --reflink=auto --sparse=always "$evidence/image/disk.img" "$out/runtime-disk.img"
restore() { mv -f "$out/runtime-disk.img" "$evidence/image/disk.img"; rm -rf "$evidence/offline"; }
trap restore EXIT

# step <name> <actions>
step() {
    local name=$1 actions=$2
    rm -rf "$evidence/offline" "$evidence/uplink-lab"
    mkdir -p "$evidence/offline"
    printf '%s\n' "$actions" >"$evidence/offline/actions.sh"
    # mica-build-side: container-block -- privileged for its network namespaces, taps and bridges.
    docker run --rm --label ai-agent=true --privileged --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/uplink-lab.sh image/disk.img writable 600 "$arch" >"$out/$name.log" 2>&1 || true
    # mica-build-side: host
    rm -rf "$evidence/offline"
    cp -r "$evidence/uplink-lab" "$out/$name-lab" 2>/dev/null || true
    grep -aF "FILE_AB_STEP_PASS: $name" "$out/$name.log" >/dev/null ||
        { echo "error: step $name failed; see $out/$name.log" >&2; grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$name.log" >&2 || true; exit 1; }
    echo "step $name: $(grep -a -E 'FILE_AB_STEP_PASS|FILE_AB_UPLINK:' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
}

# Shared by every step's actions.
common=$(cat <<'ACTIONS'
note() { echo "FILE_AB_UPLINK: $*"; }
asked=0
# ask <action>: the host does it (uplink-lab.sh), and says so on the offline media.
ask() {
    asked=$((asked + 1))
    echo "FILE_AB_UPLINK_ASK: $asked $1"
    i=0
    until [ -e "/run/mica/import/ack-$asked" ]; do i=$((i + 1)); [ "$i" -le 60 ] || fail "the host did not do $1"; sleep 1; done
}
# within <seconds> <what> <command...>: the command succeeds within that time, polled each second.
within() {
    t=$1 what=$2
    shift 2
    i=0
    until "$@"; do i=$((i + 1)); [ "$i" -le "$t" ] || fail "$what not within ${t} s: $(upl)"; sleep 1; done
}
obs() { mica network --json 2>/dev/null | tr -d ' \n'; }
# The uplinks part of the observation and micad's routes, for a failure.
upl() { obs | grep -o '"uplinks":{"active.*' | cut -c1-1500; printf ' routes: %s' "$(ip -4 route show default | tr '\n' ';')"; }
active_is() { obs | grep -c "\"active\":\"$1\"" >/dev/null; }
# An uplink's state. micad's keys come in name order: name, probe (one level of nesting), since, state.
state_is() {
    obs | grep -Ec "\"name\":\"$1\",\"probe\":(null|\{[^{}]*(\{[^{}]*\}[^{}]*)*\}),(\"since\":[^,]*,)?\"state\":\"$2\"" >/dev/null
}
# micad's routes, known by their metric 10 (OpenRC's busybox ip neither shows nor filters protocol 109; no other
# default route may sit below 20).
overrides() { ip -4 route show default | grep -E ' metric 10( |$)'; }
override_via() { overrides | grep -Ec "via $1 dev $2 " >/dev/null; }
no_override() { [ -z "$(overrides)" ]; }
# The uplink carries the traffic by its own route.
alone() { active_is "$1" && no_override; }
fetch() { /usr/libexec/busybox/wget -q -O- -T 3 http://192.0.2.80:8080/ 2>/dev/null; }
uplink_log() { if [ "$INIT" = systemd ]; then journalctl -b --no-pager -o cat; else logread; fi | grep MICA_UPLINK || true; }
nameservers() { sed -n 's/^nameserver //p' /etc/resolv.conf | tr '\n' ' ' | sed 's/ $//'; }
route_to() { ip -4 route show "$1" | grep -c "$2" >/dev/null; }
logged() { uplink_log | grep -c "$1" >/dev/null; }
dns_default() { resolvectl status "$1" | grep -c "Default Route: $2" >/dev/null; }
absent() { [ ! -e "$1" ]; }
# set_net <iface> <json>: a network write, applied.
set_net() {
    reply=$(bus SetSettings ss "network.$1" "$2" 2>&1) || fail "network.$1 refused: $reply"
    task=$(printf '%s' "$reply" | sed -n 's/.*"\([^"]*\)".*/\1/p' | tail -n 1)
    i=0
    until bus GetTask s "$task" 2>/dev/null | grep -c applied >/dev/null; do
        i=$((i + 1)); [ "$i" -le 90 ] || fail "network.$1 task $task: $(bus GetTask s "$task" 2>&1 | cut -c1-300)"; sleep 1
    done
}
CHECK='"probe":{"enabled":true,"targets":[{"address":"192.0.2.53","method":"tcp","port":53},{"address":"192.0.2.80","method":"icmp"}],"intervalS":2,"timeoutMs":500,"failuresToDown":2,"successesToUp":3}'
ACTIONS
)

failover=$(cat <<'ACTIONS'
# The write path's rules hold for a settings write over the bus too, as for the network API (apid-api 04b): a
# declared default route below metric 20 is refused, and a check switched on with no targets stores the two defaults.
if reply=$(bus SetSettings ss network.eth1 '{"dhcp":true,"routes":[{"destination":"0.0.0.0/0","gateway":"10.2.0.1","metric":5}]}' 2>&1); then
    fail "a default route at metric 5 was taken over the bus: $reply"
fi
case "$reply" in *route_metric_reserved*) ;; *) fail "refused over the bus, but not as route_metric_reserved: $reply" ;; esac
set_net eth1 '{"dhcp":true,"probe":{"enabled":true}}'
stored=$(bus GetSettings s network.eth1 | tr -d ' \\\n')
case "$stored" in
*'"targets":[{"address":"1.1.1.1","method":"tcp","port":53},{"address":"8.8.8.8","method":"tcp","port":53}]'*) ;;
*) fail "no default targets stored over the bus: $stored" ;;
esac
# A tunnel's listen port that a service on the device holds (core 4f981b2): refused port_in_use over the bus too.
/usr/libexec/busybox/nc -u -l -p 51830 </dev/null >/dev/null 2>&1 &
holder=$!
within 5 'UDP 51830 held' grep -qi ':CA76 ' /proc/net/udp
if reply=$(bus SetSettings ss network.wg9 '{"kind":"wireguard","dhcp":false,"static":{"address":"10.202.0.1/24"},"wireguard":{"listenPort":51830}}' 2>&1); then
    fail "a tunnel on the held port 51830 was taken over the bus: $reply"
fi
kill "$holder" 2>/dev/null || true
case "$reply" in *port_in_use*) ;; *) fail "refused over the bus, but not as port_in_use: $reply" ;; esac
note "bus rules: metric 5 refused route_metric_reserved, defaults stored, held UDP 51830 refused port_in_use"
set_net eth0 "{\"dhcp\":true,$CHECK}"
set_net eth1 "{\"dhcp\":true,\"dns\":[\"192.0.2.53\"],$CHECK}"
within 60 'eth0 up' state_is eth0 up
within 60 'eth1 up' state_is eth1 up
within 10 'eth0 alone' alone eth0
case "$(fetch)" in 'isp1 10.1.0.100') ;; *) fail "baseline traffic: $(fetch)" ;; esac
mica network >/run/mica/net-table 2>&1 || fail "mica network: $(cat /run/mica/net-table)"
grep -Eq '^eth0\* +routable +up +([^ ]+ )*10\.1\.0\.100/24' /run/mica/net-table && grep -Eq '^eth1 +routable +up +([^ ]+ )*10\.2\.0\.101/24' /run/mica/net-table ||
    fail "mica network: $(tr '\n' '|' </run/mica/net-table)"
# The first apply leaves no uplink for a moment on OpenRC (the address flush); coming back from none is a change.
if uplink_log | grep -c 'reason=none-up' >/dev/null; then
    within 10 'the change back from no uplink' logged 'previous=- reason=recovered'
    note "from none: $(uplink_log | grep 'previous=- reason=recovered' | sed -n '$p' | sed 's/.*MICA_UPLINK/MICA_UPLINK/')"
fi
note "baseline: active eth0, $(fetch), routes $(ip -4 route show default | tr '\n' ';') table $(tr -s ' ' </run/mica/net-table | tr '\n' '|')"
if [ "$INIT" = openrc ]; then
    [ ! -e /run/mica/resolv.order ] || fail "resolv.order with nothing steered: $(cat /run/mica/resolv.order)"
    base_ns=$(nameservers)
    note "resolv.conf with nothing steered: $base_ns"
fi
dbus-monitor --system "type='signal',member='UplinkChanged'" >/run/mica/uplink-signals 2>&1 &
monitor=$!
sleep 1

# eth0's upstream cut, its link up.
ask cut-isp1
within 30 'eth0 down' state_is eth0 down
within 10 'the route via eth1' override_via 10.2.0.1 eth1
active_is eth1 || fail "active is not eth1: $(upl)"
case "$(fetch)" in 'isp2 10.2.0.101') ;; *) fail "traffic during the failover: $(fetch)" ;; esac
if [ "$INIT" = systemd ]; then
    resolvectl status eth0 | grep -c 'Default Route: no' >/dev/null || fail "eth0 still a DNS default route: $(resolvectl status eth0 | tr '\n' '|')"
    resolvectl status eth1 | grep -c 'Default Route: yes' >/dev/null || fail "eth1 not a DNS default route: $(resolvectl status eth1 | tr '\n' '|')"
    resolvectl flush-caches
    resolvectl query uplink.test | grep -c 192.0.2.80 >/dev/null || fail "lookup during the failover: $(resolvectl query uplink.test 2>&1)"
    note "dns: eth0 Default Route no, eth1 yes, uplink.test resolved"
else
    order=$(tr '\n' ' ' </run/mica/resolv.order | sed 's/ $//')
    case "$order" in '00-eth1 eth1 '*eth0*) ;; *) fail "resolv.order during the failover: $order" ;; esac
    [ "$(nameservers)" = '192.0.2.53 10.2.0.1 10.1.0.1' ] || fail "resolv.conf during the failover: $(nameservers)"
    getent hosts uplink.test | grep -c 192.0.2.80 >/dev/null || fail "lookup during the failover: $(getent hosts uplink.test 2>&1)"
    note "dns: resolv.order '$order', nameservers $(nameservers), uplink.test resolved"
fi
within 10 'UplinkChanged' grep -q UplinkChanged /run/mica/uplink-signals
uplink_log | grep -c 'MICA_UPLINK active=eth1 previous=eth0 reason=probe' >/dev/null || fail "no MICA_UPLINK line: $(uplink_log)"
note "cut: $(overrides), $(fetch), $(uplink_log | tail -n 1)"

# A lease renewal during the failover (OpenRC: mica-udhcpc flushes eth1's addresses), and under networkd a
# reconfigure, which drops foreign routes: the route comes back.
if [ "$INIT" = systemd ]; then
    networkctl renew eth1 || fail 'networkctl renew eth1'
    sleep 3
    within 15 'the route back after a renewal' override_via 10.2.0.1 eth1
    networkctl reconfigure eth1 || fail 'networkctl reconfigure eth1'
    sleep 3
    within 15 'the route back after a reconfigure' override_via 10.2.0.1 eth1
else
    /usr/libexec/busybox/pkill -USR1 -f 'udhcpc.*eth1' || fail 'no udhcpc for eth1'
    sleep 3
    within 15 'the route back after a renewal' override_via 10.2.0.1 eth1
fi
case "$(fetch)" in 'isp2 10.2.0.101') ;; *) fail "traffic after the renewal: $(fetch)" ;; esac
note 'renewal during the failover: the route back'

# A network apply during the failover.
set_net eth1 "{\"dhcp\":true,\"dns\":[\"192.0.2.53\"],\"routes\":[{\"destination\":\"198.51.100.0/24\",\"gateway\":\"10.2.0.1\"}],$CHECK}"
within 30 'the static route of the apply' route_to 198.51.100.0/24 'via 10.2.0.1 dev eth1'
within 15 'the route back after a network apply' override_via 10.2.0.1 eth1
active_is eth1 || fail "active after the apply: $(upl)"
note 'network apply during the failover: the route back'

# eth0's upstream restored: the route gone once eth0 has answered successesToUp rounds.
ask restore-isp1
within 30 'eth0 up again' state_is eth0 up
within 5 'the route gone' no_override
active_is eth0 || fail "active after the restore: $(upl)"
case "$(fetch)" in 'isp1 10.1.0.100') ;; *) fail "traffic after the restore: $(fetch)" ;; esac
within 10 'the recovered line' logged 'MICA_UPLINK active=eth0 previous=eth1 reason=recovered'
if [ "$INIT" = systemd ]; then
    within 10 'eth0 a DNS default route again' dns_default eth0 yes
else
    within 10 'resolv.order removed' absent /run/mica/resolv.order
    [ "$(nameservers)" = "$base_ns" ] || fail "resolv.conf after the restore: $(nameservers), not $base_ns"
fi
note "restored: no route of micad's, $(fetch), $(uplink_log | tail -n 1)"

# Both cut: nothing is up, so micad steers nothing and the kernel's own order applies.
ask cut-isp1
ask cut-isp2
within 30 'eth0 down' state_is eth0 down
within 30 'eth1 down' state_is eth1 down
sleep 4
no_override || fail "a route with both down: $(overrides)"
ip -4 route show default | grep -c 'via 10.1.0.1 dev eth0 .*metric 100' >/dev/null && ip -4 route show default | grep -c 'via 10.2.0.1 dev eth1 .*metric 110' >/dev/null ||
    fail "the uplinks' own routes: $(ip -4 route show default | tr '\n' ';')"
note "both cut: no route of micad's, $(ip -4 route show default | tr '\n' ';') $(uplink_log | tail -n 1)"
ask restore-isp1
ask restore-isp2
kill $monitor 2>/dev/null || true
note "signals: $(grep -c UplinkChanged /run/mica/uplink-signals) UplinkChanged"
echo 'FILE_AB_STEP_PASS: failover'
ACTIONS
)
static=$(cat <<'ACTIONS'
# A static uplink and a DHCP one, the check on both (core R2b): eth0's lease names 10.1.0.1 and it declares no
# servers; eth1 is static at metric 20, the natural uplink, with servers of its own. OpenRC: Base's order with
# nothing steered (file names, eth0 then eth1), then the active uplink's files first.
dns_is() { # <resolv.order, empty for none> <nameservers>
    if [ -z "$1" ]; then [ ! -e /run/mica/resolv.order ]; else [ "$(tr '\n' ' ' </run/mica/resolv.order 2>/dev/null | sed 's/ $//')" = "$1" ]; fi &&
        [ "$(nameservers)" = "$2" ]
}
dns_check() { # <what> <resolv.order> <nameservers>
    [ "$INIT" = openrc ] || return 0
    within 15 "$1: resolv.order '$2', nameservers $3" dns_is "$2" "$3"
    note "dns $1: resolv.order '$([ -e /run/mica/resolv.order ] && tr '\n' ' ' </run/mica/resolv.order)', nameservers $(nameservers)"
}
set_net eth0 "{\"dhcp\":true,$CHECK}"
set_net eth1 "{\"static\":{\"address\":\"10.2.0.50/24\",\"gateway\":\"10.2.0.1\",\"dns\":[\"192.0.2.53\"]},$CHECK}"
within 30 'the static gateway at metric 20' route_to default 'via 10.2.0.1 dev eth1 .*metric 20'
ip -4 route show default | grep -c 'via 10.1.0.1 dev eth0 .*metric 100' >/dev/null || fail "eth0's lease route: $(ip -4 route show default | tr '\n' ';')"
within 60 'eth1 up' state_is eth1 up
within 60 'eth0 up' state_is eth0 up
within 10 'eth1 alone' alone eth1
note "static: $(ip -4 route show default | tr '\n' ';')"
dns_check 'both up' '' '10.1.0.1 192.0.2.53'
ask cut-isp2
within 30 'eth1 down' state_is eth1 down
within 10 'the route via eth0' override_via 10.1.0.1 eth0
case "$(fetch)" in 'isp1 10.1.0.100') ;; *) fail "traffic with the static uplink cut: $(fetch)" ;; esac
note "static cut: $(overrides), $(fetch)"
dns_check 'eth1 cut' '00-eth0 eth0 00-eth1 eth1' '10.1.0.1 192.0.2.53'
ask restore-isp2
within 30 'eth1 up again' state_is eth1 up
within 5 'the route gone' no_override
dns_check 'eth1 restored' '' '10.1.0.1 192.0.2.53'
ask cut-isp1
within 30 'eth0 down' state_is eth0 down
active_is eth1 && no_override || fail "the lease uplink cut moved the traffic: $(upl)"
dns_check 'eth0 cut' '00-eth1 eth1 00-eth0 eth0' '192.0.2.53 10.1.0.1'
ask restore-isp1
within 30 'eth0 up again' state_is eth0 up
dns_check 'eth0 restored' '' '10.1.0.1 192.0.2.53'
echo 'FILE_AB_STEP_PASS: static'
ACTIONS
)

step failover "$common
$failover"
step static "$common
$static"
echo "UPLINKS_PASS: $board"
