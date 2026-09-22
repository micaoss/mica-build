#!/usr/bin/env bash
# The board bundle every host-time reader consumes, assembled under _out/boards/<board>/.
#
#   bash tools/board-pool.sh --list               the boards of boards/boards.tsv, one per line
#   bash tools/board-pool.sh --fetch <board>      the board's bundle, assembled into _out/boards/<board>/
#   bash tools/board-pool.sh --fetch-all          the same for every board
#   bash tools/board-pool.sh --check <dir>        the bundle rules over an assembled bundle directory
#   bash tools/board-pool.sh --kernel-dir <board> <dev|prod>
#                                                 the kernel directory a product of that profile packs
#
#   reads   boards/<board>/ (tools/component.sh: the board and firmware components, staged from the tree)
#           _out/<board>/kernel, _out/<board>/uboot* (a local `make <board>-kernel`, `make <board>-firmware`,
#                                                     or a CI job's unpacked outputs: tools/ci-outputs.sh)
#           this repository's releases (tools/reuse.sh: a kernel or uboot component whose inputs hash equals
#                                       the one the latest release published, read by digest, src/cli.ts oci)
#           meta/verity/signer.cert.pem                              (the trust domain this assembly signs with)
#   writes  _out/boards/<board>/{board.env,evidence.json,images.tsv,manifests/,outputs.tsv,trust/,kernel/,firmware/,
#                                component-copyright,uboot/}
#           _out/cache/boards/<sha256> (the layer cache of reused components; a cached layer is hashed again)
#
# THE BOARD IS THE DIRECTORY boards/<board>/ OF THIS TREE. A board exists exactly when boards/boards.tsv
# lists it; its definition, manifests, flashing formats and firmware files are source of the commit being
# built, so the board and firmware components are staged from the tree. Its kernel and U-Boot are BUILT
# components: a product takes them from a local build of this checkout when one exists under _out/<board>/,
# and otherwise from the latest release of this repository that published them with the same inputs hash
# (tools/inputs.sh, mica.inputs), by digest. Neither present is a refusal naming `make <board>-kernel`,
# never a silent build: building a kernel is minutes to hours and is asked for by name.
#
# THE KERNEL DIRECTORY FOLLOWS THE BOOT BACKEND. A uboot-fit board forces its built-in command line, which
# carries the image profile, so its bundle carries kernel/dev/ and kernel/prod/, each a complete kernel
# directory, and no kernel/ files of its own; a systemd-boot board carries one kernel/ whose command line
# is the signed UKI's.
#
# THE BUNDLE SAYS WHAT IT HOLDS. boards/<board>/outputs.tsv (mica-boards board outputs v1: `package <package>`
# rows, the archives of its pool, and `file <component> <path>` rows, the files of each component at their
# assembled paths, outputs.tsv included) is what the assembled bundle must be, file for file
# (tools/boards.sh bundle-is).
#
# --fetch refuses a reused component built against another verity trust certificate than
# meta/verity/signer.cert.pem: a kernel that trusts another domain would boot a root this assembly did
# not sign; a local build embeds the certificate it was given (tools/inputs.sh hashes it).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
BOARDS_OUT="${MICA_BOARDS_OUT:-${REPO_ROOT}/_out/boards}"
LAYERS="${MICA_BOARD_CACHE:-${REPO_ROOT}/_out/cache/boards}"
TRUST_CERT="${MICA_VERITY_TRUST_CERT:-${REPO_ROOT}/meta/verity/signer.cert.pem}"

