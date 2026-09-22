#!/usr/bin/env bash
# Publishing to an OCI registry with the Distribution API: curl, jq and sha256sum.
# Sourced by tools/release.sh; src/cli.ts oci remains the reader of pinned inputs.
#
#   MICA_REGISTRY               <host>[:port]/<owner>, default ghcr.io/micaoss
#   MICA_REGISTRY_PLAIN_HTTP=1  a local test registry (host localhost, 127.0.0.1 or a container name)
#   MICA_REGISTRY_USER, MICA_REGISTRY_TOKEN   the push credential; never printed
#
#   registry_load                             -> REGISTRY_HOST, REGISTRY_OWNER, REGISTRY_URL
#   registry_publish <repo> <tag> <artifact-type> <layers.tsv>
#       uploads the layers and the manifest under <tag>, unless the tag already holds that
#       manifest; a tag holding another digest is refused, never re-pointed; prints the digest
#       layers.tsv: <file> TAB <media type> TAB <annotations JSON object, title included>
#   registry_public_manifest <repo> <digest> <out>   an anonymous read of the manifest -> HTTP status
#   registry_public_blob <repo> <digest>             an anonymous HEAD of the blob -> HTTP status
#
# Authentication is the registry's token challenge: a request without a bearer
# gets a 401 naming the realm, and the scope is asked for with the credential
# (or anonymously for a read). A registry that never challenges is used as it is.
[ -n "${BASH_VERSION:-}" ] || { echo "registry.sh: bash only" >&2; exit 1; }

REGISTRY_EMPTY_CONFIG=sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
REGISTRY_MANIFEST_TYPE=application/vnd.oci.image.manifest.v1+json

registry_load() {
    local registry="${MICA_REGISTRY:-ghcr.io/micaoss}"
    [[ "${registry}" =~ ^([A-Za-z0-9.-]+(:[0-9]+)?)/([a-z0-9][a-z0-9-]*)$ ]] || {
        echo "error: MICA_REGISTRY='${registry}' is not <host>[:port]/<owner>" >&2; return 1; }
    REGISTRY_HOST="${BASH_REMATCH[1]}"
    REGISTRY_OWNER="${BASH_REMATCH[3]}"
    if [ "${MICA_REGISTRY_PLAIN_HTTP:-0}" = 1 ]; then
        [[ "${REGISTRY_HOST}" =~ ^(localhost|127\.0\.0\.1|[a-z0-9-]+)(:[0-9]+)?$ ]] ||
            { echo "error: MICA_REGISTRY_PLAIN_HTTP=1 is for a local test registry, not ${REGISTRY_HOST}" >&2; return 1; }
        REGISTRY_URL="http://${REGISTRY_HOST}"
    else
        REGISTRY_URL="https://${REGISTRY_HOST}"
    fi
}

# <repo> <actions> <anonymous 0|1> -> "200 <bearer>" (empty bearer: no challenge) or "<status> "
registry_bearer() {
    local repo="$1" actions="$2" anonymous="$3" challenge realm service out code token cred=()
    challenge="$(curl -sS --max-time 60 -o /dev/null -D - "${REGISTRY_URL}/v2/${REGISTRY_OWNER}/${repo}/tags/list" 2>/dev/null | tr -d '\r' | grep -i '^www-authenticate: bearer' || true)"
    [ -n "${challenge}" ] || { printf '200 \n'; return 0; }
    realm="$(printf '%s' "${challenge}" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
    service="$(printf '%s' "${challenge}" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
    [ -n "${realm}" ] || { printf '000 \n'; return 0; }
    [ "${anonymous}" = 1 ] || [ -z "${MICA_REGISTRY_TOKEN:-}" ] || cred=(-u "${MICA_REGISTRY_USER:-}:${MICA_REGISTRY_TOKEN}")
    out="$(mktemp)"
    code="$(curl -sS --max-time 60 -o "${out}" -w '%{http_code}' "${cred[@]}" --get --data-urlencode "service=${service}" \
        --data-urlencode "scope=repository:${REGISTRY_OWNER}/${repo}:${actions}" "${realm}" 2>/dev/null || echo 000)"
    token="$(jq -r '.token // .access_token // empty' "${out}" 2>/dev/null || true)"
    rm -f "${out}"
    if [ "${code}" = 200 ] && [ -n "${token}" ]; then printf '200 %s\n' "${token}"; else printf '%s \n' "$([ "${code}" = 200 ] && echo 000 || echo "${code}")"; fi
}

# <method> <repo> <actions> <anonymous 0|1> <path under v2/<owner>/<repo>|absolute URL> <out> [curl args] -> status
registry_request() {
    local method="$1" repo="$2" actions="$3" anonymous="$4" path="$5" out="$6" line auth=() url
    shift 6
    line="$(registry_bearer "${repo}" "${actions}" "${anonymous}")"
    [ "${line%% *}" = 200 ] || { printf '%s' "${line%% *}"; return 0; }
    [ -z "${line#* }" ] || auth=(-H "Authorization: Bearer ${line#* }")
    case "${path}" in http://* | https://*) url="${path}" ;; *) url="${REGISTRY_URL}/v2/${REGISTRY_OWNER}/${repo}/${path}" ;; esac
    curl -sS --max-time 3600 -o "${out}" -w '%{http_code}' -X "${method}" "${auth[@]}" "$@" "${url}" 2>/dev/null || echo 000
}

