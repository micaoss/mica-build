# Containers on Mica OS

**Mica OS does not orchestrate containers.** It ships a container engine, turns
`.container` files into systemd units, and gives you one switch to turn the
whole capability off. What runs, in what order, how containers reach each
other and what survives an update are yours to describe — in systemd's terms,
not in a mica-specific format.

This document is the integrator's guide to doing that. Every example below is
extracted by `tests/quadlet-doc-test.sh` and fed to the Quadlet generator this
image actually ships, so an example that stopped working fails the test suite
rather than sitting here looking correct.

---

## 1. What is on the device

| Binary | Path | What it is |
|---|---|---|
| `podman` | `/usr/bin/podman` | the engine. Daemonless — `podman run` forks `conmon`, which execs `crun` |
| `crun` | `/usr/bin/crun` | the OCI runtime |
| `conmon` | `/usr/libexec/podman/conmon` | per-container monitor |
| `quadlet` | `/usr/libexec/podman/quadlet` | the systemd generator |
| `netavark` | `/usr/libexec/podman/netavark` | networking |
| `aardvark-dns` | `/usr/libexec/podman/aardvark-dns` | container-to-container name resolution |
| `catatonit` | `/usr/libexec/podman/catatonit` | container init, for `--init` |
| `docker` | `/usr/bin/docker` | a symlink to `podman`, so the docker command line works |

Versions are pinned in `mica-podman:locks/upstream.lock` and built from upstream source,
not taken from Debian. `podman --version` on the device is the authority.

The `docker` name is a symlink and nothing else. `docker run ...` is
`podman run ...` with the same flags, the same output and the same behaviour;
podman reads `argv[0]` only to name itself, so `docker --version` answers
`docker version 5.8.6` and the usage text says `docker`, and no mode is selected
by the name.

What the name does **not** bring is anything Docker keeps behind its socket:
there is no daemon, no `/run/docker.sock` and no REST API here, so a client that
dials the socket rather than running the binary is no better off. `docker
compose` fails the way `podman compose` does — `Error: looking up compose
provider failed`, because podman shells out to a compose provider and neither
`docker-compose` nor `podman-compose` is on the device. Compose files are not
this image's way of describing a set of containers; section 3 is.

There is **no `podman.socket` and no `podman.service`**. The REST API is not
built into this image, so there is no engine socket to secure — and nothing to
connect to if you were expecting one.

## 2. The switch

`container.enabled` in the management settings tree, `false` by default. It is
read and written through APID, which calls micad's validated `GetSettings` and
`SetSettings` methods. micad exports no system Item1 projection, and
`mica-mqttd` admits only application packages enrolled by exact direct
`com.mica.<class>[.<suffix>]` name, with `com.mica.micad` structurally forbidden,
so container enablement has no MQTT read or write path. `mqtt.enabled` is kept
on the same management side for the same reason: a system lifecycle switch is
not application data.

Turn it on from the Services page in the built-in SPA at `/_ui/`, or through the
same API route. Automation uses a bearer token; a signed-in browser session is
also accepted and its mutations carry the session's CSRF header:

```
curl -X PUT -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  --data 'true' https://<device>/api/v1/settings/container.enabled
```

False means **nothing runs**: `/etc/containers/systemd` is not mounted, so it
is the empty directory inside the read-only root, the generator finds no files,
and no container unit exists.

> **Containers on this device run as root.** Rootless mode is not built, so a
> container is not confined to an unprivileged user. Anything that can write a
> `.container` file into the Quadlet directory can run code with root's
> capabilities on this appliance. That is what the switch gates, and why it is
> off by default.

## 3. Where files go

`/etc/containers/systemd` — a bind of `/mnt/data/state/quadlet` in protected DATA
state, so what you put there survives a reboot **and an A/B update**.

That path is not a choice; it is where Quadlet looks. Its search list, printed
by `quadlet --dryrun` itself:

```
/run/containers/systemd  /etc/containers/systemd  /usr/share/containers/systemd
```

