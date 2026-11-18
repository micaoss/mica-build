#!/usr/bin/env bash
# Run inside the lab image, privileged, with the evidence directory mounted at /w: two ISPs for a guest with two
# NICs (uplinks.sh), then boot.sh with UPLINK_TAPS=1.
# mica-build-side: container -- network namespaces, dnsmasq and QEMU run in the acceptance lab image.
#
#   guest eth0 -- tap1 -- br1 -- isp1: 10.1.0.1/24, DHCP (10.1.0.100 to eth0) and a forwarding resolver
#   guest eth1 -- tap2 -- br2 -- isp2: 10.2.0.1/24, DHCP (10.2.0.101 to eth1) and a forwarding resolver
#   each ISP's upstream, namespace up<n> behind the ISP's link `wan` (10.<n>.255.0/30): 192.0.2.53 (the resolver
#   the ISP's forwards to, which answers uplink.test and serves DNS over TCP, the check's target) and 192.0.2.80
#   (ICMP, and on port 8080 a server that answers with its ISP's name and the client's address)
#
# The guest asks for a change on its console, `FILE_AB_UPLINK_ASK: <n> <action>`; once done it is acknowledged by
# /w/offline/ack-<n>, which the guest reads on its offline media:
#   cut-<isp>, restore-<isp>   the ISP's link to its upstream down or up, the guest's link left up
# (Down in its own namespace: an address on a down link of the ISP's namespace would still be answered there.)
set -euo pipefail
cd /w
log=/w/uplink-lab
mkdir -p "$log"
mac() { printf '52:54:00:12:0%s:01' "$1"; }
for n in 1 2; do
    ns=isp$n
    ip netns add "$ns"
    ip -n "$ns" link set lo up
    ip tuntap add "tap$n" mode tap
    ip link add "br$n" type bridge
    ip link add "lan$n" type veth peer name lan netns "$ns"
    ip link set "tap$n" master "br$n"
    ip link set "lan$n" master "br$n"
    ip link set "tap$n" up
    ip link set "lan$n" up
    ip link set "br$n" up
    ip -n "$ns" addr add "10.$n.0.1/24" dev lan
    ip -n "$ns" link set lan up
    ip netns add "up$n"
    ip -n "up$n" link set lo up
    ip link add wan netns "$ns" type veth peer name wan netns "up$n"
    ip -n "$ns" addr add "10.$n.255.1/30" dev wan
    ip -n "up$n" addr add "10.$n.255.2/30" dev wan
    ip -n "up$n" addr add 192.0.2.53/32 dev lo
    ip -n "up$n" addr add 192.0.2.80/32 dev lo
    ip -n "$ns" link set wan up
    ip -n "up$n" link set wan up
    ip -n "$ns" route add 192.0.2.0/24 via "10.$n.255.2"
    ip -n "up$n" route add "10.$n.0.0/24" via "10.$n.255.1"
    ip netns exec "$ns" sh -c "echo 1 >/proc/sys/net/ipv4/ip_forward"
    # The upstream resolver, and the ISP's own: DHCP, and DNS forwarded upstream (nothing answered locally). The
    # lease names its resolver even unasked, as some ISPs' do: an uplink with servers of its own asks for none.
    ip netns exec "up$n" dnsmasq --keep-in-foreground --conf-file=/dev/null --pid-file= --user=root \
        --listen-address=192.0.2.53 --bind-interfaces --no-resolv --no-hosts --address=/uplink.test/192.0.2.80 \
        --log-queries --log-facility="$log/$ns-upstream.log" &
    ip netns exec "$ns" dnsmasq --keep-in-foreground --conf-file=/dev/null --pid-file= --user=root \
        --interface=lan --bind-interfaces --no-resolv --no-hosts --server=192.0.2.53 \
        --dhcp-range="10.$n.0.100,10.$n.0.150,255.255.255.0,2m" --dhcp-host="$(mac "$n"),10.$n.0.$((99 + n))" \
        --dhcp-option=option:router,"10.$n.0.1" --dhcp-option-force=option:dns-server,"10.$n.0.1" \
        --dhcp-leasefile="$log/$ns.leases" --log-dhcp --log-queries --log-facility="$log/$ns.log" &
    ip netns exec "up$n" python3 -c '
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = ("%s %s\n" % (sys.argv[1], self.client_address[0])).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("192.0.2.80", 8080), H).serve_forever()
' "$ns" >"$log/$ns-echo.log" 2>&1 &
done

# The guest's asks, done in order; none from an earlier boot's console.
rm -f serial.log
(
    done=0
    while :; do
        while read -r n action; do
            [ "$n" -gt "$done" ] || continue
            case "$action" in
            cut-isp1 | cut-isp2) ip -n "${action#cut-}" link set wan down ;;
            restore-isp1 | restore-isp2)
                isp=${action#restore-}
                ip -n "$isp" link set wan up
                ip -n "$isp" route replace 192.0.2.0/24 via "10.${isp#isp}.255.2"
                ;;
            *) echo "uplink-lab: unknown ask $n $action" >&2 ;;
            esac
            echo "$(date +%T) $n $action" >>"$log/asks.log"
            touch "/w/offline/ack-$n"
            done=$n
        done < <(tr -d '\r' <serial.log 2>/dev/null | sed -n 's/.*FILE_AB_UPLINK_ASK: \([0-9]*\) \([a-z0-9-]*\).*/\1 \2/p')
        sleep 1
    done
) &
UPLINK_TAPS=1 exec bash /harness/boot.sh "$@"
