#!/usr/bin/env bash
# Feed every example in tests/fixtures/quadlet-doc/containers.md (the executed copy of
# mica:docs/design/containers.md) to the Quadlet generator this
# image ships.
#
#   bash tests/gates/quadlet-doc-test.sh

# A document full of configuration examples rots silently: Quadlet gains a key,
# drops one, renames a section, and the examples go on looking correct to every
# reader, because nothing in a markdown file can fail. So the examples are
# extracted from the document and run through the real generator -- the arm64
# binary in mica-podman:out-arm64, under emulation, the one the device runs.

# The marker is an HTML comment, `<!-- quadlet: NAME -->`, immediately before
# the fenced block. Invisible when the document is rendered, unambiguous to
# parse, and it names the file the block is, because Quadlet's behaviour
# depends on the extension: a `.network` and a `.container` holding identical
# bytes generate different units.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
# The executed specimen of mica:docs/design/containers.md, kept beside the
# test because the documentation lives in micaoss/mica; a drift between the two
# is a diff to review, not a silent divergence.
DOC="${REPO_ROOT}/tests/fixtures/quadlet-doc/containers.md"
QUADLET="${MICA_QUADLET_BIN:-${REPO_ROOT}/_out/debs/arm64/mica-podman/quadlet}"

[ -f "${DOC}" ] || { echo "error: ${DOC} not found" >&2; exit 1; }
[ -f "${QUADLET}" ] || {
    echo "error: ${QUADLET} not found. This test runs the generator the image ships, not a description of it; 'make os-pool' extracts it from the pinned mica-podman archive" >&2
    exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
UNITS="${WORK}/units"
mkdir -p "${UNITS}"

# --- extract
# Every `<!-- quadlet: NAME -->` followed by a fenced block becomes NAME.
python3 - "${DOC}" "${UNITS}" <<'PY'
import io, re, sys
doc, out = sys.argv[1], sys.argv[2]
text = io.open(doc, encoding="utf-8").read()
pattern = re.compile(
    r"<!--\s*quadlet:\s*(?P<name>[A-Za-z0-9._-]+)\s*-->\s*\n```[a-z]*\n(?P<body>.*?)```",
    re.S,
)
names = []
for m in pattern.finditer(text):
    name = m.group("name")
    io.open(f"{out}/{name}", "w", encoding="utf-8").write(m.group("body"))
    names.append(name)
if not names:
    sys.stderr.write(
        "error: no `<!-- quadlet: NAME -->` blocks found in the document. "
        "Either the examples lost their markers or this extractor's pattern no "
        "longer matches them -- and an extractor that finds nothing makes every "
        "assertion below pass over an empty set.\n"
    )
    sys.exit(1)
print(" ".join(names))
PY
EXTRACTED="$(python3 - "${DOC}" <<'PY'
import io, re, sys
text = io.open(sys.argv[1], encoding="utf-8").read()
print(" ".join(re.findall(r"<!--\s*quadlet:\s*([A-Za-z0-9._-]+)\s*-->", text)))
PY
)"
count="$(printf '%s\n' ${EXTRACTED} | grep -c .)"
echo "extracted ${count} example(s): ${EXTRACTED}"

# The document's own claim about how many examples it carries. Without this a
# document that lost eight of nine examples would still pass, on the one left.
#
# The floor moves with the document. It was five when the guide covered
# interconnection, dependency and persistence; PLAN-051 added a health-checked
# unit, a hardened one carrying a dedicated user, a named device node and the
# four resource controllers, and a digest-pinned private image -- three files
# whose loss the old floor would not have noticed, because six examples is
# still more than five.
if [ "${count}" -lt 9 ]; then
    echo "error: only ${count} examples were extracted. mica:docs/design/containers.md is the integrator's guide to interconnection, dependency, persistence, health, identity, hardware and resource ceilings, and it cannot demonstrate those in fewer than nine files" >&2
    exit 1
fi

# --- run the real generator
# In a container, because the binary is aarch64 and this host is not. Same
# builder selection as mica-podman:build.sh: buildx's docker-container driver
# bundles QEMU, so no host binfmt registration is needed.
BUILDER_ARGS=()
if [ -z "${BUILDX_BUILDER:-}" ] && ! docker buildx inspect 2>/dev/null | grep -c 'linux/arm64' >/dev/null; then
    docker buildx inspect mica-arm64 >/dev/null 2>&1 ||
        docker buildx create --name mica-arm64 --driver docker-container >/dev/null
    BUILDER_ARGS=(--builder mica-arm64)
