#!/usr/bin/env bash
# What this tree takes out of the imported board bundles.
#
#   bash tools/board-pool.sh --list               the pinned boards, one per line
#   bash tools/board-pool.sh --fetch <board>      the board artifact of the release into _out/boards/<board>/
#   bash tools/board-pool.sh --fetch-all          the same for every pinned board
#   bash tools/board-pool.sh --source             the boards' source at the commit of their release into _out/src/mica-boards
#   bash tools/board-pool.sh --check <dir>        the bundle rules over an extracted bundle directory
#   bash tools/board-pool.sh --kernel-dir <board> <dev|prod>
#                                                 the fetched kernel directory a product of that profile packs
#
#   reads   locks/ (tools/locks.py rows board)                     (board <board> <arch> <reference>: the board artifact
#                                                                     by digest; the release row: its commit)
#           meta/verity/signer.cert.pem                              (the trust domain this assembly signs with)
#   writes  _out/boards/<board>/{board.env,evidence.json,manifests/,kernel/,firmware/,component-copyright,uboot/,trust/},
#           _out/cache/boards/<sha256> (the layer cache; a cached layer is hashed again)
#
# THE KERNEL DIRECTORY FOLLOWS THE BOOT BACKEND. A uboot-fit board forces its
# built-in command line, which carries the image profile, so its bundle carries
# kernel/dev/ and kernel/prod/, each a complete kernel directory, and no
# kernel/ files of its own; a systemd-boot board carries one kernel/ whose
# command line is the signed UKI's.
#
# THE BOARD ROWS ARE THE BOARD LIST. The boards live in one repository
# (mica-boards) that builds each kernel and U-Boot and packs them, with the
# board's board.env, evidence.json, package manifests, the support image's
# firmware and the verity trust certificate the kernel embeds, into its board
# artifact. This assembly never builds a kernel; a board exists here exactly
# when a board row of locks/ names it, and every host-time reader -- the
# composer, the resolver, the verifier, the labs -- reads it out of
# _out/boards/<board>/, which --fetch writes.
#
# THE BUNDLE IS THE RELEASE'S BOARD ARTIFACT, board.<board>.<release> (or
# .offline), read by digest (tools/oci.sh): an application/vnd.mica.board of
# this board, architecture and release commit, whose layers are the bundle's
# files by title and whose firmware/ travels as the one firmware.tar layer.
#
# THE BUNDLE SAYS WHAT IT HOLDS. Every board release carries its expected
# outputs as outputs.tsv (mica-boards board outputs v1: `package <package>` rows,
# the archives of its pool, and `bundle <path>` rows, the files of its bundle,
# outputs.tsv included). --fetch refuses a bundle whose files are not exactly
# its bundle rows, or a board input whose package rows for the board's
# architecture are not exactly its package rows.
#
# --fetch refuses a bundle whose embedded trust certificate is not
# meta/verity/signer.cert.pem: a kernel that trusts another domain would boot
# a root this assembly did not sign.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
BOARDS_OUT="${MICA_BOARDS_OUT:-${REPO_ROOT}/_out/boards}"
LAYERS="${MICA_BOARD_CACHE:-${REPO_ROOT}/_out/cache/boards}"
TRUST_CERT="${MICA_VERITY_TRUST_CERT:-${REPO_ROOT}/meta/verity/signer.cert.pem}"

