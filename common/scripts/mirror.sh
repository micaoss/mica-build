#!/usr/bin/env bash
# The fetch-time mirror. mica-res keeps a copy of every third-party object this
# repository pins, addressed by content, and this library is the only place
# that knows its URL shape. Sourced by fetch-archive.sh and fetch-source.sh;
# it is not a program.
#
#   MICA_MIRROR=https://res.micaos.dev   the base. Unset or empty: no hook at all.
#
# Three rules this file exists to keep.
#
# A LOCK URL IS NEVER REWRITTEN. The pinned URL is an input of the component
# (tools/inputs.sh reads locks/upstream.lock), so rewriting one would move the
# inputs hash and rebuild and republish the component. The mirror is consulted
# at fetch time, in the builder, and nowhere else.
#
# THE MIRROR IS A SOURCE, NEVER A TRUST ANCHOR. What proves an object is the
# right one is the sha256 of the lock row, or -- for a git pack -- git's own
# object hashing plus the rev-parse assertion in fetch-source.sh. Bytes that do
# not match are a refusal, never a reason to fall back: falling back would turn
# a corrupted mirror into a silent slow path nobody notices.
#
# NOT REACHABLE IS NOT AN ERROR. 404, a connection timeout, a DNS failure and a
# TLS failure all mean "not mirrored", and the pinned URL is used instead. The
# mirror answers from CI and does not answer from every network, so no build may
# wait on it: the connect timeout is three seconds and there is no retry.
#
# WHAT THIS DEPENDS ON, AND WHAT ITS LOSS LOOKS LIKE -- WRITTEN HERE BECAUSE
# NEITHER SIDE CAN SEE BOTH ENDS. Two HTTP routes of mica-res, probed
# 2026-09-20 and each answering through one redirect to dl.res.micaos.dev:
#
#   blob/<aa>/<sha256>                      fetch-archive.sh, a `source` row
#   upstream/git/<name>/<commit>.json       fetch-source.sh, a `git` row, and
#                                           its ordered .pack.NN chunks
#
# THEY ARE ROUTES, NOT OBJECTS. `/blob/` resolves a digest against mica-res's
# catalogue and redirects; the user deleted the stored `blob/` prefix from the
# bucket on 2026-09-20 and both routes still answer, which is why "the v1
# layout is retired" is true of the objects and false of the paths this file
# asks for. MICA_MIRROR is a repository variable here, so this is a live
# dependency of every CI build and not a local convenience.
#
# IF A ROUTE IS EVER REMOVED, NOTHING HERE TURNS RED. Every miss falls back to
# the vendor, the sha256 still proves the bytes, and the build succeeds --
# slower, and with the offline bundle quietly losing a source. The only signal
# is one line per object naming the status ("not mirrored (404), fetching
# <url>"), which is a line nobody reads rather than no line at all. mica-res
# defends its half: its changelog says that deleting the `/blob/` route breaks
# this hook, and its sync.yml probes that exact path deliberately. This comment
# is the other half, because a constraint only its holder can verify decays
# silently, and neither repository can hold both ends.

MICA_MIRROR_CONNECT_TIMEOUT="${MICA_MIRROR_CONNECT_TIMEOUT:-3}"

mirror_base() { # the base without its trailing slash, empty when the hook is off
    local base="${MICA_MIRROR:-}"
    printf '%s' "${base%/}"
}

# Set by every mirror_get: `curl <exit>, <http code> <redirects> <final url>`,
# and the reason a miss is reported with. A mirror that answers a path with a
# redirect, a 404 or nothing at all is the same decision here -- fall back --
# but they are not the same fact, and a build log that only says "not mirrored"
# cannot tell them apart. That is how a mirror can stop answering for two days
# with every run green (2026-09-17: 11 of 11 mirrored; 2026-09-19: 0 of 11).
MIRROR_STATUS=""
# The number of redirects the last mirror_get followed, so a build log says
# whether the mirror answered directly or sent the fetch to the download host.
MIRROR_REDIRECTS=0

mirror_get() { # <path> <dest>: 0 and the bytes are in <dest>, 1 and it is not mirrored
    local path="$1" dest="$2" base out rc=0
    base="$(mirror_base)"
    MIRROR_STATUS=""
    MIRROR_REDIRECTS=0
    [ -n "${base}" ] || return 1
    # -L, for BOTH halves of the contract: the mirror may answer a readable
    # path or a digest lookup with a redirect to the download host, and a
    # lookup that did not follow it would read as a miss while the URL still
    # looked correct.
    # --speed-limit/--speed-time rather than --max-time: the largest mirrored
    # object is 345 MiB, so a deadline would refuse a slow network while a
    # stalled transfer is what must be given up on.
    out="$(curl -fsSL --connect-timeout "${MICA_MIRROR_CONNECT_TIMEOUT}" \
        --speed-limit 1024 --speed-time 20 --retry 0 \
        -w '%{http_code} %{num_redirects} %{url_effective}' \
        -o "${dest}" "${base}/${path}" 2>/dev/null)" || rc=$?
    # shellcheck disable=SC2086  -- the three write-out fields, none of them empty
    set -- ${out}
    MIRROR_REDIRECTS="${2:-0}"
    MIRROR_STATUS="curl ${rc}, HTTP ${1:-000}, ${MIRROR_REDIRECTS} redirect(s), ${3:-${base}/${path}}"
    [ "${rc}" = 0 ] || { rm -f "${dest}"; return 1; }
    return 0
}

mirror_sha256() { # <file>
    sha256sum "$1" | cut -d' ' -f1
}
