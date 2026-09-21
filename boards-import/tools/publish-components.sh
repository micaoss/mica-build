#!/usr/bin/env bash
# Publish the release's board's components as OCI artifacts.
#
#   bash tools/publish-components.sh     the board of the release tag <board>.<YYYYMMDD-HHMM> HEAD carries
#
#   reads   _out/<board>/ and boards/<board>/ (tools/component.sh stages each component),
#           the board's latest published release (tools/reuse.sh)
#   writes  <registry>/mica-boards:<component>.<board>.<YYYYMMDD-HHMM> for every component of the board
#           (board, kernel, and uboot and firmware where it has them): one layer per file
#           (application/vnd.mica.board.<kind>, titled with its path; firmware/ as one firmware.tar),
#           artifactType application/vnd.mica.board[.<component>], annotated with the source,
#           mica.board, mica.arch, mica.component, mica.inputs and (board, kernel) mica.verity-cert-sha256;
#           the board rows of the release lock (tools/deb/registry.sh LOCK_ROWS)
#
# A component whose inputs hash (tools/inputs.sh) equals the mica.inputs of the
# same component in the board's latest release is reused: that manifest is put
# under this release's tag unchanged, the same digest, and nothing is staged or
# built for it. A tag holding another digest is refused. Every manifest and
# layer is read back anonymously before its row is written.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
# shellcheck disable=SC1091
. "${REPO_ROOT}/tools/deb/registry.sh"
die() { echo "publish-components.sh: error: $*" >&2; exit 1; }
for t in curl sha256sum git jq tar; do command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"; done

registry_load
registry_repo_name
registry_token --write
release_load
BOARD="${RELEASE_BOARD}"
ARCH="$(bash "${REPO_ROOT}/tools/boards.sh" arch "${BOARD}")"
ARTIFACT="$(oci_repo "${REPO_NAME}")"
VERITY="${VERITY_TRUST_CERT:-${REPO_ROOT}/meta/verity/signer.cert.pem}"
[ -f "${VERITY}" ] || die "${VERITY} does not exist; the verity certificate every component is annotated with"
CERT_SHA="$(sha256sum "${VERITY}" | cut -d' ' -f1)"
WORK="$(mktemp -d "${REPO_ROOT}/_out/.publish-components.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

