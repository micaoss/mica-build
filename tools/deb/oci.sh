#!/usr/bin/env bash
# An OCI registry client in bash: what tools/deb/publish.sh and
# tools/publish-components.sh need of the Distribution API, with curl, jq and
# sha256sum and nothing else on the host. Sourced by registry.sh.
#
# Every artifact is a manifest of layers in the package of the repository
# that publishes it (registry.env: MICA_REGISTRY=<host>/<owner>), pushed only
# by that repository's CI with its own token. What the artifact is sits in the
# tag -- <kind>[.<name>]*.<release>, where <release> is the UTC release
# YYYYMMDD-HHMM: pool.<arch>.<release>, board.<board>.<release> -- and its
# manifest's artifactType is application/vnd.mica.<kind>. Names are [a-z0-9-],
# so the '.' separator is unambiguous. A tag is never re-pointed; a pin names
# the digest, and a blob is content-addressed.
#
#   oci_load                       MICA_REGISTRY -> OCI_HOST, OCI_BASE, OCI_URL
#   oci_repo <repository>          "<owner>/<repository>": the publishing repository's package
#   oci_tag <name>... <release>    "<name>.<name>.<release>": what one artifact is, within it
#   oci_public <repo> <ref>        0 when an anonymous pull of <repo>:<ref> succeeds
#   oci_manifest_get <repo> <ref> <out>      -> status
#   oci_blob_get <repo> <digest> <out>       -> status
#   oci_blob_head <repo> <digest>            -> status
#   oci_publish <repo> <tag> <artifact-type> <annotations.json> <layers.tsv>
#                                            uploads the layers and the manifest unless the tag holds it; prints
#                                            pushed|present <digest>, and refuses a tag holding another digest
#   oci_tag_manifest <repo> <tag> <manifest.json>  the same for a manifest whose blobs the registry holds
#     layers.tsv: <file> TAB <media type> TAB <title> [TAB <inputs sha256>, the layer's mica.inputs]
#
# Authentication is the token challenge of the Distribution API: a 401 with
# WWW-Authenticate names the realm, the scope is asked for with the basic
# credentials (MICA_REGISTRY_USER, the token registry_token read), once per
# request; a refused token is the token endpoint's status (401/403), never a
# transport 000. A registry that never challenges (the test registry) is
# talked to as it is. The token is never printed.
[ -n "${BASH_VERSION:-}" ] || { echo "oci.sh: bash only" >&2; exit 1; }

OCI_EMPTY_CONFIG_DIGEST=sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
OCI_MANIFEST_TYPE=application/vnd.oci.image.manifest.v1+json

oci_load() { # from MICA_REGISTRY (and MICA_REGISTRY_PLAIN_HTTP=1 for a test registry)
    [[ "${MICA_REGISTRY}" =~ ^([A-Za-z0-9.-]+(:[0-9]+)?)/([A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9])$ ]] || {
        echo "error: MICA_REGISTRY='${MICA_REGISTRY}' is not <host>[:port]/<owner>" >&2; return 1; }
    OCI_HOST="${BASH_REMATCH[1]}"
    OCI_BASE="${BASH_REMATCH[3]}"
    if [ "${MICA_REGISTRY_PLAIN_HTTP:-0}" = 1 ]; then
        case "${OCI_HOST}" in 127.0.0.1* | localhost* | *.local | *:*) ;; *) [[ "${OCI_HOST}" =~ ^[a-z0-9-]+(:[0-9]+)?$ ]] || { echo "error: MICA_REGISTRY_PLAIN_HTTP=1 is for a local test registry, not ${OCI_HOST}" >&2; return 1; } ;; esac
        OCI_URL="http://${OCI_HOST}"
    else
        OCI_URL="https://${OCI_HOST}"
    fi
}

oci_repo() { # <repository>
    [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "error: '$1' is not a repository name a package can carry ([a-z0-9-])" >&2; return 1; }
    printf '%s/%s\n' "${OCI_BASE}" "$1"
}