boards() { bash "${HERE}/boards.sh" list; }
# The kernel directories of a bundle, relative to it: kernel/dev and kernel/prod
# for a uboot-fit board, kernel for a systemd-boot board.
kernel_dirs() { # <bundle dir>
    case "$(sed -n 's/^BOOT_BACKEND=//p' "$1/board.env" 2>/dev/null)" in
    uboot-fit) printf '%s\n' kernel/dev kernel/prod ;;
    systemd-boot) printf '%s\n' kernel ;;
    *) return 1 ;;
    esac
}
# The bundle files every reader needs, and the trust check, over a staged directory.
check_bundle() { # <board> <staging> <what>
    local board="$1" staging="$2" what="$3" f d dirs
    for f in board.env images.tsv manifests/board.pkgs trust/verity-signer.cert.pem; do
        [ -e "${staging}/${f}" ] || { echo "error: ${what} carries no ${f}; it is not a board bundle this assembly can read (mica:docs/boards/contract.md section 3)" >&2; return 1; }
    done
    dirs="$(kernel_dirs "${staging}")" || { echo "error: ${what} names no BOOT_BACKEND of systemd-boot or uboot-fit in board.env" >&2; return 1; }
    for d in ${dirs}; do
        for f in config kernel.release modules.tar; do
            [ -f "${staging}/${d}/${f}" ] || { echo "error: ${what} carries no ${d}/${f}; its boot backend needs ${dirs//$'\n'/ and } as complete kernel directories" >&2; return 1; }
        done
    done
    case "${dirs}" in
    kernel)
        [ ! -e "${staging}/kernel/dev" ] && [ ! -e "${staging}/kernel/prod" ] ||
            { echo "error: ${what} is a systemd-boot bundle with profile kernel directories; its one kernel takes the profile from the signed UKI command line" >&2; return 1; } ;;
    *)
        [ ! -e "${staging}/kernel/config" ] ||
            { echo "error: ${what} is a uboot-fit bundle with a kernel/ of its own; its kernels are kernel/dev and kernel/prod only" >&2; return 1; } ;;
    esac
    cmp -s "${staging}/trust/verity-signer.cert.pem" "${TRUST_CERT}" || {
        echo "error: ${what} was built against a verity trust certificate that is not ${TRUST_CERT#"${REPO_ROOT}"/}. A kernel that trusts another domain would boot a root this assembly did not sign; build the board's kernel against this assembly's certificate" >&2
        return 1
    }
}
# A reused component out of the registry, by the digest tools/reuse.sh answered: every layer verified by
# digest at its title; firmware.tar unpacks into firmware/.
fetch_component() { # <board> <component> <digest> <staging>
    local board="$1" component="$2" digest="$3" staging="$4" ref manifest cert annotated n layer title
    ref="ghcr.io/micaoss/mica-build@${digest}"
    manifest="$(bash "${HERE}/../bin/bun.sh" src/cli.ts oci manifest "${ref}")" || { echo "error: the ${component} component ${ref} could not be read (see above)" >&2; return 1; }
    jq -e --arg t "application/vnd.mica.board.${component}" --arg b "${board}" --arg c "${component}" '
        .artifactType == $t and .annotations["mica.board"] == $b and .annotations["mica.component"] == $c
        and .annotations["mica.source-repo"] == "mica-build" and (.annotations["mica.source-commit"] | test("^[0-9a-f]{40}$"))
        and (.annotations["mica.inputs"] | test("^[0-9a-f]{64}$"))
        and (.layers | length > 0) and ([.layers[] | (.digest | test("^sha256:[0-9a-f]{64}$"))
            and (.annotations["org.opencontainers.image.title"] | test("^[A-Za-z0-9_+-][A-Za-z0-9._+-]*(/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*$"))] | all)
        and ([.layers[].annotations["org.opencontainers.image.title"]] | length == (unique | length))' "${manifest}" >/dev/null ||
        { echo "error: ${ref} is not the ${component} component of ${board} from mica-build, or a layer title is not a relative path" >&2; return 1; }
    cert="$(sha256sum "${TRUST_CERT}" | cut -d' ' -f1)"
    annotated="$(jq -r --arg c "${cert}" '.annotations["mica.verity-cert-sha256"] // $c' "${manifest}")"
    [ "${annotated}" = "${cert}" ] || {
        echo "error: ${ref} was built against a verity trust certificate that is not ${TRUST_CERT#"${REPO_ROOT}"/}. A kernel that trusts another domain would boot a root this assembly did not sign" >&2
        return 1
    }
    mkdir -p "${LAYERS}" "${staging}"
    n=0
    while IFS=$'\t' read -r layer title; do
        if [ ! -f "${LAYERS}/${layer}" ] || [ "$(sha256sum "${LAYERS}/${layer}" | cut -d' ' -f1)" != "${layer}" ]; then
            bash "${HERE}/../bin/bun.sh" src/cli.ts oci blob "${ref%%[:@]*}" "${layer}" "${LAYERS}/${layer}" || { echo "error: layer ${title} of ${ref} could not be read (see above)" >&2; return 1; }
        fi
        if [ "${component}" = firmware ] && [ "${title}" = firmware.tar ]; then
            tar -tvf "${LAYERS}/${layer}" | awk '$1 !~ /^[-d]/ { bad = 1 } END { exit bad }' ||
                { echo "error: firmware.tar of ${ref} holds a member that is neither a file nor a directory" >&2; return 1; }
            tar -tf "${LAYERS}/${layer}" | awk '$0 !~ /^firmware\/([A-Za-z0-9._+-]+\/?)*$/ || $0 ~ /(^|\/)\.\.?(\/|$)/ { bad = 1 } END { exit bad }' ||
                { echo "error: firmware.tar of ${ref} holds a member outside firmware/" >&2; return 1; }
            tar -xf "${LAYERS}/${layer}" -C "${staging}" --no-same-owner --no-same-permissions
        else
            mkdir -p "$(dirname "${staging}/${title}")"
            install -m 0644 "${LAYERS}/${layer}" "${staging}/${title}"
        fi
        n=$((n + 1))
    done < <(jq -r '.layers[] | [(.digest | ltrimstr("sha256:")), .annotations["org.opencontainers.image.title"]] | @tsv' "${manifest}")
    echo "board-pool.sh: ${board} ${component}: ${n} layer(s) of ${ref}, reused"
}
case "${1:-}" in
--list)
    boards
    ;;