kind_of() { case "$1" in board.env) echo env ;; evidence.json) echo evidence ;; manifests/*) echo manifest ;; kernel/*) echo kernel ;; uboot/* | uboot-package/*) echo uboot ;; trust/*) echo trust ;; *) echo file ;; esac; }

mkdir -p "${LOCK_ROWS}"
: >"${LOCK_ROWS}/board.tsv"
published=0 reused=0
for component in $(bash "${REPO_ROOT}/tools/component.sh" list "${BOARD}"); do
    tag="$(oci_tag "${component}" "${BOARD}" "${RELEASE_STAMP}")"
    inputs="$(bash "${REPO_ROOT}/tools/inputs.sh" "${BOARD}" "${component}")"
    previous="$(bash "${REPO_ROOT}/tools/reuse.sh" "${BOARD}" "${component}" "${inputs}" "${RELEASE_LABEL}")"
    if [ -n "${previous}" ]; then
        status="$(REGISTRY_TOKEN='' oci_manifest_get "${ARTIFACT}" "${previous}" "${WORK}/${component}.manifest.json")"
        [ "${status}" = 200 ] || die "the reused ${component} manifest ${previous} does not read (HTTP ${status})"
        line="$(oci_tag_manifest "${ARTIFACT}" "${tag}" "${WORK}/${component}.manifest.json")" || exit 1
        reused=$((reused + 1))
        echo "publish-components.sh: ${component}: inputs ${inputs:0:12} unchanged; ${OCI_HOST}/${ARTIFACT}:${tag} is the published ${previous}"
    else
        stage="${WORK}/${component}"
        VERITY_TRUST_CERT="${VERITY}" bash "${REPO_ROOT}/tools/component.sh" stage "${BOARD}" "${component}" "${stage}"
        # firmware/ as one reproducible tar: sorted, owned by root, epoch mtime.
        if [ -d "${stage}/firmware" ]; then
            (cd "${stage}" && find firmware -type f | LC_ALL=C sort | tar --owner=0 --group=0 --numeric-owner --mtime='@0' --no-recursion -cf firmware.tar -T -)
            rm -rf "${stage}/firmware"
        fi
        : >"${WORK}/${component}.layers.tsv"
        while IFS= read -r f; do
            printf '%s\t%s\t%s\n' "${stage}/${f}" "application/vnd.mica.board.$(kind_of "${f}")" "${f}" >>"${WORK}/${component}.layers.tsv"
        done < <(cd "${stage}" && find . -type f -printf '%P\n' | LC_ALL=C sort)
        artifact_annotations "${REPO_NAME}" "${RELEASE_COMMIT}" "${RELEASE_CREATED}" "${RELEASE_LABEL}" "${WORK}/${component}.source.json"
        # The verity certificate annotates what embeds or carries it (its sha256 is in their inputs).
        jq --arg board "${BOARD}" --arg arch "${ARCH}" --arg component "${component}" --arg inputs "${inputs}" --arg cert "${CERT_SHA}" \
            '. + {"mica.board": $board, "mica.arch": $arch, "mica.component": $component, "mica.inputs": $inputs}
             + (if $component == "board" or $component == "kernel" then {"mica.verity-cert-sha256": $cert} else {} end)' \
            "${WORK}/${component}.source.json" >"${WORK}/${component}.annotations.json"
        type=application/vnd.mica.board
        [ "${component}" = board ] || type="${type}.${component}"
        line="$(oci_publish "${ARTIFACT}" "${tag}" "${type}" "${WORK}/${component}.annotations.json" "${WORK}/${component}.layers.tsv")" || exit 1
        published=$((published + 1))
        echo "publish-components.sh: ${component}: $(wc -l <"${WORK}/${component}.layers.tsv") layers ${line%% *} as ${OCI_HOST}/${ARTIFACT}:${tag} (${line#* })"
    fi
    digest="${line#* }"
    # Read back with no credential: the tag resolves to this manifest, every layer to its bytes.
    oci_require_public "${ARTIFACT}" "${tag}" || exit 1
    status="$(REGISTRY_TOKEN='' oci_manifest_get "${ARTIFACT}" "${tag}" "${WORK}/${component}.back.json")"
    [ "${status}" = 200 ] && [ "$(oci_manifest_digest "${WORK}/${component}.back.json")" = "${digest}" ] ||
        die "${OCI_HOST}/${ARTIFACT}:${tag} does not read back anonymously as ${digest} (HTTP ${status})"
    [ "$(jq -r '.annotations["mica.inputs"]' "${WORK}/${component}.back.json")" = "${inputs}" ] &&
        [ "$(jq -r '.annotations["mica.board"] + " " + .annotations["mica.component"]' "${WORK}/${component}.back.json")" = "${BOARD} ${component}" ] ||
        die "${OCI_HOST}/${ARTIFACT}:${tag} is not the ${BOARD} ${component} with inputs ${inputs}"
    jq -r '.layers[] | .digest' "${WORK}/${component}.back.json" | while IFS= read -r d; do
        status="$(REGISTRY_TOKEN='' oci_blob_get "${ARTIFACT}" "${d}" "${WORK}/back.layer")"
        [ "${status}" = 200 ] && [ "sha256:$(sha256sum "${WORK}/back.layer" | cut -d' ' -f1)" = "${d}" ] ||
            die "a layer of ${OCI_HOST}/${ARTIFACT}:${tag} does not read back anonymously at ${d} (HTTP ${status})"
    done
    printf '%s\t%s\t%s\t%s\t%s\n' "${BOARD}" "${component}" "${ARCH}" "${tag}" "${digest}" >>"${LOCK_ROWS}/board.tsv"
done
echo "publish-components.sh: ${BOARD}: ${published} component(s) published, ${reused} reused"