oci_tag() { # <name>... <release>
    local IFS=.
    printf '%s\n' "$*"
}

# Whether <repo>:<ref> is readable with no credential at all: the anonymous
# token the realm issues, then the manifest. Every publisher runs it after a
# push, so an artifact that went out private is a red job naming the package
# to make public, not a consumer's 401 a week later.
oci_public() { # <repo> <ref>
    local repo="$1" ref="$2" challenge realm service t auth=()
    challenge="$(curl -sS --max-time 60 -o /dev/null -D - "${OCI_URL}/v2/${repo}/tags/list" 2>/dev/null | tr -d '\r' | grep -i '^www-authenticate: bearer' || true)"
    if [ -n "${challenge}" ]; then
        realm="$(printf '%s' "${challenge}" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
        service="$(printf '%s' "${challenge}" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
        t="$(curl -sS --max-time 60 --get --data-urlencode "service=${service}" --data-urlencode "scope=repository:${repo}:pull" "${realm}" 2>/dev/null | jq -r '.token // .access_token // empty' 2>/dev/null || true)"
        [ -z "${t}" ] || auth=(-H "Authorization: Bearer ${t}")
    fi
    [ "$(curl -sS --max-time 60 -o /dev/null -w '%{http_code}' "${auth[@]}" -H "Accept: ${OCI_MANIFEST_TYPE}" "${OCI_URL}/v2/${repo}/manifests/${ref}" 2>/dev/null || echo 000)" = 200 ]
}

# The refusal a publisher prints when its artifact is not public.
oci_require_public() { # <repo> <ref>
    oci_public "$1" "$2" && return 0
    echo "error: ${OCI_HOST}/$1:$2 was published and cannot be pulled anonymously: the package $1 is private. Every Mica OS package is public; set it once at https://github.com/orgs/${OCI_BASE}/packages/container/package/${1#"${OCI_BASE}"/} (Package settings, Danger Zone, Change visibility: Public) and rerun -- every later artifact of this repository is public from then on" >&2
    return 1
}

# A bearer for <repo> with <actions> (pull | pull,push), from the challenge
# the registry gives an unauthenticated request: "200 <bearer>" (the bearer
# empty when the registry does not challenge), or the token endpoint's own
# status and no bearer -- 401/403 when it refuses, 000 when it cannot be
# reached -- so a refusal reaches the caller as what it is.
oci_bearer() {
    local repo="$1" actions="$2" challenge realm service out code token cred=()
    challenge="$(curl -sS --max-time 60 -o /dev/null -D - "${OCI_URL}/v2/${repo}/tags/list" 2>/dev/null | tr -d '\r' | grep -i '^www-authenticate: bearer' || true)"
    [ -n "${challenge}" ] || { printf '200 \n'; return 0; }
    realm="$(printf '%s' "${challenge}" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
    service="$(printf '%s' "${challenge}" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
    [ -n "${realm}" ] || { echo "error: ${OCI_HOST} challenged with no realm: ${challenge}" >&2; printf '000 \n'; return 0; }
    # With a token, as that identity; without one, anonymously -- a public
    # artifact is read that way, and a private one is refused here.
    [ -z "${REGISTRY_TOKEN:-}" ] || cred=(-u "${MICA_REGISTRY_USER}:${REGISTRY_TOKEN}")
    out="$(mktemp)"
    code="$(curl -sS --max-time 60 -o "${out}" -w '%{http_code}' "${cred[@]}" \
        --get --data-urlencode "service=${service}" --data-urlencode "scope=repository:${repo}:${actions}" "${realm}" 2>/dev/null || echo 000)"
    token="$(jq -r '.token // .access_token // empty' "${out}" 2>/dev/null || true)"
    rm -f "${out}"
    if [ "${code}" = 200 ] && [ -n "${token}" ]; then printf '200 %s\n' "${token}"; return 0; fi
    [ "${code}" != 200 ] || code=000
    echo "error: ${realm} answered ${code} for repository:${repo}:${actions}, issuing no token${REGISTRY_TOKEN:+; ${MICA_RELEASE_TOKEN_VAR} does not grant it}${REGISTRY_TOKEN:- (anonymously: the package is private or does not exist)}" >&2
    printf '%s \n' "${code}"
}