fi

cp "${QUADLET}" "${WORK}/quadlet"

# The base, from locks/mica-build-env.lock, and by the --build-arg form rather
# than by interpolating a reference into the heredoc. That is forced by the
# heredoc's own body: the RUN below relies on ${out} reaching the Dockerfile
# unexpanded, so the delimiter has to stay quoted and nothing in here expands
# on the host side. `ARG` before `FROM` is the shape every Dockerfile in the
# tree uses -- declared with no default, so a build that forgets the argument
# is refused rather than falling back to something.

# It matters for this test specifically because what runs in the container is
# the quadlet binary out of mica-podman:out-arm64, generating systemd units that
# are then asserted against mica:docs/design/containers.md. It is dynamically
# linked, so the base decides the glibc it loads against, and a base that
# drifted would surface as a documentation test failing about unit content.
mapfile -t FROM_ARGS < <(bash "${REPO_ROOT}/tools/from.sh" \
    MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim)
# mapfile cannot fail, so its status says nothing about the process inside the
# substitution; an empty array is what a refusal looks like from here, and an
# empty array would build with no --build-arg and no FROM at all. Same check,
# and for the same reason, as mica-podman:build.sh's.
[ "${#FROM_ARGS[@]}" -eq 2 ] || {
    echo "error: tools/from.sh did not yield the base image (see its message above); this build would have run with an empty FROM" >&2
    exit 1
}

cat >"${WORK}/Dockerfile" <<'DOCKERFILE'
ARG MICA_IMAGE_DEBIAN_TRIXIE
FROM ${MICA_IMAGE_DEBIAN_TRIXIE} AS run
COPY quadlet /usr/libexec/podman/quadlet
COPY units/ /etc/containers/systemd/
RUN set -eu; \
    out="$(/usr/libexec/podman/quadlet --dryrun 2>&1)"; \
    printf '%s\n' "${out}" >/generated.txt; \
    printf '%s\n' "${out}"
FROM scratch AS artifact
COPY --from=run /generated.txt /
DOCKERFILE

docker buildx build "${BUILDER_ARGS[@]}" \
    "${FROM_ARGS[@]}" \
    --platform linux/arm64 \
    -f "${WORK}/Dockerfile" \
    -o "${WORK}/out" \
    "${WORK}" >"${WORK}/build.log" 2>&1 || {
    echo "error: the Quadlet generator failed on the document's examples:" >&2
    tail -40 "${WORK}/build.log" >&2
    exit 1
}
GENERATED="${WORK}/out/generated.txt"

# --- assert
pass=0
fail=0
check() {
    if eval "$2"; then
        printf '  PASS: %s\n' "$1"; pass=$((pass + 1))
    else
        printf '  FAIL: %s\n' "$1"; fail=$((fail + 1))
    fi
}

# The generator prints this when it parsed nothing. Asserted FIRST, because
# every other assertion below is about the content of its output, and an empty
# output would make a grep for an absent string look like a passing negative.
check "the generator parsed the document's files rather than reporting none" \
    "! grep -q 'No files parsed from' '${GENERATED}'"

for name in ${EXTRACTED}; do
    stem="${name%.*}"
    ext="${name##*.}"
    case "${ext}" in
    container) unit="${stem}.service" ;;
    volume)    unit="${stem}-volume.service" ;;
    network)   unit="${stem}-network.service" ;;
    *)         echo "  FAIL: ${name} has an extension this test does not map to a unit name"; fail=$((fail + 1)); continue ;;
    esac
    check "${name} generates ${unit}" \
        "grep -q '${unit}' '${GENERATED}'"
done

# The claims the document makes IN PROSE, checked against what the generator
# actually produced. These are the sentences an integrator acts on.
check "web.container's ExecStart invokes the podman this image installs" \
    "grep -qE 'ExecStart=/usr/bin/podman' '${GENERATED}'"
check "api.service is ordered after db.service, as section 5 says" \
    "grep -qE 'After=.*db\\.service' '${GENERATED}'"
# `grep -q db` was the first version of this and matched `db.service` -- it
# would have passed with NetworkAlias silently dropped, which is precisely the
# failure section 5 tells the integrator cannot happen.
check "section 5's promise that api reaches db BY NAME reaches podman as --network-alias" \
    "grep -qE -- '--network-alias db' '${GENERATED}'"