# input (<repository>[.<scope>]), board, arch, reference per board row.
board_rows() {
    python3 "${HERE}/locks.py" rows board || { echo "error: locks/ could not be read (see above)" >&2; exit 1; }
}
pinned_boards() {
    board_rows | cut -f2 | sort -u
}
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
    for f in board.env manifests/board.pkgs trust/verity-signer.cert.pem; do
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
        echo "error: ${what} was built against a verity trust certificate that is not ${TRUST_CERT#"${REPO_ROOT}"/}. A kernel that trusts another domain would boot a root this assembly did not sign; build and publish the board's kernel against this assembly's certificate" >&2
        return 1
    }
}
# The bundle against its own outputs.tsv, and the board input's package rows against its package rows.
check_outputs() { # <input> <board> <arch> <staging> <what>
    local input="$1" board="$2" arch="$3" staging="$4" what="$5" outputs="$4/outputs.tsv" diff
    [ -f "${outputs}" ] && [ "$(head -n1 "${outputs}")" = "# mica-boards board outputs v1" ] ||
        { echo "error: ${what} carries no outputs.tsv in mica-boards board outputs v1, so nothing says what the bundle of ${board} holds" >&2; return 1; }
    awk -F'\t' '!/^#/ && !(NF == 2 && ($1 == "package" || $1 == "bundle")) { bad = 1 } END { exit bad }' "${outputs}" ||
        { echo "error: ${what} outputs.tsv holds a row that is neither package <package> nor bundle <path>" >&2; return 1; }
    diff="$(diff <(awk -F'\t' '$1 == "bundle" { print $2 }' "${outputs}" | LC_ALL=C sort) <(cd "${staging}" && find . -type f -printf '%P\n' | LC_ALL=C sort))" ||
        { echo "error: the files of ${what} are not the bundle rows of its outputs.tsv (< listed only, > present only):" >&2; printf '%s\n' "${diff}" >&2; return 1; }
    diff="$(diff <(awk -F'\t' '$1 == "package" { print $2 }' "${outputs}" | LC_ALL=C sort) \
        <(python3 "${HERE}/locks.py" rows package "${input}" | awk -F'\t' -v a="${arch}" '$3 == a { print $2 }' | LC_ALL=C sort))" ||
        { echo "error: the ${arch} package rows of locks/${input}.lock are not the package rows of the outputs.tsv of ${what} (< listed only, > pinned only):" >&2; printf '%s\n' "${diff}" >&2; return 1; }
}
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
case "${1:-}" in
--list)
    pinned_boards
    ;;
--fetch)
    board="${2:-}"
    [ -n "${board}" ] || { echo "usage: bash tools/board-pool.sh --fetch <board>" >&2; exit 1; }
    [ -f "${TRUST_CERT}" ] || { echo "error: ${TRUST_CERT} does not exist; the kernel's embedded trust certificate is compared against it (MICA_VERITY_TRUST_CERT overrides the path)" >&2; exit 1; }
    dest="${BOARDS_OUT}/${board}"
    # Staged beside the destination and moved into place only once every
    # check has passed; a refusal leaves nothing behind for a discovery to
    # mistake for a board.
    mkdir -p "${BOARDS_OUT}"
    staging="${BOARDS_OUT}/.${board}.fetch"
    rm -rf "${staging}"; mkdir -p "${staging}"
    trap 'rm -rf "${work}" "${staging}"' EXIT
    IFS=$'\t' read -r input _ arch ref < <(board_rows | awk -F'\t' -v b="${board}" '$2 == b') || true
    [ -n "${ref:-}" ] || { echo "error: no board row of locks/ names ${board}; a board IS its pinned bundle, and the pinned boards are: $(pinned_boards | tr '\n' ' ')" >&2; exit 1; }
    repository="${input%%.*}"
    commit="$(python3 "${HERE}/locks.py" release "${input}" | cut -f2)"
    manifest="$(bash "${HERE}/oci.sh" manifest "${ref}")" || { echo "error: the board artifact ${ref} could not be read (see above)" >&2; exit 1; }
    cert="$(sha256sum "${TRUST_CERT}" | cut -d' ' -f1)"
    jq -e --arg b "${board}" --arg a "${arch}" --arg r "${repository}" --arg c "${commit}" '
        .artifactType == "application/vnd.mica.board" and .annotations["mica.board"] == $b and .annotations["mica.arch"] == $a
        and .annotations["mica.source-repo"] == $r and .annotations["mica.source-commit"] == $c and .annotations["org.opencontainers.image.revision"] == $c
        and (.layers | length > 0) and ([.layers[] | (.mediaType | startswith("application/vnd.mica.board."))
            and (.digest | test("^sha256:[0-9a-f]{64}$"))
            and (.annotations["org.opencontainers.image.title"] | test("^[A-Za-z0-9_+-][A-Za-z0-9._+-]*(/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*$"))] | all)
        and ([.layers[].annotations["org.opencontainers.image.title"]] | length == (unique | length))' "${manifest}" >/dev/null ||
        { echo "error: ${ref} is not the board artifact of ${board} (${arch}) from ${repository} at ${commit}, or a layer title is not a relative path" >&2; exit 1; }
    [ "$(jq -r '.annotations["mica.verity-cert-sha256"]' "${manifest}")" = "${cert}" ] || {
        echo "error: ${ref} was built against a verity trust certificate that is not ${TRUST_CERT#"${REPO_ROOT}"/}. A kernel that trusts another domain would boot a root this assembly did not sign" >&2
        exit 1
    }
    # Every layer, verified by digest, at its title; firmware.tar unpacks into firmware/.
    mkdir -p "${LAYERS}"
    n=0
    while IFS=$'\t' read -r digest title; do
        layer="${LAYERS}/${digest}"
        if [ ! -f "${layer}" ] || [ "$(sha256sum "${layer}" | cut -d' ' -f1)" != "${digest}" ]; then
            bash "${HERE}/oci.sh" blob "${ref%%[:@]*}" "${digest}" "${layer}" || { echo "error: layer ${title} of ${ref} could not be read (see above)" >&2; exit 1; }
        fi
        if [ "${title}" = firmware.tar ]; then
            tar -tvf "${layer}" | awk '$1 !~ /^[-d]/ { bad = 1 } END { exit bad }' ||
                { echo "error: firmware.tar of ${ref} holds a member that is neither a file nor a directory" >&2; exit 1; }
            tar -tf "${layer}" | awk '$0 !~ /^firmware\/([A-Za-z0-9._+-]+\/?)*$/ || $0 ~ /(^|\/)\.\.?(\/|$)/ { bad = 1 } END { exit bad }' ||
                { echo "error: firmware.tar of ${ref} holds a member outside firmware/" >&2; exit 1; }
            tar -xf "${layer}" -C "${staging}" --no-same-owner --no-same-permissions
        else
            mkdir -p "$(dirname "${staging}/${title}")"
            install -m 0644 "${layer}" "${staging}/${title}"
        fi
        n=$((n + 1))
    done < <(jq -r '.layers[] | [(.digest | ltrimstr("sha256:")), .annotations["org.opencontainers.image.title"]] | @tsv' "${manifest}")
    echo "board-pool.sh: ${n} layer(s) of ${ref}"
    check_bundle "${board}" "${staging}" "${ref}" || exit 1
    check_outputs "${input}" "${board}" "${arch}" "${staging}" "${ref}" || exit 1
    rm -rf "${dest}"; mv "${staging}" "${dest}"
    ;;