# <method> <repo> <actions> <path-under-v2/repo> <out> [curl args] -> status
oci_request() {
    local method="$1" repo="$2" actions="$3" path="$4" out="$5"; shift 5
    local line bearer auth=()
    line="$(oci_bearer "${repo}" "${actions}")"
    [ "${line%% *}" = 200 ] || { printf '%s' "${line%% *}"; return 0; }
    bearer="${line#* }"
    [ -z "${bearer}" ] || auth=(-H "Authorization: Bearer ${bearer}")
    curl -sS --max-time 1800 -o "${out}" -w '%{http_code}' -X "${method}" "${auth[@]}" "$@" "${OCI_URL}/v2/${repo}/${path}" 2>/dev/null || echo 000
}

oci_manifest_get() { # <repo> <tag|digest> <out> -> status
    oci_request GET "$1" pull "manifests/$2" "$3" -H "Accept: ${OCI_MANIFEST_TYPE}"
}
oci_manifest_digest() { printf 'sha256:%s' "$(sha256sum "$1" | cut -d' ' -f1)"; }
oci_blob_get() { # <repo> <digest> <out> -> status; the storage redirect is followed
    oci_request GET "$1" pull "blobs/$2" "$3" -L
}
oci_blob_head() { # <repo> <digest> -> status
    oci_request HEAD "$1" pull "blobs/$2" /dev/null -I
}
# <repo> <file> <digest>: upload the blob unless the registry has it.
oci_blob_put() {
    local repo="$1" file="$2" digest="$3" status out location
    status="$(oci_blob_head "${repo}" "${digest}")"
    [ "${status}" != 200 ] || return 0
    out="$(mktemp)"
    status="$(oci_request POST "${repo}" pull,push "blobs/uploads/" "${out}" -D "${out}.h" -H 'Content-Length: 0')"
    [ "${status}" = 202 ] || { echo "error: starting an upload to ${OCI_HOST}/${repo} answered HTTP ${status}: $(head -c 200 "${out}")" >&2; rm -f "${out}" "${out}.h"; return 1; }
    location="$(awk 'tolower($1) == "location:" { sub(/\r$/, "", $2); print $2; exit }' "${out}.h")"
    rm -f "${out}.h"
    [ -n "${location}" ] || { echo "error: the upload to ${OCI_HOST}/${repo} came with no Location" >&2; rm -f "${out}"; return 1; }
    case "${location}" in /*) location="${OCI_URL}${location}" ;; esac
    case "${location}" in *\?*) location="${location}&digest=${digest}" ;; *) location="${location}?digest=${digest}" ;; esac
    local line bearer auth=()
    line="$(oci_bearer "${repo}" pull,push)"
    [ "${line%% *}" = 200 ] || { echo "error: uploading ${digest} to ${OCI_HOST}/${repo}: the token endpoint answered ${line%% *}" >&2; rm -f "${out}"; return 1; }
    bearer="${line#* }"
    [ -z "${bearer}" ] || auth=(-H "Authorization: Bearer ${bearer}")
    status="$(curl -sS --max-time 1800 -o "${out}" -w '%{http_code}' -X PUT "${auth[@]}" -H 'Content-Type: application/octet-stream' --data-binary "@${file}" "${location}" 2>/dev/null || echo 000)"
    [ "${status}" = 201 ] || { echo "error: uploading ${digest} to ${OCI_HOST}/${repo} answered HTTP ${status}: $(head -c 200 "${out}")" >&2; rm -f "${out}"; return 1; }
    rm -f "${out}"
}

# <repo> <tag> <artifact-type> <annotations.json> <layers.tsv> -> prints "pushed <digest>" or "present <digest>".
# Uploads the layers and builds the manifest; a tag that already exists must
# hold exactly that manifest's digest, and is otherwise refused, never
# re-pointed.
oci_publish() {
    local repo="$1" tag="$2" type="$3" annotations="$4" layers="$5"
    local work manifest file media title inputs digest size status have
    work="$(mktemp -d)"
    printf '{}' >"${work}/config"
    oci_blob_put "${repo}" "${work}/config" "${OCI_EMPTY_CONFIG_DIGEST}" || { rm -rf "${work}"; return 1; }
    : >"${work}/layers.json"
    while IFS=$'\t' read -r file media title inputs; do
        [ -n "${file}" ] || continue
        digest="sha256:$(sha256sum "${file}" | cut -d' ' -f1)"
        size="$(stat -c %s "${file}")"
        oci_blob_put "${repo}" "${file}" "${digest}" || { rm -rf "${work}"; return 1; }
        jq -n --arg m "${media}" --arg d "${digest}" --argjson s "${size}" --arg t "${title}" --arg i "${inputs}" \
            '{mediaType: $m, digest: $d, size: $s, annotations: ({"org.opencontainers.image.title": $t} + (if $i == "" then {} else {"mica.inputs": $i} end))}' >>"${work}/layers.json"
    done <"${layers}"
    jq -n --arg type "${type}" --arg cfg "${OCI_EMPTY_CONFIG_DIGEST}" --slurpfile layers "${work}/layers.json" --slurpfile ann "${annotations}" \
        '{schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: $type,
          config: {mediaType: "application/vnd.oci.empty.v1+json", digest: $cfg, size: 2},
          layers: $layers, annotations: $ann[0]}' >"${work}/manifest.json"
    oci_tag_manifest "${repo}" "${tag}" "${work}/manifest.json"
    local rc=$?
    rm -rf "${work}"
    return "${rc}"
}

# <repo> <tag> <manifest.json> -> prints "pushed <digest>" or "present <digest>":
# the manifest under <tag>, whose layers the registry already holds (a reused
# component's manifest is put under the new release's tag this way). A tag that
# already exists must hold exactly that digest, and is otherwise refused.
oci_tag_manifest() {
    local repo="$1" tag="$2" manifest="$3" digest status have out
    digest="$(oci_manifest_digest "${manifest}")"
    out="$(mktemp -d)"
    status="$(oci_manifest_get "${repo}" "${tag}" "${out}/existing.json")"
    case "${status}" in
    200)
        have="$(oci_manifest_digest "${out}/existing.json")"
        [ "${have}" = "${digest}" ] || {
            echo "error: ${OCI_HOST}/${repo}:${tag} already holds ${have}, and this build's manifest is ${digest}; a published tag is never re-pointed, and nothing was published" >&2
            rm -rf "${out}"; return 1
        }
        printf 'present %s\n' "${digest}"
        ;;
    404)
        status="$(oci_request PUT "${repo}" pull,push "manifests/${tag}" "${out}/put.out" -H "Content-Type: ${OCI_MANIFEST_TYPE}" --data-binary "@${manifest}")"
        [ "${status}" = 201 ] || { echo "error: putting the manifest ${tag} to ${OCI_HOST}/${repo} answered HTTP ${status}: $(head -c 200 "${out}/put.out")" >&2; rm -rf "${out}"; return 1; }
        printf 'pushed %s\n' "${digest}"
        ;;
    401 | 403) echo "error: the registry answered ${status} for ${OCI_HOST}/${repo}; ${MICA_RELEASE_TOKEN_VAR:-the token} does not grant access" >&2; rm -rf "${out}"; return 1 ;;
    000) echo "error: ${OCI_HOST} could not be reached (transport failure)" >&2; rm -rf "${out}"; return 1 ;;
    *) echo "error: reading ${OCI_HOST}/${repo}:${tag} answered HTTP ${status}" >&2; rm -rf "${out}"; return 1 ;;
    esac
    rm -rf "${out}"
}