check "db.container's volume dependency is wired without the document saying so" \
    "grep -qE 'Requires=pgdata-volume\\.service' '${GENERATED}'"
check "joining a .network wires the network unit dependency too" \
    "grep -qE 'Requires=app-network\\.service' '${GENERATED}'"

# Section 7: health. `Notify=healthy` is the sentence "systemd does not consider
# gateway.service started until the check has passed once", and it is two
# generated facts, not one -- the unit has to become Type=notify AND podman has
# to be told which notification to wait for. Either alone is a unit that starts
# when the container process exists, which is the failure section 5 describes.
check "section 7's Notify=healthy makes the unit wait: Type=notify" \
    "grep -qE '^Type=notify' '${GENERATED}'"
check "section 7's Notify=healthy makes the unit wait: --sdnotify=healthy" \
    "grep -qE -- '--sdnotify=healthy' '${GENERATED}'"
check "the health check itself reaches podman, with its timeout" \
    "grep -qE -- '--health-cmd .*--health-timeout 5s' '${GENERATED}'"
# Without this one, an unhealthy container is marked and left running -- the
# document says so, and says HealthOnFailure is what closes it.
check "section 7's HealthOnFailure turns unhealthy into an exit Restart= can see" \
    "grep -qE -- '--health-on-failure kill' '${GENERATED}'"
check "LogDriver=journald in the unit reaches podman rather than relying on containers.conf" \
    "grep -qE -- '--log-driver journald' '${GENERATED}'"

# Section 8: identity, hardware, ceilings. The uid assertion is exact for the
# reason the document gives: Quadlet CONCATENATES User= and Group=, so the
# defect this catches is a third field appended silently.
check "section 8's dedicated user reaches podman as exactly uid:gid" \
    "grep -qE -- '--user 10001:10001( |\$)' '${GENERATED}'"
check "section 8's capability drop reaches podman" \
    "grep -qE -- '--cap-drop all' '${GENERATED}'"
check "the named device node reaches podman as --device" \
    "grep -qE -- '--device /dev/ttyS3:/dev/ttyS3:rw' '${GENERATED}'"
check "ConditionPathExists survives into the unit, so an absent node skips rather than fails" \
    "grep -qE '^ConditionPathExists=/dev/ttyS3' '${GENERATED}'"
# The ceilings are only ceilings if the container is inside the unit's cgroup.
# --cgroups=split is what puts it there; without it the four keys below are
# systemd limiting the podman client and nothing else.
check "the container shares the unit's cgroup, which is what makes the ceilings bind it" \
    "grep -qE -- '--cgroups=split' '${GENERATED}'"
for key in 'CPUQuota=40%' 'MemoryHigh=192M' 'MemoryMax=256M' 'TasksMax=128' \
    'IOReadBandwidthMax=/dev/mmcblk0 8M' 'IOWriteBandwidthMax=/dev/mmcblk0 4M'; do
    check "section 8's ${key} reaches the generated unit" \
        "grep -qF '${key}' '${GENERATED}'"
done

# Section 9: the digest-pinned private image. --pull never is the whole claim
# that "the unit runs the image already on the device, or it does not start";
# the digest is the claim that says which image that is.
check "section 9's Pull=never reaches podman as --pull never" \
    "grep -qE -- '--pull never' '${GENERATED}'"
check "section 9's image is pinned by digest, not by a tag someone can move" \
    "grep -qE 'registry\\.example\\.com/acme/app@sha256:[0-9a-f]{64}' '${GENERATED}'"
# REGISTRY_AUTH_FILE is read by the podman PROCESS. The document warns that
# [Container]'s Environment= would put it inside the container instead, where
# nothing reads it -- so this asserts it landed in [Service], as a unit
# Environment= line rather than as a --env argument.
check "section 9's credential path is the podman process's environment, not the container's" \
    "grep -qE '^Environment=REGISTRY_AUTH_FILE=/var/lib/mica/containers-auth\\.json' '${GENERATED}'"
check "and it is NOT handed to the container as --env" \
    "! grep -qE -- '--env REGISTRY_AUTH_FILE' '${GENERATED}'"

echo
if [ "${fail}" -eq 0 ]; then
    echo "RESULT: PASS (${pass}/${pass} checks)"
else
    echo "RESULT: FAIL ($((pass)) passed, ${fail} failed of $((pass + fail)))"
    echo "--- generator output ---"
    cat "${GENERATED}"
    exit 1
fi