--fetch-all)
    n=0
    while IFS= read -r board; do
        [ -n "${board}" ] || continue
        bash "$0" --fetch "${board}"; n=$((n + 1))
    done < <(pinned_boards)
    [ "${n}" -gt 0 ] || { echo "error: no board row in locks/, so nothing was fetched" >&2; exit 1; }
    # A fetched board nothing pins any more is a stale directory a discovery
    # would still find.
    for d in "${BOARDS_OUT}"/*/; do
        [ -d "${d}" ] || continue
        b="$(basename "${d}")"
        pinned_boards | grep -Fx -- "${b}" >/dev/null || { echo "board-pool.sh: removing _out/boards/${b}, which no board row names"; rm -rf "${d}"; }
    done
    echo "board-pool.sh: ${n} board(s) fetched into _out/boards/"
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
    [ -f "${BOARDS_OUT}/${board}/board.env" ] || { echo "error: ${board} is not fetched (make board-fetch BOARD=${board})" >&2; exit 1; }
    case "$(kernel_dirs "${BOARDS_OUT}/${board}")" in
    kernel) printf '%s\n' "${BOARDS_OUT}/${board}/kernel" ;;
    *) printf '%s\n' "${BOARDS_OUT}/${board}/kernel/${profile}" ;;
    esac
    ;;
--source)
    bash "${REPO_ROOT}/tools/source.sh" mica-boards
    # Every pinned board that boots a FIT: the labs compile its U-Boot file-boot sources.
    n=0
    while IFS= read -r board; do
        [ -n "${board}" ] || continue
        [ -f "${REPO_ROOT}/_out/boards/${board}/board.env" ] || { echo "error: ${board} is pinned and not fetched (make board-fetch BOARD=${board})" >&2; exit 1; }
        grep -qx 'BOOT_BACKEND=uboot-fit' "${REPO_ROOT}/_out/boards/${board}/board.env" || continue
        [ -d "${REPO_ROOT}/_out/src/mica-boards/boards/${board}/loader" ] || { echo "error: _out/src/mica-boards/boards/${board}/loader does not exist at the pinned commit; the labs and the FIT tests read the board's loader sources out of it" >&2; exit 1; }
        n=$((n + 1))
    done < <(pinned_boards)
    [ "${n}" -gt 0 ] || { echo "error: no pinned board boots a FIT, so no U-Boot source was checked out; the FIT labs would run over nothing" >&2; exit 1; }
    ;;
*)
    echo "usage: bash tools/board-pool.sh --list | --fetch <board> | --fetch-all | --source" >&2
    exit 1
    ;;
esac