--fetch)
    board="${2:-}"
    [ -n "${board}" ] || { echo "usage: bash tools/board-pool.sh --fetch <board>" >&2; exit 1; }
    bash "${HERE}/boards.sh" arch "${board}" >/dev/null || exit 1
    [ -f "${TRUST_CERT}" ] || { echo "error: ${TRUST_CERT} does not exist; the kernel's embedded trust certificate is compared against it (MICA_VERITY_TRUST_CERT overrides the path)" >&2; exit 1; }
    dest="${BOARDS_OUT}/${board}"
    # Staged beside the destination and moved into place only once every
    # check has passed; a refusal leaves nothing behind for a discovery to
    # mistake for a board.
    mkdir -p "${BOARDS_OUT}"
    staging="${BOARDS_OUT}/.${board}.fetch"
    rm -rf "${staging}"; mkdir -p "${staging}"
    trap 'rm -rf "${staging}"' EXIT
    for component in $(bash "${HERE}/component.sh" list "${board}"); do
        case "${component}" in
        board | firmware)
            VERITY_TRUST_CERT="${TRUST_CERT}" bash "${HERE}/component.sh" stage "${board}" "${component}" "${staging}/.${component}" || exit 1
            cp -a "${staging}/.${component}/." "${staging}/"; rm -rf "${staging}/.${component}"
            echo "board-pool.sh: ${board} ${component}: staged from boards/${board}/"
            ;;
        kernel | uboot)
            # A local build is staged as it is; its absence (component.sh names the make target) is the
            # one failure that means "look in the registry", any other refusal is this fetch's.
            if VERITY_TRUST_CERT="${TRUST_CERT}" bash "${HERE}/component.sh" stage "${board}" "${component}" "${staging}/.${component}" 2>"${staging}/.stage.err"; then
                cp -a "${staging}/.${component}/." "${staging}/"; rm -rf "${staging}/.${component}" "${staging}/.stage.err"
                echo "board-pool.sh: ${board} ${component}: staged from _out/${board}/ (a local build)"
            else
                grep -F "does not exist; run 'make" "${staging}/.stage.err" >/dev/null || { cat "${staging}/.stage.err" >&2; exit 1; }
                rm -rf "${staging}/.${component}" "${staging}/.stage.err"
                inputs="$(VERITY_TRUST_CERT="${TRUST_CERT}" bash "${HERE}/inputs.sh" "${board}" "${component}")" || exit 1
                digest="$(bash "${HERE}/reuse.sh" "${board}" "${component}" "${inputs}")" || exit 1
                [ -n "${digest}" ] || { echo "error: no ${component} of ${board} is built under _out/${board}/ and no release of this repository publishes one with the inputs ${inputs:0:12}; run make ${board}-$([ "${component}" = kernel ] && echo kernel || echo firmware)" >&2; exit 1; }
                fetch_component "${board}" "${component}" "${digest}" "${staging}" || exit 1
            fi
            ;;
        esac
    done
    check_bundle "${board}" "${staging}" "${board} (boards/${board})" || exit 1
    bash "${HERE}/boards.sh" bundle-is "${board}" "${staging}" || exit 1
    rm -rf "${dest}"; mv "${staging}" "${dest}"
    trap - EXIT
    ;;