After adding or changing a file:

```
systemctl daemon-reload      # re-runs the generator
systemctl start web.service  # or reboot
```

Generators run at boot and at every `daemon-reload`, and **only then**. A file
copied into place changes nothing until one of those happens — the file is
there, the unit does not exist, and nothing reports a problem.

## 4. One container

<!-- quadlet: web.container -->
```ini
[Unit]
Description=Web frontend

[Container]
Image=docker.io/library/nginx:1.27
PublishPort=8080:80

[Service]
Restart=always

[Install]
WantedBy=multi-user.target
```

`web.container` becomes `web.service`. The `[Install]` section is what makes it
start at boot; without it the unit is generated and simply never runs.

**Use a tag, or better a digest.** `nginx` alone resolves through
`unqualified-search-registries` in `/etc/containers/registries.conf` and
`nginx:latest` means a different image next month. On a device that boots
unattended, a fully-qualified reference with a digest is the only form that
means the same thing at every boot:

```
Image=docker.io/library/nginx@sha256:...
```

## 5. Two containers that talk to each other

Put them on a network. Quadlet turns a `.network` file into a unit the same way.

<!-- quadlet: app.network -->
```ini
[Network]
NetworkName=app
Subnet=10.89.0.0/24
```

<!-- quadlet: db.container -->
```ini
[Unit]
Description=Database

[Container]
Image=docker.io/library/postgres:17
Network=app.network
NetworkAlias=db
Environment=POSTGRES_PASSWORD_FILE=/run/secrets/pg
Volume=pgdata.volume:/var/lib/postgresql/data

[Install]
WantedBy=multi-user.target
```

<!-- quadlet: api.container -->
```ini
[Unit]
Description=API
Requires=db.service
After=db.service

[Container]
Image=docker.io/library/alpine:3.21
Network=app.network
Exec=sh -c "until nc -z db 5432; do sleep 1; done; exec /app/server"

[Install]
WantedBy=multi-user.target
```

**`api` reaches `db` by the name `db`.** That is `aardvark-dns`, which serves
names only to containers on the same network — a container on the default
network cannot resolve `db`, and neither can the host.

### `After=` is not "wait until it is ready"

`Requires=db.service` and `After=db.service` order the *units*: systemd starts
`db.service`, waits for it to report started, and then starts `api.service`.
For a container, "started" means the container process was created. Postgres
inside it has not finished initialising.

This is the single most common way a two-container setup fails, and it fails
intermittently — fast enough on a warm boot, too slow after a power cut. The
`until nc -z` loop above is in the example for that reason: **the readiness
check belongs to the client**, because only the client knows what ready means.
`Notify=healthy` plus a `HealthCmd` is the other way, and it moves the same
knowledge into the server's unit rather than removing the need for it.

## 6. Persistence

<!-- quadlet: pgdata.volume -->
```ini
[Volume]
VolumeName=pgdata
```

