# Sourced by runtime.sh on a product with the containers feature, on either init. On podman, a Compose project
# declared through micad's settings is run by mica-containerd, its container restarted when killed, kept stopped
# across a restart of the daemon, and started at the next boot. On docker nothing is declared (micad refuses it):
# container.enabled has micad start dockerd, a project brought up by hand with docker compose is listed by micad,
# restarted by dockerd when killed, stopped and started through micad, kept stopped across a restart of dockerd,
# and started at the next boot. The first boot of a factory disk sets it up; a later boot of the same DATA (the
# update stage's) finds it running.
PROBE_MARK=/mica/.container-probe
ENGINE="$(sed -n 's/^CONTAINER_ENGINE=//p' /usr/lib/mica/product.conf)"

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

# probe_image <engine>: an image of the root's own static busybox, imported as localhost/mica-probe:1. Nothing to
# fetch on a device with no network.
probe_image() {
    rm -rf /run/mica/probe-image && mkdir -p /run/mica/probe-image/bin
    cp /usr/bin/busybox /run/mica/probe-image/bin/busybox
    ln -s busybox /run/mica/probe-image/bin/sh
    tar -c -C /run/mica/probe-image . | "$1" import - localhost/mica-probe:1 >/dev/null || fail "$1 import of the probe image"
    rm -rf /run/mica/probe-image
}

# The phase micad reports for project probe, service probe, from `micad ctr list` (PROJECT SERVICE CONTAINER PHASE
# HEALTH), or nothing.
ctr_phase() {
    micad ctr list 2>/dev/null | awk '$1 == "probe" && $2 == "probe" && $3 == "probe" { print $4; exit }'
}

# ctr_wait <phase> <seconds>
ctr_wait() {
    n=0
    while [ "$n" -lt "$2" ]; do
        [ "$(ctr_phase)" = "$1" ] && return 0
        n=$((n + 1))
        sleep 1
    done
    echo "container probe: phase $(ctr_phase), wanted $1 after $2 s" >/dev/console
    micad ctr list >/dev/console 2>&1 || true
    return 1
}

# docker_fail <reason>: dockerd's own log first, which fail()'s units do not include.
docker_fail() {
    log_tail 120 docker
    fail "$1"
}

restart_dockerd() {
    if [ "$INIT" = systemd ]; then systemctl restart docker.service; else rc-service docker restart; fi
}

docker_checks() {
    if [ -f "$PROBE_MARK" ]; then
        # Turned on on an earlier boot of this DATA: micad starts dockerd, and dockerd the probe by its restart policy.
        ctr_wait running 120 || fail 'the probe container did not start at boot'
        echo FILE_AB_CONTAINER_BOOT_PASS
        return 0
    fi
    # Nothing is declared on docker: a project in the settings is refused, and containers are docker compose's.
    if bus SetSettings ss container '{"enabled":true,"projects":{"probe":"services: {}\n"}}' >/dev/null 2>&1; then
        fail 'micad accepted a container declaration on docker'
    fi
    bus SetSettings ss container '{"enabled":true}' >/dev/null || fail 'SetSettings container.enabled'
    n=0
    until docker info >/dev/null 2>&1; do
        n=$((n + 1))
        [ "$n" -lt 120 ] || docker_fail 'container.enabled did not start dockerd'
        sleep 1
    done
    [ "$(docker info --format '{{.DockerRootDir}}')" = /mica/containers/docker ] || fail 'Docker data root differs'
    probe_image docker
    # unless-stopped and not always: a container stopped through micad stays stopped when dockerd restarts.
    mkdir -p /run/mica/probe
    cat >/run/mica/probe/compose.yaml <<'COMPOSE'
services:
  probe:
    image: localhost/mica-probe:1
    pull_policy: never
    container_name: probe
    command: ['/bin/sh', '-c', 'trap ''exit 0'' TERM; while :; do /bin/busybox sleep 1; done']
    restart: unless-stopped
    pids_limit: 64
    mem_limit: 32m
COMPOSE
    docker compose -p probe -f /run/mica/probe/compose.yaml up -d >/dev/console 2>&1 || docker_fail 'docker compose up of the probe project'
    ctr_wait running 120 || fail 'micad does not list the compose project running'
    # Killed from outside, it exited on its own as far as dockerd knows, and the restart policy brings it back.
    before=$(docker inspect -f '{{.RestartCount}}' probe)
    kill -KILL "$(docker inspect -f '{{.State.Pid}}' probe)" || fail 'kill the probe container'
    n=0
    while [ "$n" -lt 60 ]; do
        [ "$(ctr_phase)" = running ] && [ "$(docker inspect -f '{{.RestartCount}}' probe)" -gt "$before" ] && break
        n=$((n + 1))
        sleep 1
    done
    [ "$n" -lt 60 ] || fail 'a killed container was not restarted'
    bus StopContainer s probe/probe >/dev/null || fail 'StopContainer'
    ctr_wait exited 60 || fail 'StopContainer did not stop the container'
    restart_dockerd || fail 'restarting dockerd'
    n=0
    until docker info >/dev/null 2>&1; do
        n=$((n + 1))
        [ "$n" -lt 60 ] || docker_fail 'dockerd did not come back after a restart'
        sleep 1
    done
    sleep 5
    ctr_wait exited 30 || fail 'a stopped container did not stay stopped across a restart of dockerd'
    bus StartContainer s probe/probe >/dev/null || fail 'StartContainer'
    ctr_wait running 60 || fail 'StartContainer did not start the container'
    bus GetContainers > /run/mica/containers.json || fail 'GetContainers'
    grep -F 'probe' /run/mica/containers.json >/dev/null && grep -E 'containerEngine[^a-z]+docker' /run/mica/containers.json >/dev/null ||
        fail 'GetContainers does not report the probe on docker'
    micad ctr list | grep -E '^probe +probe +probe +running' >/dev/null || fail 'micad ctr list does not report the running probe'
    : > "$PROBE_MARK"
    echo FILE_AB_CONTAINER_PASS
}

