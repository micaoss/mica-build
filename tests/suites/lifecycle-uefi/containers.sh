# Sourced by runtime.sh on a product with the containers feature, on either init: a container declared through
# micad's settings is run by mica-containerd, restarted when killed, kept stopped across a restart of the daemon,
# and started at the next boot. The first boot of a factory disk declares it; a later boot of the same DATA
# (the update stage's) finds it running.
PROBE_MARK=/mica/.container-probe

# ctl_phase <name>: the phase mica-containerd reports for <name>, or nothing.
ctl_phase() {
    mica-containerd ctl get "$1" 2>/dev/null | sed -n 's/.*"phase": *"\([a-z]*\)".*/\1/p' | head -n1
}

ctl_restarts() {
    mica-containerd ctl get "$1" 2>/dev/null | sed -n 's/.*"restarts": *\([0-9]*\).*/\1/p' | head -n1
}

# wait_phase <name> <phase> <seconds>
wait_phase() {
    n=0
    while [ "$n" -lt "$3" ]; do
        [ "$(ctl_phase "$1")" = "$2" ] && return 0
        n=$((n + 1))
        sleep 1
    done
    echo "container $1: phase $(ctl_phase "$1"), wanted $2 after $3 s" >/dev/console
    mica-containerd ctl list >/dev/console 2>&1 || true
    return 1
}

restart_supervisor() {
    if [ "$INIT" = systemd ]; then systemctl restart mica-containerd.service; else rc-service mica-containerd restart; fi
}

container_checks() {
    if [ "$INIT" = openrc ]; then
        # /proc/mounts rather than stat -f: busybox's stat names no cgroup2 filesystem type.
        grep -q '^[^ ]* /sys/fs/cgroup cgroup2 ' /proc/mounts || fail 'OpenRC did not mount the unified cgroup hierarchy'
    fi
    if [ -f "$PROBE_MARK" ]; then
        # Declared with autoStart on an earlier boot of this DATA.
        wait_phase probe running 120 || fail 'the declared container did not start at boot'
        echo FILE_AB_CONTAINER_BOOT_PASS
        return 0
    fi
    # An image of the root's own static busybox: nothing to fetch on a device with no network.
    rm -rf /run/mica/probe-image && mkdir -p /run/mica/probe-image/bin
    cp /usr/bin/busybox /run/mica/probe-image/bin/busybox
    ln -s busybox /run/mica/probe-image/bin/sh
    tar -c -C /run/mica/probe-image . | podman import - localhost/mica-probe:1 >/dev/null || fail 'podman import of the probe image'
    rm -rf /run/mica/probe-image
    unit='{"enabled":true,"units":{"probe":{"image":"localhost/mica-probe:1","command":["/bin/busybox","sleep","3600"],"restart":"always","autoStart":true,"pids":64,"memory":"32m"}}}'
    bus SetSettings ss container "$unit" >/dev/null || fail 'SetSettings container'
    wait_phase probe running 120 || fail 'the declared container did not run'
    before=$(ctl_restarts probe)
    podman kill probe >/dev/null 2>&1 || fail 'podman kill probe'
    n=0
    while [ "$n" -lt 60 ]; do
        [ "$(ctl_phase probe)" = running ] && [ "$(ctl_restarts probe)" -gt "$before" ] && break
        n=$((n + 1))
        sleep 1
    done
    [ "$n" -lt 60 ] || fail 'a killed container was not restarted'
    bus StopContainer s probe >/dev/null || fail 'StopContainer'
    wait_phase probe stopped 60 || fail 'StopContainer did not stop the container'
    restart_supervisor || fail 'restarting mica-containerd'
    sleep 5
    wait_phase probe stopped 30 || fail 'a stopped container did not stay stopped across a restart of mica-containerd'
    bus StartContainer s probe >/dev/null || fail 'StartContainer'
    wait_phase probe running 60 || fail 'StartContainer did not start the container'
    bus GetContainers > /run/mica/containers.json || fail 'GetContainers'
    grep -F 'probe' /run/mica/containers.json >/dev/null && grep -F 'running' /run/mica/containers.json >/dev/null ||
        fail 'GetContainers does not agree with mica-containerd'
    mica-containerd ctl list | grep -E '^probe +running +running' >/dev/null || fail 'mica-containerd ctl list does not report the running probe'
    : > "$PROBE_MARK"
    echo FILE_AB_CONTAINER_PASS
}