registry_blob_put() { # <repo> <file> <digest>
    local repo="$1" file="$2" digest="$3" status out location
    status="$(registry_request HEAD "${repo}" pull,push 0 "blobs/${digest}" /dev/null -I)"
    [ "${status}" != 200 ] || return 0
    out="$(mktemp)"
    status="$(registry_request POST "${repo}" pull,push 0 "blobs/uploads/" "${out}" -D "${out}.h" -H 'Content-Length: 0')"
    location="$(tr -d '\r' <"${out}.h" 2>/dev/null | sed -n 's/^[Ll]ocation: //p' | head -n1)"
    rm -f "${out}.h"
    [ "${status}" = 202 ] && [ -n "${location}" ] ||
        { echo "error: starting an upload to ${REGISTRY_HOST}/${REGISTRY_OWNER}/${repo} answered HTTP ${status}: $(head -c 200 "${out}")" >&2; rm -f "${out}"; return 1; }
    case "${location}" in /*) location="${REGISTRY_URL}${location}" ;; esac
    case "${location}" in *\?*) location="${location}&digest=${digest}" ;; *) location="${location}?digest=${digest}" ;; esac
    status="$(registry_request PUT "${repo}" pull,push 0 "${location}" "${out}" -H 'Content-Type: application/octet-stream' -T "${file}")"
    [ "${status}" = 201 ] || { echo "error: uploading ${digest} to ${REGISTRY_HOST}/${REGISTRY_OWNER}/${repo} answered HTTP ${status}: $(head -c 200 "${out}")" >&2; rm -f "${out}"; return 1; }
    rm -f "${out}"
}

registry_publish() { # <repo> <tag> <artifact-type> <layers.tsv>
    local repo="$1" tag="$2" type="$3" layers="$4" work file media annotations digest status have
    work="$(mktemp -d)"
    printf '{}' >"${work}/config"
    registry_blob_put "${repo}" "${work}/config" "${REGISTRY_EMPTY_CONFIG}" || { rm -rf "${work}"; return 1; }
    : >"${work}/layers.json"
    while IFS=$'\t' read -r file media annotations; do
        [ -n "${file}" ] || continue
        digest="sha256:$(sha256sum "${file}" | cut -d' ' -f1)"
        registry_blob_put "${repo}" "${file}" "${digest}" || { rm -rf "${work}"; return 1; }
        jq -n --arg m "${media}" --arg d "${digest}" --argjson s "$(stat -c %s "${file}")" --argjson a "${annotations}" \
            '{mediaType: $m, digest: $d, size: $s, annotations: $a}' >>"${work}/layers.json"
    done <"${layers}"
    jq -cS -n --arg type "${type}" --arg cfg "${REGISTRY_EMPTY_CONFIG}" --slurpfile layers "${work}/layers.json" \
        '{schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: $type,
          config: {mediaType: "application/vnd.oci.empty.v1+json", digest: $cfg, size: 2}, layers: $layers}' | tr -d '\n' >"${work}/manifest.json"
    digest="sha256:$(sha256sum "${work}/manifest.json" | cut -d' ' -f1)"
    status="$(registry_request GET "${repo}" pull,push 0 "manifests/${tag}" "${work}/existing.json" -H "Accept: ${REGISTRY_MANIFEST_TYPE}")"
    case "${status}" in
    200)
        have="sha256:$(sha256sum "${work}/existing.json" | cut -d' ' -f1)"
        [ "${have}" = "${digest}" ] || {
            echo "error: ${REGISTRY_HOST}/${REGISTRY_OWNER}/${repo}:${tag} already holds ${have}, and this manifest is ${digest}; a published tag is never re-pointed" >&2
            rm -rf "${work}"; return 1; }
        ;;
    404)
        status="$(registry_request PUT "${repo}" pull,push 0 "manifests/${tag}" "${work}/put.out" -H "Content-Type: ${REGISTRY_MANIFEST_TYPE}" --data-binary "@${work}/manifest.json")"
        [ "${status}" = 201 ] || { echo "error: putting ${tag} to ${REGISTRY_HOST}/${REGISTRY_OWNER}/${repo} answered HTTP ${status}: $(head -c 200 "${work}/put.out")" >&2; rm -rf "${work}"; return 1; }
        ;;
    *) echo "error: reading ${REGISTRY_HOST}/${REGISTRY_OWNER}/${repo}:${tag} answered HTTP ${status}" >&2; rm -rf "${work}"; return 1 ;;
    esac
    rm -rf "${work}"
    printf '%s\n' "${digest}"
}

registry_public_manifest() { # <repo> <digest> <out> -> status
    registry_request GET "$1" pull 1 "manifests/$2" "$3" -H "Accept: ${REGISTRY_MANIFEST_TYPE}"
}

registry_public_blob() { # <repo> <digest> -> status
    registry_request HEAD "$1" pull 1 "blobs/$2" /dev/null -I
}