A named volume lives under the graph root, which on this device is
`/mica/containers/storage`. The `/mica/containers` mount binds DATA/containers,
with independent project 102 accounting and no byte/inode limit. Images, writable
layers, named volumes and Netavark definitions stay inside this namespace;
`/mica/containers/tmp` holds image download temporary files in the same namespace;
`/run/containers/storage` holds volatile engine state. Container storage does
not consume the `/var` budget. The Quadlet source mount requires container
storage before exposing application units, preventing startup on an unmounted
container backing directory. [Storage policy](storage.md#capacity) defines the
shared capacity and the bounded variable-data project.

Two consequences worth stating plainly:

- **Container, system and user data are unlimited.** They share DATA capacity
  with independent project accounting; filling DATA can affect other writers.
- **`/var` has its own bounded budget.** Container storage stays in
  `/mica/containers` and does not consume that quota. See [storage](storage.md).

For a bind mount of a host path, use one under `/srv`:

<!-- quadlet: logger.container -->
```ini
[Unit]
Description=Log collector

[Container]
Image=docker.io/library/busybox:1.37
Volume=/srv/appdata/logs:/logs:Z
Exec=tail -F /logs/app.log

[Install]
WantedBy=multi-user.target
```

## 7. Logs and health

`log_driver = "journald"` is set in `/etc/containers/containers.conf`, so
container output goes to the journal:

```
journalctl -u web.service -f
```

The journal is volatile under `/run/log/journal`. Export diagnostics needed
across reboot; container stdout is not a permanent audit store.

Writing `LogDriver=journald` in the unit says the same thing where the reader
of the unit can see it, and pins it against a later edit to `containers.conf`.

Section 5 ended on the readiness problem and named the other answer to it: a
health check the *server* carries, so that its clients do not each have to
implement one. This is that answer.

<!-- quadlet: gateway.container -->
```ini
[Unit]
Description=Field gateway

[Container]
Image=docker.io/library/caddy:2.10
LogDriver=journald
Notify=healthy
HealthCmd=/usr/local/bin/healthcheck
HealthInterval=30s
HealthTimeout=5s
HealthStartPeriod=20s
HealthRetries=3
HealthOnFailure=kill

[Service]
Restart=always

[Install]
WantedBy=multi-user.target
```

`Notify=healthy` is the key that changes what "started" means. The generated
unit is `Type=notify` and podman is run with `--sdnotify=healthy`, so systemd
does not consider `gateway.service` started until the check has passed once. A
unit declaring `After=gateway.service` then genuinely waits for the
application, which is exactly what section 5 said `After=` on its own does not
give you.

The other keys are the check's shape, and each of them decides something on an
appliance nobody is watching: `HealthStartPeriod=` is how long a slow first
start is forgiven before failures count, `HealthInterval=` and `HealthRetries=`
together are how long a wedged application takes to be noticed, and
`HealthTimeout=` bounds a check that hangs instead of failing. A check with no
timeout, on a device with a stuck disk, is a check that never reports.

`HealthOnFailure=kill` is the one that connects the check to the restart:
without it, an unhealthy container is *marked* unhealthy and goes on running,
because `Restart=always` restarts a unit whose container exited and an
unhealthy container has not exited. With it, podman kills the container, the
unit fails, and `Restart=always` starts it again.

## 8. A dedicated user, a named device, and ceilings

What a field workload needs beyond an image is unit keys, and there is no
mica-specific layer over any of them.

<!-- quadlet: sensor.container -->
```ini
[Unit]
Description=Serial sensor reader
ConditionPathExists=/dev/ttyS3

[Container]
Image=docker.io/library/python:3.13-slim
User=10001
Group=10001
AddDevice=/dev/ttyS3:/dev/ttyS3:rw
NoNewPrivileges=true
DropCapability=ALL
ReadOnly=true
Volume=/srv/sensor:/var/lib/sensor:Z

[Service]
Restart=always
CPUQuota=40%
MemoryHigh=192M
MemoryMax=256M
TasksMax=128
IOReadBandwidthMax=/dev/mmcblk0 8M
IOWriteBandwidthMax=/dev/mmcblk0 4M

[Install]
WantedBy=multi-user.target
```

### The user

`User=` and `Group=` become podman's `--user 10001:10001`. One value each:
Quadlet concatenates the two keys, so `User=10001:10001` written together with
`Group=10001` generates `--user 10001:10001:10001` and reports nothing.

That uid is inside the container and, because this engine is rootful and this
unit asks for no user namespace, the same uid on the host. It reduces what the
*application* can reach. It does not turn the container into a boundary:
podman still runs as root, and section 2's warning is unchanged — whoever
wrote this file chose the uid, and could as easily have omitted it.

`NoNewPrivileges=true` and `DropCapability=ALL` are what make the reduction
stick past an `exec`, and `ReadOnly=true` leaves the image's own filesystem
immutable so the single writable path is the one mounted at `/var/lib/sensor`.

### The device

`AddDevice=` names one node and becomes `--device /dev/ttyS3:/dev/ttyS3:rw`.
It is a name, not a class: there is no pattern form, and no way to say "every
serial port". A node that is absent when the container starts is a start
failure rather than an empty grant — which is what `ConditionPathExists=` in
`[Unit]` is for. On a board where the device is optional, the condition skips
the unit instead of failing it, and `systemctl status` says which of the two
happened.

Device names are board facts, and `/dev/ttyS3` here is an example. Take the
node from the board's own dossier — [../boards/cx3576.md](../boards/cx3576.md)
is the worked one — and
prefer a stable udev name over a numbered one wherever the board provides one.

### The ceilings

`[Service]` keys reach the generated unit untouched, and the generated `podman
run` carries `--cgroups=split`, which puts the container's cgroup inside the
unit's own. These are therefore kernel controllers over the container, not
advice to it:

| Key | What the kernel does with it |
|---|---|
| `CPUQuota=40%` | `cpu.max` — 40% of one core, throttled |
| `MemoryHigh=192M` | `memory.high` — reclaim pressure, the warning shot |
| `MemoryMax=256M` | `memory.max` — the OOM killer, not a warning |
| `TasksMax=128` | `pids.max` — the bound on a fork bomb |
| `IOReadBandwidthMax=`, `IOWriteBandwidthMax=` | `io.max`, per block device |

`MemoryHigh=` below `MemoryMax=` is the pair worth setting together on a
device whose job is to keep running: the first throttles an application that
is growing, the second is what happens when throttling did not help.

The two `IO*` keys take a **device path**, and a path that does not exist on
the board is a line systemd logs and then skips — the unit starts, unlimited,
and the only evidence is in the journal. `/dev/mmcblk0` is the eMMC on the
cx3576; check the board before copying it.

**Nothing requires any of this.** A `.container` file with no `[Service]`
section at all is accepted, generates a unit with no ceilings, and Mica OS adds
none. There is no admission step between a file appearing in the Quadlet
directory and a unit that can take the device down. Ceilings here are the
integrator's discipline, not a platform guarantee, and this document is the
only thing asking for them.

## 9. Images: digests, credentials, rollback and data

**Mica OS does not update your containers.** There is no `podman-auto-update.timer`
in this image; that unit is not built. Pulling a new image, restarting the unit,
and deciding when that is safe are the integrator's, and the reason is the same
one that makes Mica OS's own updates A/B and signed: an update that can happen
without a decision is an update that can happen at the wrong moment.

`/etc/containers/policy.json` ships as:

```json
{ "default": [{ "type": "insecureAcceptAnything" }] }
```

**Read that literally: image signatures are not verified.** What protects a
pull is TLS to the registry and, if you use one, a digest reference. This is
upstream's default and Debian's, and Mica OS keeps it because Mica OS has no way to
distribute your signing keys — but it is a decision, not an oversight.

Tightening it is a **build-time** act rather than a device edit. `policy.json`
and `registries.conf` are inside the verity-sealed root, so a `signedBy` policy
(`containers-policy.json(5)`) and the key it names arrive in a new image —
through a `.deb` producer or the rootfs overlay — and reach the fleet in a
signed A/B update. Only `/etc/containers/systemd` is writable on a running
device, and it holds unit files, not policy.

### Pin by digest, and start from what you verified

<!-- quadlet: private.container -->
```ini
[Unit]
Description=Vendor application

[Container]
Image=registry.example.com/acme/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
Pull=never

[Service]
Environment=REGISTRY_AUTH_FILE=/var/lib/mica/containers-auth.json

[Install]
WantedBy=multi-user.target
```

Two keys, each closing a different hole.

`Image=...@sha256:...` is content rather than a name. A tag is a pointer
somebody else can move, so `nginx:latest` and even `nginx:1.27` are promises
about a label; a pull by digest is the only form where what arrives is checked
against what was asked for. The digest above is a placeholder — take yours from
`podman image inspect --format '{{.Digest}}'` or `podman images --digests`,
against the image you actually qualified.

`Pull=never` becomes `--pull never`: the unit runs the image already on the
device, or it does not start. On an unattended appliance that converts "the
registry was unreachable at 03:00" and "somebody moved the tag" from a silent
change in what runs into a unit that failed and said why. Load the image
first, deliberately:

```
podman pull registry.example.com/acme/app@sha256:<digest>
podman images --digests
```

An image moved as a file — `podman save` here, `podman load` on the device —
arrives with no signature, and whether it keeps its registry digest depends on
the transport. `podman images --digests` is how you find out, and `Pull=never`
makes a reference that does not match a refusal to start rather than a pull
nobody asked for.

### Registry credentials

`podman login` writes a credentials file. Say where, because the default for
root is under `/run` — a tmpfs, gone at the next boot:

```
podman login --authfile /var/lib/mica/containers-auth.json registry.example.com
```

`/var/lib/mica` is a bind of DATA/state, so the file survives a reboot and an A/B
update. The unit points at it with `Environment=` in `[Service]`, which is the
environment of the `podman` process and not of the container:
`REGISTRY_AUTH_FILE` is read by podman itself. `[Container]`'s own
`Environment=` would put the variable inside the container, where nothing
reads it — the two keys have the same name and different meanings.

**This is not a secret store.** The file holds the registry username and
password base64-encoded — encoded, not encrypted — readable by root, which is
what everything on this path already runs as. Mica OS does not create it, rotate
it, back it up, or know that it exists, and nothing removes it when the unit
that used it goes away. If a credential must not sit at rest on the device,
the answer is a short-lived one installed with each update, not a different
file mode.

### Rolling an application back

There is no rollback command, because there is no update command. The
mechanism is the digest:

1. Record the digest running today. The device will not remember it for you.
2. `podman pull` the new digest, and edit `Image=` to it.
3. `systemctl daemon-reload && systemctl restart app.service`.
4. To go back: edit `Image=` to the previous digest and repeat step 3.

Step 4 works **only while the previous image is still on the device.** The
generated `ExecStart` carries `--rm`, which removes the container and not the
image — but `podman image prune` and `podman system prune` remove the
now-untagged previous image, and after that a rollback needs the registry
again. On a device that may be offline when it goes wrong, keeping the
previous image *is* the rollback plan.

### Data does not roll back with the image

Rolling `Image=` back to the previous digest restores the code. It does not
restore the volume. If the new version migrated its schema on first start —
and most do, silently, because that is what an application does when it finds
an old database — then the previous version is now pointed at data it does not
understand, and the failure arrives after the rollback appeared to work.

That contract is the integrator's to make and to test, and Mica OS holds no
opinion about it. What Mica OS gives you is the two halves being separable: the
image is content-addressed and replaceable, and the volume is on DATA under
`/mica/containers/storage`, where `podman volume export` before an update is a
backup you can restore afterwards. The system update path has a health gate
and an automatic A/B rollback ([../user/update-rollback.md](../user/update-rollback.md));
the container path has neither, and nothing on this device watches an
application to decide whether its last update went well.

## 10. What to check when something does not start

| Symptom | Where to look |
|---|---|
| the unit does not exist | `systemctl daemon-reload`; then `/usr/libexec/podman/quadlet --dryrun` prints parse errors |
| unit exists, never started | no `[Install]` section, so nothing wants it |
| `unable to execute nft` | should not happen — `nftables` is in the image; report it |
| container starts, then exits 0 | the `Exec=` finished. A container is not a service because it is in a unit |
| name does not resolve | the two containers are not on the same `.network` |
| storage full | `podman system df`; check `/srv` against the UI bundles sharing it |

## 11. What Mica OS will not do for you

Restated because it is the whole shape of this document: no compose file, no
dependency resolution beyond systemd's, no health-based restart orchestration,
no image update policy, no secret store. If you need those, they are ordinary
systemd and podman features and this document has shown where each attaches.

The reason is not minimalism. An orchestrator is a second thing that decides
when your application runs, and Mica OS already has one — systemd — that the rest
of the device is built on. Two would have to agree.