container_checks() {
    if [ "$INIT" = openrc ]; then
        # /proc/mounts rather than stat -f: busybox's stat names no cgroup2 filesystem type.
        grep -q '^[^ ]* /sys/fs/cgroup cgroup2 ' /proc/mounts || fail 'OpenRC did not mount the unified cgroup hierarchy'
    fi
    if [ "$ENGINE" = docker ]; then
        docker_checks
        return
    fi
    if [ -f "$PROBE_MARK" ]; then
        # Declared on an earlier boot of this DATA; micad starts every project's containers when it starts the
        # service.
        wait_phase probe running 120 || fail 'the declared container did not start at boot'
        echo FILE_AB_CONTAINER_BOOT_PASS
        return 0
    fi
    probe_image podman
    # Project probe, its one service's container named probe. PID 1 of a container gets no default signal
    # handling, so the probe traps TERM itself: a stop ends it at once instead of running out the engine's grace
    # into a SIGKILL. The Compose text is a JSON string; YAML's single quotes keep it free of double quotes.
    project=$(cat <<'PROJECT'
{"enabled":true,"projects":{"probe":"services:\n  probe:\n    image: localhost/mica-probe:1\n    container_name: probe\n    command: ['/bin/sh', '-c', 'trap ''exit 0'' TERM; while :; do /bin/busybox sleep 1; done']\n    restart: always\n    pids_limit: 64\n    mem_limit: 32m\n"}}
PROJECT
)
    bus SetSettings ss container "$project" >/dev/null || fail 'SetSettings container'
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
    bus StopContainer s probe/probe >/dev/null || fail 'StopContainer'
    wait_phase probe stopped 60 || fail 'StopContainer did not stop the container'
    restart_supervisor || fail 'restarting mica-containerd'
    sleep 5
    wait_phase probe stopped 30 || fail 'a stopped container did not stay stopped across a restart of mica-containerd'
    bus StartContainer s probe/probe >/dev/null || fail 'StartContainer'
    wait_phase probe running 60 || fail 'StartContainer did not start the container'
    bus GetContainers > /run/mica/containers.json || fail 'GetContainers'
    grep -F 'probe' /run/mica/containers.json >/dev/null && grep -F 'running' /run/mica/containers.json >/dev/null ||
        fail 'GetContainers does not agree with mica-containerd'
    mica-containerd ctl list | grep -E '^probe +probe +running +running' >/dev/null || fail 'mica-containerd ctl list does not report the running probe'
    : > "$PROBE_MARK"
    echo FILE_AB_CONTAINER_PASS
}