--fetch-all)
    n=0
    while IFS= read -r board; do
        [ -n "${board}" ] || continue
        bash "$0" --fetch "${board}"; n=$((n + 1))
    done < <(boards)
    [ "${n}" -gt 0 ] || { echo "error: boards/boards.tsv lists no board, so nothing was fetched" >&2; exit 1; }
    # An assembled board the list no longer names is a stale directory a discovery would still find.
    for d in "${BOARDS_OUT}"/*/; do
        [ -d "${d}" ] || continue
        b="$(basename "${d}")"
        boards | grep -Fx -- "${b}" >/dev/null || { echo "board-pool.sh: removing _out/boards/${b}, which boards/boards.tsv does not list"; rm -rf "${d}"; }
    done
    echo "board-pool.sh: ${n} board(s) assembled into _out/boards/"
    ;;
--check)
    dir="${2:-}"
    [ -d "${dir}" ] || { echo "usage: bash tools/board-pool.sh --check <bundle dir>" >&2; exit 1; }
    board="$(sed -n 's/^LAYOUT_BOARD=//p' "${dir}/board.env" 2>/dev/null)"
    check_bundle "${board}" "${dir}" "${dir}" || exit 1
    echo "board-pool.sh: ${dir} is a readable bundle of ${board:-?} ($(kernel_dirs "${dir}" | tr '\n' ' '))"
    ;;
--kernel-dir)
    board="${2:-}"; profile="${3:-}"
    case "${profile}" in dev | prod) ;; *) echo "usage: bash tools/board-pool.sh --kernel-dir <board> <dev|prod>" >&2; exit 1 ;; esac
    [ -f "${BOARDS_OUT}/${board}/board.env" ] || { echo "error: ${board} is not assembled (make board-fetch BOARD=${board})" >&2; exit 1; }
    case "$(kernel_dirs "${BOARDS_OUT}/${board}")" in
    kernel) printf '%s\n' "${BOARDS_OUT}/${board}/kernel" ;;
    *) printf '%s\n' "${BOARDS_OUT}/${board}/kernel/${profile}" ;;
    esac
    ;;
*)
    echo "usage: bash tools/board-pool.sh --list | --fetch <board> | --fetch-all | --check <dir> | --kernel-dir <board> <dev|prod>" >&2
    exit 1
    ;;
esac
